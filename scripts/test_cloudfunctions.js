// scripts/test_cloudfunctions.js —— 云函数逻辑测试（本地模拟云环境）
// 原理：用假的 wx-server-sdk（内存数据库）替换真 SDK，直接 require 云函数源码执行，
//       模拟用户 A / B / 陌生人 C 走完整业务流程，验证核心逻辑正确性。
const path = require('path');
const Module = require('module');
const fs = require('fs');

// ============================================================
// 1. 内存数据库 + mock wx-server-sdk
// ============================================================
const store = { users: [], reports: [], bills: [], bill_budgets: [], couple_settings: [], subscriptions: [], schedules: [], schedule_completions: [] };
let autoId = 0;
const nextId = () => 'id-' + (++autoId);
let currentOpenid = '';
let currentContextEnv = 'test-env';
let transactionTail = Promise.resolve();
let transactionFailAfterWrites = null;
let transactionReturnDirect = false;

function cloneValue(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach((key) => { out[key] = cloneValue(value[key]); });
    return out;
  }
  return value;
}

function snapshotStore() {
  return cloneValue(store);
}

function restoreStore(snapshot) {
  Object.keys(store).forEach((name) => {
    store[name].splice(0, store[name].length, ...snapshot[name]);
  });
}

// 深度相等判断（简化版）
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

// where 条件匹配（支持 _.in 和 db.RegExp）
function match(doc, query) {
  if (query && Array.isArray(query.__or)) return query.__or.some((condition) => match(doc, condition));
  return Object.keys(query).every((key) => {
    const cond = query[key];
    if (cond && cond.__in) return cond.__in.indexOf(doc[key]) >= 0;
    if (cond && cond.__regex) return new RegExp(cond.__regex).test(String(doc[key]));
    if (cond && cond.__range) {
      if (cond.__range.gte !== undefined && doc[key] < cond.__range.gte) return false;
      if (cond.__range.lte !== undefined && doc[key] > cond.__range.lte) return false;
      if (cond.__range.lt !== undefined && doc[key] >= cond.__range.lt) return false;
      return true;
    }
    return deepEqual(doc[key], cond);
  });
}

function makeCollection(name) {
  const coll = {
    aggregate() {
      let data = store[name].slice();
      const pipeline = {
        match(query) { data = data.filter((item) => match(item, query)); return pipeline; },
        group(spec) {
          const groups = new Map();
          const resolve = (doc, expression) => typeof expression === 'string' && expression[0] === '$' ? doc[expression.slice(1)] : expression;
          data.forEach((doc) => {
            const id = {};
            Object.keys(spec._id || {}).forEach((key) => { id[key] = resolve(doc, spec._id[key]); });
            const groupKey = JSON.stringify(id);
            if (!groups.has(groupKey)) groups.set(groupKey, { _id: id });
            const output = groups.get(groupKey);
            Object.keys(spec).filter((key) => key !== '_id').forEach((key) => {
              const accumulator = spec[key];
              if (accumulator && accumulator.__sum !== undefined) {
                output[key] = (output[key] || 0) + Number(resolve(doc, accumulator.__sum) || 0);
              }
            });
          });
          data = Array.from(groups.values());
          return pipeline;
        },
        // 真实 CloudBase 聚合 API 使用 list 返回结果，避免测试桩掩盖字段解析错误。
        async end() { return { list: data }; }
      };
      return pipeline;
    },
    where(query) {
      return {
        get: async () => ({ data: store[name].filter((d) => match(d, query)) }),
        orderBy(field, dir) {
          return {
            get: async () => {
              const sorted = store[name]
                .filter((d) => match(d, query))
                .slice()
                .sort((x, y) => (dir === 'desc' ? String(y[field]).localeCompare(String(x[field])) : String(x[field]).localeCompare(String(y[field]))));
              return { data: sorted };
            }
          };
        }
      };
    },
    add: async ({ data }) => {
      if (name === 'schedule_completions' && store[name].some((item) => item.scheduleId === data.scheduleId && item.occurrenceDate === data.occurrenceDate)) {
        const error = new Error('E11000 duplicate key error: scheduleId + occurrenceDate unique index');
        error.errCode = -502001;
        throw error;
      }
      const _id = nextId();
      store[name].push(Object.assign({ _id }, data));
      return { _id };
    },
    doc(id) {
      return {
        get: async () => {
          const found = store[name].find((d) => d._id === id);
          if (!found) { const e = new Error('not found'); e.errMsg = 'not found'; throw e; }
          return { data: found };
        },
        update: async ({ data }) => {
          const found = store[name].find((d) => d._id === id);
          if (!found) throw new Error('not found');
          Object.assign(found, data);
          return { stats: { updated: 1 } };
        },
        set: async ({ data }) => {
          const index = store[name].findIndex((d) => d._id === id);
          const record = Object.assign({ _id: id }, data);
          if (index >= 0) store[name][index] = record;
          else store[name].push(record);
          return { _id: id };
        },
        remove: async () => {
          const i = store[name].findIndex((d) => d._id === id);
          if (i < 0) throw new Error('not found');
          store[name].splice(i, 1);
          return { stats: { removed: 1 } };
        }
      };
    }
  };
  // orderBy 链式：支持 where().orderBy().orderBy().limit().get()
  const origWhere2 = coll.where.bind(coll);
  coll.where = function (query) {
    const sorts = [];
    let limited = Infinity;
    let skipped = 0;
    const chained = {
      orderBy(field, dir) { sorts.push({ field, dir }); return chained; },
      limit(n) { limited = n; return chained; },
      skip(n) { skipped = n; return chained; },
      async get() {
        const base = origWhere2(query);
        const res = await base.get();
        let data = res.data.slice();
        data.sort((x, y) => {
          for (const { field, dir } of sorts) {
            const compared = String(x[field]).localeCompare(String(y[field]));
            if (compared !== 0) return dir === 'desc' ? -compared : compared;
          }
          return 0;
        });
        return { data: data.slice(skipped, skipped + limited) };
      }
    };
    return chained;
  };
  return coll;
}

const TEMPLATE_NEW_REPORT = '9Olki2zL-v7V_Nse9V0MNTWq2d8nlTIo6aW1YV1Gmvg';
const TEMPLATE_APPROVE_RESULT = 'nrteb3ujtZBTIHtyABGP0FGP3Dy19PxRelc0IFFnaB8';

// 分别记录云函数间调用和真实微信订阅消息 API 尝试。
const cloudFunctionCalls = [];
const notifyCalls = [];
let notifyError = null;
let tempFileFailures = new Set();
let tempFileURLThrow = null;
const tempFileURLCalls = [];

const mockCloud = {
  DYNAMIC_CURRENT_ENV: Symbol('env'),
  init() {},
  getWXContext() { return { OPENID: currentOpenid, ENV: currentContextEnv }; },
  database() {
    const database = {
      collection: makeCollection,
      serverDate() { return new Date('2026-08-19T10:00:00+08:00'); },
      command: {
        or(conditions) { return { __or: conditions }; },
        in(arr) { return { __in: arr }; },
        gte(value) {
          return {
            __range: { gte: value },
            and(other) { return { __range: Object.assign({}, this.__range, other.__range) }; }
          };
        },
        lte(value) { return { __range: { lte: value } }; },
        lt(value) { return { __range: { lt: value } }; },
        aggregate: {
          sum(value) { return { __sum: value }; }
        },
        inc(n) { return { __inc: n }; }
      },
      RegExp({ regexp }) { return { __regex: regexp }; }
    };
    database.runTransaction = async (callback) => {
      const execute = async () => {
        const snapshot = snapshotStore();
        let writeCount = 0;
        const transaction = {
          collection(name) {
            const collection = makeCollection(name);
            const originalDoc = collection.doc.bind(collection);
            collection.doc = (id) => {
              const ref = originalDoc(id);
              const originalUpdate = ref.update;
              ref.update = async (arg) => {
                writeCount++;
                if (transactionFailAfterWrites !== null && writeCount > transactionFailAfterWrites) {
                  throw new Error('mock transaction write failure');
                }
                return originalUpdate(arg);
              };
              return ref;
            };
            return collection;
          }
        };
        try {
          const result = await callback(transaction);
          return transactionReturnDirect ? result : { result, errMsg: 'runTransaction:ok' };
        } catch (err) {
          restoreStore(snapshot);
          throw err;
        }
      };
      const result = transactionTail.then(execute, execute);
      transactionTail = result.catch(() => {});
      return result;
    };
    return database;
  },
  callFunction: async ({ name, data }) => {
    cloudFunctionCalls.push({ name, data });
    return { result: { success: true } };
  },
  getTempFileURL: async ({ fileList }) => {
    tempFileURLCalls.push(fileList.slice());
    if (tempFileURLThrow) throw tempFileURLThrow;
    return {
      fileList: fileList.map((fileID) => tempFileFailures.has(fileID)
        ? { fileID, status: -1, errMsg: 'mock file unavailable' }
        : { fileID, status: 0, tempFileURL: 'https://temp.example/' + encodeURIComponent(fileID) })
    };
  },
  openapi: {
    subscribeMessage: {
      send: async (options) => {
        notifyCalls.push(cloneValue(options));
        if (notifyError) throw notifyError;
        return { msgid: 'mock' };
      }
    }
  }
};

// 劫持 require('wx-server-sdk') → mockCloud
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'wx-server-sdk') return 'wx-server-sdk-mock';
  return origResolve.call(this, request, ...args);
};
require.cache['wx-server-sdk-mock'] = { id: 'wx-server-sdk-mock', filename: 'wx-server-sdk-mock', loaded: true, exports: mockCloud };

// 加载云函数（每次 require 真实源码）
const CF = (name) => require(path.join(__dirname, '..', 'cloudfunctions', name, 'index.js'));
// 以指定 openid 身份调用云函数
async function callAs(openid, name, event) {
  currentOpenid = openid;
  return CF(name).main(event || {});
}

// ============================================================
// 2. 测试用例
// ============================================================
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  [PASS] ' + msg); }
  else { fail++; console.log('  [FAIL] ' + msg); }
}

(async () => {
  const A = 'openid-AAA', B = 'openid-BBB', C = 'openid-CCC';
  const D = 'openid-DDD', E = 'openid-EEE', F = 'openid-FFF';
  const G = 'openid-GGG', H = 'openid-HHH';
  const I = 'openid-III', J = 'openid-JJJ';
  const K = 'openid-KKK';

  // ---------- 登录 ----------
  console.log('\n== 登录 ==');
  const loginA1 = await callAs(A, 'login');
  assert(loginA1.success && loginA1.userInfo.bindCode, 'A 首次登录：注册成功并生成邀请码');
  assert(!Object.prototype.hasOwnProperty.call(loginA1.userInfo, 'banners'), '新用户首次创建：不再初始化个人 banners 字段');
  const loginA2 = await callAs(A, 'login');
  assert(loginA2.userInfo._id === loginA1.userInfo._id, 'A 二次登录：不会重复注册');
  const loginB = await callAs(B, 'login');
  assert(loginB.success && loginB.userInfo.bindCode !== loginA1.userInfo.bindCode, 'B 登录：邀请码与 A 不同');
  await callAs(C, 'login');
  const loginD = await callAs(D, 'login');
  const loginE = await callAs(E, 'login');
  const loginF = await callAs(F, 'login');
  const loginG = await callAs(G, 'login');
  const loginH = await callAs(H, 'login');
  const loginI = await callAs(I, 'login');
  const loginJ = await callAs(J, 'login');

  // ---------- 绑定 ----------
  console.log('\n== 绑定 ==');
  const badFmt = await callAs(A, 'bind', { code: 'ab!' });
  assert(!badFmt.success, '邀请码格式非法：被拒绝');
  const selfBind = await callAs(A, 'bind', { code: loginA1.userInfo.bindCode });
  assert(!selfBind.success, '绑定自己：被拒绝');

  const concurrentBind = await Promise.all([
    callAs(D, 'bind', { code: loginF.userInfo.bindCode }),
    callAs(E, 'bind', { code: loginF.userInfo.bindCode })
  ]);
  const bindWinners = concurrentBind.filter((r) => r.success);
  const freshD = store.users.find((u) => u.openid === D);
  const freshE = store.users.find((u) => u.openid === E);
  const freshF = store.users.find((u) => u.openid === F);
  const winner = freshD.partnerId ? freshD : freshE;
  const loser = freshD.partnerId ? freshE : freshD;
  assert(bindWinners.length === 1, 'D、E 同时绑定 F：只有一个请求成功');
  assert(freshF.partnerId === winner._id && !loser.partnerId, '并发抢绑后关系保持唯一且双向一致');

  transactionFailAfterWrites = 1;
  const failedBind = await callAs(G, 'bind', { code: loginH.userInfo.bindCode });
  transactionFailAfterWrites = null;
  const freshG = store.users.find((u) => u.openid === G);
  const freshH = store.users.find((u) => u.openid === H);
  assert(!failedBind.success, '绑定事务第二次写入失败：请求返回失败');
  assert(!freshG.partnerId && !freshH.partnerId, '绑定事务中途失败：双方写入整体回滚');

  const okBind = await callAs(A, 'bind', { code: loginB.userInfo.bindCode });
  assert(okBind.success && okBind.partner.nickName, 'A 用 B 的邀请码：绑定成功');
  const usersA = store.users.find((u) => u.openid === A);
  const usersB = store.users.find((u) => u.openid === B);
  assert(usersA.partnerId === usersB._id && usersB.partnerId === usersA._id, '双向绑定：双方 partnerId 互指');
  const rebind = await callAs(A, 'bind', { code: 'XYZ234' });
  assert(!rebind.success, '已绑定再绑定：被拒绝');
  const bindIJ = await callAs(I, 'bind', { code: loginJ.userInfo.bindCode });
  assert(bindIJ.success, 'I 与 J 建立独立绑定关系，用于日程越权测试');

  // ---------- 情侣纪念日 ----------
  console.log('\n== 情侣纪念日 ==');
  const anniversaryUtil = require(path.join(__dirname, '..', 'utils', 'anniversary.js'));
  const unboundSettings = await callAs(C, 'getCoupleSettings');
  const unboundSave = await callAs(C, 'saveAnniversary', { anniversaryDate: '2025-08-26' });
  assert(!unboundSettings.success && unboundSettings.code === 'NOT_BOUND' && !unboundSave.success && unboundSave.code === 'NOT_BOUND',
    '纪念日：未绑定用户不能读取或保存');
  const emptySettings = await callAs(A, 'getCoupleSettings');
  assert(emptySettings.success && emptySettings.settings === null, '纪念日：未设置时返回 settings=null');
  const invalidAnniversary = await callAs(A, 'saveAnniversary', { anniversaryDate: '2026-02-30' });
  const futureAnniversary = await callAs(A, 'saveAnniversary', { anniversaryDate: '2999-01-01' });
  assert(!invalidAnniversary.success && invalidAnniversary.code === 'INVALID_DATE', '纪念日：不存在的日期被拒绝');
  assert(!futureAnniversary.success && futureAnniversary.code === 'FUTURE_DATE', '纪念日：未来日期被拒绝');
  const savedByA = await callAs(A, 'saveAnniversary', {
    anniversaryDate: '2025-08-26', pairKey: 'forged', memberIds: ['foreign'], updatedBy: 'foreign', openid: C
  });
  const readByB = await callAs(B, 'getCoupleSettings');
  const anniversaryRecord = store.couple_settings[0];
  const anniversaryMemberIds = [usersA._id, usersB._id].sort();
  const expectedPairKey = anniversaryMemberIds.join('|');
  const expectedSettingsId = require('crypto').createHash('sha256').update(expectedPairKey).digest('hex');
  assert(savedByA.success && readByB.success && readByB.settings.anniversaryDate === '2025-08-26',
    '纪念日：A 设置后 B 读取同一日期');
  assert(store.couple_settings.length === 1 && anniversaryRecord._id === expectedSettingsId &&
    anniversaryRecord.pairKey === expectedPairKey && deepEqual(anniversaryRecord.memberIds, anniversaryMemberIds),
    '纪念日：双方排序生成相同 pairKey，并使用 SHA-256 确定性文档 ID');
  assert(anniversaryRecord.updatedBy === usersA._id && anniversaryRecord.pairKey !== 'forged' &&
    !anniversaryRecord.memberIds.includes('foreign'), '纪念日：客户端伪造身份字段无效');
  const modifiedByB = await callAs(B, 'saveAnniversary', { anniversaryDate: '2024-02-29' });
  const readModifiedByA = await callAs(A, 'getCoupleSettings');
  assert(modifiedByB.success && readModifiedByA.settings.anniversaryDate === '2024-02-29' &&
    store.couple_settings.length === 1 && store.couple_settings[0].updatedBy === usersB._id,
    '纪念日：B 修改后 A 读取新日期且仍只有一个文档');
  assert(anniversaryUtil.anniversaryDays('2026-08-26', '2026-08-26') === 1 &&
    anniversaryUtil.anniversaryDays('2026-08-25', '2026-08-26') === 2,
    '纪念日天数：当天为第1天、昨天为第2天');
  assert(anniversaryUtil.anniversaryDays('2026-07-31', '2026-08-01') === 2 &&
    anniversaryUtil.anniversaryDays('2025-12-31', '2026-01-01') === 2 &&
    anniversaryUtil.anniversaryDays('2024-02-28', '2024-03-01') === 3,
    '纪念日天数：跨月、跨年和闰年按自然日正确计算');
  const originalPartnerOfB = usersB.partnerId;
  usersB.partnerId = '';
  const invalidBindingSettings = await callAs(A, 'getCoupleSettings');
  const invalidBindingAnniversarySave = await callAs(A, 'saveAnniversary', { anniversaryDate: '2025-08-26' });
  store.users.find((user) => user.openid === B).partnerId = originalPartnerOfB;
  assert(!invalidBindingSettings.success && invalidBindingSettings.code === 'BINDING_INVALID' &&
    !invalidBindingAnniversarySave.success && invalidBindingAnniversarySave.code === 'BINDING_INVALID',
    '纪念日：双向绑定异常时读取和保存均拒绝');

  // ---------- 通知安全边界 ----------
  console.log('\n== 通知安全边界 ==');
  const sendsBeforeDisabledCalls = notifyCalls.length;
  const disabledPlain = await callAs(C, 'sendNotify', {});
  const disabledReceiver = await callAs(C, 'sendNotify', { toOpenid: A, type: 'new_report' });
  const disabledPayload = await callAs(C, 'sendNotify', {
    toOpenid: B,
    type: 'approve_result',
    page: 'pages/fake/fake',
    data: { thing13: { value: '伪造消息' } }
  });
  assert(!disabledPlain.success && disabledPlain.msg === '接口已停用', '直接调用 sendNotify：明确拒绝');
  assert(!disabledReceiver.success && notifyCalls.length === sendsBeforeDisabledCalls,
    'sendNotify 伪造 toOpenid：不会调用微信 API');
  assert(!disabledPayload.success && notifyCalls.length === sendsBeforeDisabledCalls,
    'sendNotify 伪造 data/page：不会调用微信 API');

  for (let i = 0; i < 10; i++) {
    await callAs(A, 'subscribe', {
      type: 'approve_result', openid: B, tmplId: 'fake-template', count: 999
    });
  }
  const aSubscription = store.subscriptions.find((s) => s.openid === A && s.tmplId === TEMPLATE_APPROVE_RESULT);
  assert(store.subscriptions.filter((s) => s.openid === A && s.tmplId === TEMPLATE_APPROVE_RESULT).length === 1 &&
    aSubscription.count === 1, '重复调用 subscribe：估算 count 固定封顶为 1');
  assert(!store.subscriptions.some((s) => s.openid === B || s.tmplId === 'fake-template' || s.count === 999),
    'subscribe：忽略客户端伪造的 openid/tmplId/count');

  // ---------- 发起报备 ----------
  console.log('\n== 发起报备 ==');
  const noLoc = await callAs(A, 'createReport', { reason: 'x', returnTime: '今晚10点' });
  assert(!noLoc.success, '缺外出地点：被拒绝');
  usersA.nickName = '真实昵称A';
  store.subscriptions.push({
    _id: nextId(), openid: B, tmplId: TEMPLATE_NEW_REPORT, type: 'new_report', count: 0
  });
  const sendsBeforeReport = notifyCalls.length;
  const reportRes = await callAs(A, 'createReport', {
    location: '万达影城', companions: '闺蜜', returnTime: '22:00', reason: '看电影'
  });
  assert(reportRes.success, 'A 发起报备：成功');
  const report = store.reports.find((r) => r._id === reportRes.id);
  assert(report && report.status === 'pending' && report.partnerId === usersB._id, '报备落库：待审批 + 审批人指向 B');
  const ownReportImages = [1, 2, 3, 4].map((index) => `cloud://test-env/report-images/${A}/image-${index}.jpg`);
  const imageReportRes = await callAs(A, 'createReport', {
    location: '图片测试', returnTime: '22:00', reason: '图片凭证', images: ownReportImages
  });
  const imageReport = store.reports.find((item) => item._id === imageReportRes.id);
  assert(imageReportRes.success && deepEqual(imageReport.images, ownReportImages.slice(0, 3)),
    '报备图片：本人路径合法，超过3张沿用现有规则只保存前3张');
  const originalTcbEnv = process.env.TCB_ENV;
  delete process.env.TCB_ENV;
  currentContextEnv = undefined;
  const missingContextEnvReport = await callAs(A, 'createReport', {
    location: '环境兼容', returnTime: '22:00', reason: '上下文环境缺失', images: [ownReportImages[0]]
  });
  currentContextEnv = 'cloud://test-env/';
  const formattedContextEnvReport = await callAs(A, 'createReport', {
    location: '环境兼容', returnTime: '22:00', reason: '上下文环境格式不同', images: [ownReportImages[1]]
  });
  const flexibleEnvFileID = `cloud://test-env-2026/report-images/${A}/nested/real-upload.jpg`;
  const flexibleEnvReport = await callAs(A, 'createReport', {
    location: '格式兼容', returnTime: '22:00', reason: '多层对象路径', images: [flexibleEnvFileID]
  });
  currentContextEnv = 'test-env';
  process.env.TCB_ENV = 'cloud://test-env/';
  assert(missingContextEnvReport.success && formattedContextEnvReport.success && flexibleEnvReport.success &&
    store.reports.find((item) => item._id === flexibleEnvReport.id).images[0] === flexibleEnvFileID,
    '报备图片格式：context ENV 缺失/格式不同不误拒绝，环境含横杠数字和多层路径可解析');
  const ownerAttackC = await callAs(A, 'createReport', {
    location: '攻击测试', returnTime: '22:00', reason: '伪造C图片', images: [`cloud://test-env/report-images/${C}/c.jpg`]
  });
  const ownerAttackD = await callAs(A, 'createReport', {
    location: '攻击测试', returnTime: '22:00', reason: '伪造D图片', images: [`cloud://test-env/report-images/${D}/d.jpg`]
  });
  const environmentAttack = await callAs(A, 'createReport', {
    location: '攻击测试', returnTime: '22:00', reason: '跨环境图片', images: [`cloud://other-env/report-images/${A}/x.jpg`]
  });
  if (originalTcbEnv === undefined) delete process.env.TCB_ENV;
  else process.env.TCB_ENV = originalTcbEnv;
  const invalidImage = await callAs(A, 'createReport', {
    location: '攻击测试', returnTime: '22:00', reason: '非法图片', images: ['not-a-cloud-file-id']
  });
  const missingFileEnv = await callAs(A, 'createReport', {
    location: '攻击测试', returnTime: '22:00', reason: '缺少环境段', images: [`cloud:///report-images/${A}/x.jpg`]
  });
  const missingObjectPath = await callAs(A, 'createReport', {
    location: '攻击测试', returnTime: '22:00', reason: '缺少对象路径', images: ['cloud://test-env']
  });
  assert([ownerAttackC, ownerAttackD].every((item) => !item.success && item.code === 'FILE_OWNER_MISMATCH') &&
    !environmentAttack.success && environmentAttack.code === 'FILE_ENV_MISMATCH' &&
    [invalidImage, missingFileEnv, missingObjectPath].every((item) => !item.success && item.code === 'INVALID_FILE_ID'),
    '报备图片攻击：拒绝C/D路径、跨环境、缺协议、缺环境段和缺对象路径');

  const signedImageDetail = await callAs(B, 'getReportDetail', { reportId: imageReportRes.id });
  assert(signedImageDetail.success && signedImageDetail.report.imageUrls.length === 3 &&
    !signedImageDetail.report.imageLoadFailed && !Object.prototype.hasOwnProperty.call(signedImageDetail.report, 'images'),
    '报备详情：服务端在 pairKey 鉴权后签发临时URL，且不向页面暴露原始 fileID');
  tempFileURLThrow = new Error('mock temp URL service unavailable');
  const imageFailureDetail = await callAs(A, 'getReportDetail', { reportId: imageReportRes.id });
  tempFileURLThrow = null;
  assert(imageFailureDetail.success && deepEqual(imageFailureDetail.report.imageUrls, []) && imageFailureDetail.report.imageLoadFailed,
    '报备详情：图片临时URL签发失败时详情仍成功并降级为空图片列表');

  const historicalImage = 'cloud://test-env/legacy/report-old-path.jpg';
  const historicalImageReport = {
    _id: 'historical-image-report', openid: A, creatorId: usersA._id, creatorName: '历史用户',
    partnerId: usersB._id, pairKey: expectedPairKey, memberIds: [usersA._id, usersB._id].sort(),
    location: '历史地点', returnTime: '20:00', reason: '历史图片', images: [historicalImage], status: 'approved'
  };
  store.reports.push(historicalImageReport);
  const historicalImageDetail = await callAs(B, 'getReportDetail', { reportId: historicalImageReport._id });
  assert(historicalImageDetail.success && historicalImageDetail.report.imageUrls.length === 1 &&
    historicalImageDetail.report.imageUrls[0].includes(encodeURIComponent(historicalImage)),
    '报备历史图片：不按新上传路径反向校验，已鉴权旧 report 仍可签发URL');
  const newReportNotify = notifyCalls[sendsBeforeReport];
  assert(notifyCalls.length === sendsBeforeReport + 5, 'subscriptions.count=0：真实报备仍尝试调用微信 API');
  assert(newReportNotify.touser === B && newReportNotify.templateId === TEMPLATE_NEW_REPORT &&
    newReportNotify.page === 'pages/message/message', '新报备：接收人、模板和页面由真实伴侣关系固定生成');
  assert(newReportNotify.data.thing2.value === '真实昵称A要去万达影城' &&
    newReportNotify.data.thing25.value === report.reason, '新报备：通知内容来自真实用户和刚创建的 report');
  assert(!cloudFunctionCalls.some((c) => c.name === 'sendNotify'), 'createReport 不再调用通用 sendNotify');

  notifyError = Object.assign(new Error('user refuse to accept the msg'), { errCode: 43101 });
  const noAuthReport = await callAs(A, 'createReport', {
    location: '无授权测试', returnTime: '23:00', reason: '微信无额度'
  });
  notifyError = null;
  assert(noAuthReport.success && store.reports.some((r) => r._id === noAuthReport.id),
    '微信无有效授权：报备仍创建成功且不回滚');

  // ---------- 审批（含权限） ----------
  console.log('\n== 审批 ==');
  const stranger = await callAs(C, 'approveReport', { reportId: reportRes.id, action: 'approve' });
  assert(!stranger.success && stranger.msg === '无权操作此报备', '陌生人 C 审批：被拒绝（权限校验生效）');
  const rejectNoReason = await callAs(B, 'approveReport', { reportId: reportRes.id, action: 'reject' });
  assert(!rejectNoReason.success, '驳回不填理由：被拒绝');
  const rejectOk = await callAs(B, 'approveReport', { reportId: reportRes.id, action: 'reject', reason: '太晚了不安全' });
  assert(rejectOk.success, 'B 驳回（带理由）：成功');
  const rejectedReport = store.reports.find((r) => r._id === reportRes.id);
  assert(rejectedReport.status === 'rejected' && rejectedReport.rejectReason === '太晚了不安全', '驳回状态与理由落库正确');
  const approvalNotify = notifyCalls[notifyCalls.length - 1];
  assert(approvalNotify.touser === A && approvalNotify.templateId === TEMPLATE_APPROVE_RESULT &&
    approvalNotify.page === 'pages/record/record', '审批结果：接收人、模板和页面由真实 report 固定生成');
  assert(approvalNotify.data.phrase3.value.indexOf('已驳回') === 0 &&
    approvalNotify.data.thing17.value === '太晚了不安全', '审批结果：通知内容来自真实 report 和本次审批结果');
  const again = await callAs(B, 'approveReport', { reportId: reportRes.id, action: 'approve' });
  assert(!again.success && again.msg.indexOf('已被处理') >= 0, '同一报备重复审批：返回明确业务结果');

  const concurrentReport = await callAs(A, 'createReport', {
    location: '并发测试', returnTime: '21:00', reason: '验证原子审批'
  });
  const notifyBeforeConcurrentApprove = notifyCalls.filter((n) => n.templateId === TEMPLATE_APPROVE_RESULT).length;
  const concurrentApprove = await Promise.all([
    callAs(B, 'approveReport', { reportId: concurrentReport.id, action: 'approve' }),
    callAs(B, 'approveReport', { reportId: concurrentReport.id, action: 'reject', reason: '并发驳回' })
  ]);
  const notifyAfterConcurrentApprove = notifyCalls.filter((n) => n.templateId === TEMPLATE_APPROVE_RESULT).length;
  assert(concurrentApprove.filter((r) => r.success).length === 1, '两个并发审批请求：只有一个成功');
  assert(concurrentApprove.filter((r) => !r.success && r.msg.indexOf('已被处理') >= 0).length === 1,
    '并发审批失败方：返回已处理的业务结果');
  assert(notifyAfterConcurrentApprove - notifyBeforeConcurrentApprove === 1,
    '并发审批：只有真正更新状态的请求发送通知');

  const apiErrorReport = await callAs(A, 'createReport', {
    location: '审批通知异常', returnTime: '19:00', reason: '验证失败隔离'
  });
  notifyError = Object.assign(new Error('mock WeChat API unavailable'), { errCode: 50001 });
  const approveWithNotifyError = await callAs(B, 'approveReport', {
    reportId: apiErrorReport.id, action: 'approve'
  });
  notifyError = null;
  const approvedDespiteNotifyError = store.reports.find((r) => r._id === apiErrorReport.id);
  assert(approveWithNotifyError.success && approvedDespiteNotifyError.status === 'approved',
    '微信发送 API 报错：审批仍成功且事务结果不回滚');
  assert(!cloudFunctionCalls.some((c) => c.name === 'sendNotify'), 'approveReport 不再调用通用 sendNotify');

  const noAuthApprovalReport = await callAs(A, 'createReport', {
    location: '审批无授权', returnTime: '18:00', reason: '验证微信无额度'
  });
  notifyError = Object.assign(new Error('user refuse to accept the msg'), { errCode: 43101 });
  const noAuthApproval = await callAs(B, 'approveReport', {
    reportId: noAuthApprovalReport.id, action: 'reject', reason: '无授权也要完成审批'
  });
  notifyError = null;
  assert(noAuthApproval.success &&
    store.reports.find((r) => r._id === noAuthApprovalReport.id).status === 'rejected',
    '微信无有效授权：审批仍成功且不回滚');
  assert(store.subscriptions.find((s) => s.openid === A && s.tmplId === TEMPLATE_APPROVE_RESULT).count === 0,
    '微信明确返回无有效授权：本地非可信估算值修正为 0');

  const directTxReport = await callAs(A, 'createReport', {
    location: '真实事务返回形态', returnTime: '18:30', reason: '事务结果不带 result 包装'
  });
  transactionReturnDirect = true;
  const directTxApproval = await callAs(B, 'approveReport', { reportId: directTxReport.id, action: 'approve' });
  transactionReturnDirect = false;
  assert(directTxApproval.success && store.reports.find((r) => r._id === directTxReport.id).status === 'approved',
    '审批事务：不依赖 runTransaction 的 result 包装，提交后稳定返回 success=true');

  const transactionFailureReport = await callAs(A, 'createReport', {
    location: '事务失败测试', returnTime: '18:45', reason: '事务失败不能误报成功'
  });
  transactionFailAfterWrites = 0;
  const transactionFailureApproval = await callAs(B, 'approveReport', { reportId: transactionFailureReport.id, action: 'approve' });
  transactionFailAfterWrites = null;
  assert(!transactionFailureApproval.success && transactionFailureApproval.code === 'TRANSACTION_FAILED' &&
    store.reports.find((r) => r._id === transactionFailureReport.id).status === 'pending',
    '审批事务：真正提交失败返回 success=false 且状态保持 pending');

  const approveCloudSource = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'approveReport', 'index.js'), 'utf8');
  const detailJs = fs.readFileSync(path.join(__dirname, '..', 'pages', 'detail', 'detail.js'), 'utf8');
  const detailWxml = fs.readFileSync(path.join(__dirname, '..', 'pages', 'detail', 'detail.wxml'), 'utf8');
  assert(!detailJs.includes('wx.cloud.getTempFileURL') && detailJs.includes('this.data.report.imageUrls') &&
    detailWxml.includes('report.imageUrls'),
    '报备图片前端：完全移除客户端临时URL转换，只使用服务端签发的 imageUrls');
  assert(approveCloudSource.includes('let committedReport = null') &&
    !approveCloudSource.includes('txRes.result') &&
    approveCloudSource.indexOf('[ApproveReport][TRANSACTION_SUCCESS]') < approveCloudSource.indexOf('await notifyCreator') &&
    approveCloudSource.indexOf('[ApproveReport][NOTIFY_FAILED]') < approveCloudSource.indexOf('[ApproveReport][RETURN_SUCCESS]'),
    '审批服务端：事务快照、通知和成功返回使用独立错误边界');
  assert(detailJs.includes("name: 'getReportDetail'") && detailJs.includes('async reconcileApproval(action)') &&
    detailJs.includes("report.status === targetStatus") && detailJs.includes("decision: 'conflict'") &&
    detailJs.includes("report.status === 'pending'") && detailJs.includes('审批状态未确认，请稍后刷新'),
    '审批前端：异常响应按目标状态对账，并区分成功、冲突和无法确认');
  assert((/reconcileApproval\(action\)[\s\S]*name: 'approveReport'/).test(detailJs) === false &&
    (detailJs.match(/name: 'approveReport'/g) || []).length === 1,
    '审批前端：对账只读取详情，不重复调用 approveReport');
  assert(detailJs.includes('if (this.data.approving || !this.data.canApprove) return;') &&
    detailWxml.includes('disabled="{{approving}}"') && detailJs.includes('canApprove: false'),
    '审批按钮：提交及对账期间锁定，确认非 pending 后不可再次提交');

  // 再走一条批准流程
  const r2 = await callAs(B, 'createReport', { location: '公司团建', returnTime: '20:00', reason: '聚餐' });
  const approveOk = await callAs(A, 'approveReport', { reportId: r2.id, action: 'approve' });
  const report2 = store.reports.find((x) => x._id === r2.id);
  assert(approveOk.success && report2.status === 'approved', 'B 发报备、A 批准：反向流程成功');

  // ---------- 情侣日程 V1 ----------
  console.log('\n== 情侣日程 V1 ==');
  const scheduleUserA = () => store.users.find((user) => user.openid === A);
  const scheduleUserB = () => store.users.find((user) => user.openid === B);
  const scheduleUserI = () => store.users.find((user) => user.openid === I);

  const unboundSchedules = await callAs(C, 'getSchedules', { year: 2026, month: 8 });
  assert(!unboundSchedules.success && unboundSchedules.code === 'NOT_BOUND', '日程：未绑定用户无法查询');
  const unboundScheduleCalls = await Promise.all([
    callAs(C, 'getScheduleDetail', { id: 'unknown' }),
    callAs(C, 'saveSchedule', { type: 'schedule', title: '测试', date: '2026-08-24' }),
    callAs(C, 'toggleSchedule', { id: 'unknown', completed: true }),
    callAs(C, 'deleteSchedule', { id: 'unknown' })
  ]);
  assert(unboundScheduleCalls.every((result) => !result.success && result.code === 'NOT_BOUND'),
    '日程：未绑定用户调用全部日程接口均统一返回 NOT_BOUND');

  const invalidType = await callAs(A, 'saveSchedule', { type: 'event', title: '非法类型', date: '2026-08-24' });
  const emptyTitle = await callAs(A, 'saveSchedule', { type: 'schedule', title: '   ', date: '2026-08-24' });
  const invalidDate = await callAs(A, 'saveSchedule', { type: 'schedule', title: '非法日期', date: '2026-13-01' });
  const impossibleDate = await callAs(A, 'saveSchedule', { type: 'schedule', title: '不存在日期', date: '2026-02-30' });
  const invalidTime = await callAs(A, 'saveSchedule', { type: 'schedule', title: '非法时间', date: '2026-08-24', startTime: '24:00' });
  const invalidRange = await callAs(A, 'saveSchedule', { type: 'schedule', title: '时间倒置', date: '2026-08-24', startTime: '12:00', endTime: '11:59' });
  assert(!invalidType.success && invalidType.code === 'INVALID_TYPE', '日程：非法 type 被拒绝');
  assert(!emptyTitle.success && emptyTitle.code === 'INVALID_TITLE', '日程：空 title 被拒绝');
  assert(!invalidDate.success && invalidDate.code === 'INVALID_DATE', '日程：非法月份日期被拒绝');
  assert(!impossibleDate.success && impossibleDate.code === 'INVALID_DATE', '日程：2026-02-30 被严格拒绝');
  assert(!invalidTime.success && invalidTime.code === 'INVALID_TIME', '日程：非法时间被拒绝');
  assert(!invalidRange.success && invalidRange.code === 'INVALID_TIME_RANGE', '日程：endTime 早于 startTime 被拒绝');

  const scheduleCreated = await callAs(A, 'saveSchedule', {
    type: 'schedule', title: '一起吃晚饭', date: '2026-08-24', startTime: '19:00', endTime: '20:00', note: '餐厅见',
    creatorId: scheduleUserI()._id, partnerId: scheduleUserI().partnerId, openid: I, completed: true
  });
  const todoCreated = await callAs(B, 'saveSchedule', {
    type: 'todo', title: '买猫粮', date: '2026-08-24', startTime: '09:00', note: ''
  });
  const checkinCreated = await callAs(B, 'saveSchedule', {
    type: 'checkin', title: '今日运动', date: '2026-08-25', startTime: '', endTime: '', note: ''
  });
  const septemberCreated = await callAs(A, 'saveSchedule', {
    type: 'schedule', title: '九月事项', date: '2026-09-01', startTime: '08:00'
  });
  assert(scheduleCreated.success && scheduleCreated.schedule.type === 'schedule' && !scheduleCreated.schedule.completed,
    '日程：正常新建 schedule，完成状态固定为 false');
  assert(todoCreated.success && todoCreated.schedule.type === 'todo' && !todoCreated.schedule.completed, '日程：正常新建 todo');
  assert(checkinCreated.success && checkinCreated.schedule.type === 'checkin' && !checkinCreated.schedule.completed, '日程：正常新建 checkin');
  assert(scheduleCreated.schedule.creatorId === scheduleUserA()._id && scheduleCreated.schedule.creatorName === scheduleUserA().nickName &&
    !Object.prototype.hasOwnProperty.call(scheduleCreated.schedule, 'openid') && !Object.prototype.hasOwnProperty.call(scheduleCreated.schedule, 'partnerId'),
    '日程：客户端伪造 creatorId/partnerId/openid 无效且不落库');

  const foreignSchedule = {
    _id: nextId(), creatorId: scheduleUserI()._id, creatorName: 'I', type: 'todo', title: '另一对的事项',
    date: '2026-08-24', startTime: '10:00', endTime: '', note: '', completed: false,
    completedBy: '', completedByName: '', completedAt: null, createdAt: new Date('2026-08-20T00:00:00Z'),
    updatedAt: new Date('2026-08-20T00:00:00Z'), updatedBy: scheduleUserI()._id,
    pairKey: [scheduleUserI()._id, scheduleUserI().partnerId].sort().join('|'),
    memberIds: [scheduleUserI()._id, scheduleUserI().partnerId].sort()
  };
  store.schedules.push(foreignSchedule);

  const augustSchedules = await callAs(A, 'getSchedules', { year: 2026, month: 8, userId: scheduleUserI()._id, partnerId: scheduleUserI().partnerId });
  assert(augustSchedules.success && augustSchedules.list.some((item) => item._id === scheduleCreated.id) &&
    augustSchedules.list.some((item) => item._id === todoCreated.id) && augustSchedules.list.some((item) => item._id === checkinCreated.id),
    '日程：正常查询当前双方日程');
  assert(!augustSchedules.list.some((item) => item._id === foreignSchedule._id), '日程：伪造 userId/partnerId 也无法查询第三方日程');
  assert(!augustSchedules.list.some((item) => item._id === septemberCreated.id), '日程：月查询只返回当月事项');
  const sortedKeys = augustSchedules.list.map((item) => `${item.date}|${item.startTime}|${item.createdAt.toISOString()}`);
  assert(deepEqual(sortedKeys, sortedKeys.slice().sort()), '日程：月查询按 date/startTime/createdAt 升序');

  const ownDetail = await callAs(B, 'getScheduleDetail', { id: scheduleCreated.id });
  const foreignDetail = await callAs(A, 'getScheduleDetail', { id: foreignSchedule._id });
  assert(ownDetail.success && ownDetail.schedule._id === scheduleCreated.id, '日程详情：伴侣可查看对方创建的事项');
  assert(!foreignDetail.success && foreignDetail.code === 'ACCESS_DENIED', '日程详情：第三方事项按 pairKey 拒绝访问');

  const editedByPartner = await callAs(A, 'saveSchedule', {
    id: todoCreated.id, type: 'todo', title: '买猫粮和猫砂', date: '2026-08-24', startTime: '09:00',
    creatorId: scheduleUserA()._id, completed: true
  });
  const todoAfterEdit = store.schedules.find((item) => item._id === todoCreated.id);
  assert(editedByPartner.success && todoAfterEdit.title === '买猫粮和猫砂' && todoAfterEdit.updatedBy === scheduleUserA()._id,
    '日程编辑：双方都可以编辑');
  assert(todoAfterEdit.creatorId === scheduleUserB()._id && !todoAfterEdit.completed,
    '日程编辑：不能篡改 creatorId，也不能直接篡改 completed');
  const foreignEdit = await callAs(I, 'saveSchedule', {
    id: scheduleCreated.id, type: 'schedule', title: '越权编辑', date: '2026-08-24'
  });
  assert(!foreignEdit.success && foreignEdit.code === 'ACCESS_DENIED', '日程编辑：另一对绑定用户不能编辑');

  const scheduleToggle = await callAs(B, 'toggleSchedule', { id: scheduleCreated.id, completed: true });
  assert(scheduleToggle.success && scheduleToggle.schedule.completed && scheduleToggle.schedule.completedBy === scheduleUserB()._id,
    '日程状态：普通 schedule 可以完成且完成者由服务端生成');
  const editedCompletedSchedule = await callAs(A, 'saveSchedule', {
    id: scheduleCreated.id, type: 'schedule', title: '一起吃晚饭（已改）', date: '2026-08-24', startTime: '19:00', endTime: '20:00'
  });
  assert(editedCompletedSchedule.success && editedCompletedSchedule.schedule.completed && editedCompletedSchedule.schedule.completedBy === scheduleUserB()._id,
    '日程编辑：普通 schedule 编辑内容时保留服务端完成状态');
  const scheduleCancel = await callAs(A, 'toggleSchedule', { id: scheduleCreated.id, completed: false });
  assert(scheduleCancel.success && !scheduleCancel.schedule.completed && scheduleCancel.schedule.completedBy === '',
    '日程状态：普通 schedule 可以取消完成');
  const todoComplete = await callAs(A, 'toggleSchedule', { id: todoCreated.id, completed: true, completedBy: scheduleUserI()._id });
  assert(todoComplete.success && todoComplete.schedule.completed && todoComplete.schedule.completedBy === scheduleUserA()._id,
    '日程状态：todo 正常完成，完成者由服务端确定');
  const checkinComplete = await callAs(A, 'toggleSchedule', { id: checkinCreated.id, completed: true });
  assert(checkinComplete.success && checkinComplete.schedule.completedBy === scheduleUserA()._id && checkinComplete.schedule.completedAt,
    '日程状态：checkin 正常完成并记录完成者和时间');
  const todoCancel = await callAs(B, 'toggleSchedule', { id: todoCreated.id, completed: false });
  assert(todoCancel.success && !todoCancel.schedule.completed && todoCancel.schedule.completedBy === '' &&
    todoCancel.schedule.completedByName === '' && todoCancel.schedule.completedAt === null,
    '日程状态：取消完成清空全部完成信息');

  const convertedToSchedule = await callAs(B, 'saveSchedule', {
    id: checkinCreated.id, type: 'schedule', title: '改为普通日程', date: '2026-08-25', startTime: '', endTime: '', note: ''
  });
  assert(convertedToSchedule.success && !convertedToSchedule.schedule.completed && convertedToSchedule.schedule.completedBy === '' &&
    convertedToSchedule.schedule.completedAt === null, '日程编辑：todo/checkin 改为 schedule 时重置完成信息');

  const deleteOwnTarget = await callAs(A, 'saveSchedule', { type: 'todo', title: 'A 删除自己的', date: '2026-08-26' });
  const deletePartnerTarget = await callAs(A, 'saveSchedule', { type: 'todo', title: '由 B 删除', date: '2026-08-26' });
  const foreignDelete = await callAs(I, 'deleteSchedule', { id: deletePartnerTarget.id });
  const ownDelete = await callAs(A, 'deleteSchedule', { id: deleteOwnTarget.id });
  const partnerDelete = await callAs(B, 'deleteSchedule', { id: deletePartnerTarget.id });
  assert(!foreignDelete.success && foreignDelete.code === 'ACCESS_DENIED', '日程删除：另一对绑定用户不能删除');
  assert(ownDelete.success && !store.schedules.some((item) => item._id === deleteOwnTarget.id), '日程删除：创建人可以删除');
  assert(partnerDelete.success && !store.schedules.some((item) => item._id === deletePartnerTarget.id), '日程删除：伴侣也可以删除');

  // ---------- 情侣日程 V2：归属、循环与实例完成 ----------
  console.log('\n== 情侣日程 V2 ==');
  const personalMine = await callAs(A, 'saveSchedule', {
    type: 'todo', title: '我的待办', date: '2026-09-01', ownerType: 'personal', ownerId: scheduleUserA()._id, repeatType: 'none'
  });
  const personalPartner = await callAs(A, 'saveSchedule', {
    type: 'todo', title: 'TA的待办', date: '2026-09-01', ownerType: 'personal', ownerId: scheduleUserB()._id, repeatType: 'none'
  });
  const coupleOwned = await callAs(A, 'saveSchedule', {
    type: 'schedule', title: '双人安排', date: '2026-09-01', ownerType: 'couple', ownerId: scheduleUserI()._id, repeatType: 'none'
  });
  const invalidOwner = await callAs(A, 'saveSchedule', {
    type: 'todo', title: '非法归属', date: '2026-09-01', ownerType: 'personal', ownerId: scheduleUserI()._id
  });
  assert(personalMine.success && personalMine.schedule.ownerId === scheduleUserA()._id, 'V2 归属：可以创建“我的” personal');
  assert(personalPartner.success && personalPartner.schedule.ownerId === scheduleUserB()._id, 'V2 归属：可以创建“TA” personal');
  assert(coupleOwned.success && coupleOwned.schedule.ownerType === 'couple' && coupleOwned.schedule.ownerId === null, 'V2 归属：couple 强制 ownerId=null');
  assert(!invalidOwner.success && invalidOwner.code === 'INVALID_OWNER_ID', 'V2 归属：第三方 ownerId 被拒绝');
  assert(personalMine.schedule.creatorId === scheduleUserA()._id, 'V2 归属：creatorId 仍由服务端生成');

  const legacySchedule = {
    _id: nextId(), creatorId: scheduleUserA()._id, creatorName: 'A', type: 'todo', title: 'V1 老事项', date: '2026-09-02',
    startTime: '07:00', endTime: '', note: '', completed: false, completedBy: '', completedByName: '', completedAt: null,
    createdAt: new Date('2026-08-01T00:00:00Z'), updatedAt: new Date('2026-08-01T00:00:00Z'), updatedBy: scheduleUserA()._id
  };
  store.schedules.push(legacySchedule);
  const legacyDetail = await callAs(B, 'getScheduleDetail', { id: legacySchedule._id });
  assert(!legacyDetail.success && legacyDetail.code === 'DATA_ISOLATION_ERROR', 'V2 正式隔离：无 pairKey 旧事项拒绝读取');

  const daily = await callAs(A, 'saveSchedule', {
    type: 'todo', title: '每日运动', ownerType: 'couple', repeatType: 'daily',
    repeatStartDate: '2026-08-30', repeatEndDate: '2026-09-02', date: '2099-01-01', repeatWeekdays: [1], repeatDay: 9
  });
  const weekly = await callAs(B, 'saveSchedule', {
    type: 'checkin', title: '每周训练', ownerType: 'personal', ownerId: scheduleUserA()._id, repeatType: 'weekly',
    repeatStartDate: '2026-09-01', repeatEndDate: '2026-09-10', repeatWeekdays: [4, 2, 2], repeatDay: 20
  });
  const monthly28 = await callAs(A, 'saveSchedule', { type: 'todo', title: '每月28', repeatType: 'monthly', repeatStartDate: '2026-01-01', repeatEndDate: '2026-12-31', repeatDay: 28 });
  const monthly29 = await callAs(A, 'saveSchedule', { type: 'todo', title: '每月29', repeatType: 'monthly', repeatStartDate: '2028-02-01', repeatEndDate: '2028-02-29', repeatDay: 29 });
  const monthly30 = await callAs(A, 'saveSchedule', { type: 'todo', title: '每月30', repeatType: 'monthly', repeatStartDate: '2026-09-01', repeatEndDate: '2026-10-31', repeatDay: 30 });
  const monthly31 = await callAs(A, 'saveSchedule', { type: 'todo', title: '每月31', repeatType: 'monthly', repeatStartDate: '2026-09-01', repeatEndDate: '2026-10-31', repeatDay: 31 });
  const expiredDaily = await callAs(A, 'saveSchedule', { type: 'todo', title: '已结束循环', repeatType: 'daily', repeatStartDate: '2026-08-01', repeatEndDate: '2026-08-31' });
  const invalidRepeatRange = await callAs(A, 'saveSchedule', { type: 'todo', title: '倒置范围', repeatType: 'daily', repeatStartDate: '2026-09-02', repeatEndDate: '2026-09-01' });
  assert(daily.success && daily.schedule.date === null && deepEqual(daily.schedule.repeatWeekdays, []) && daily.schedule.repeatDay === null, 'V2 循环：daily 严格清洗无关字段');
  assert(weekly.success && deepEqual(weekly.schedule.repeatWeekdays, [2, 4]) && weekly.schedule.repeatDay === null, 'V2 循环：weekly 星期去重并升序');
  assert(monthly28.success && monthly29.success && monthly30.success && monthly31.success, 'V2 循环：monthly 支持 28/29/30/31');
  assert(expiredDaily.success, '性能优化：可创建查询区间前已经结束的循环规则');
  assert(!invalidRepeatRange.success && invalidRepeatRange.code === 'INVALID_REPEAT_RANGE', 'V2 循环：start > end 被拒绝');

  const septemberV2 = await callAs(A, 'getSchedules', { year: 2026, month: 9 });
  const getSchedulesSource = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'getSchedules', 'index.js'), 'utf8');
  assert(getSchedulesSource.includes('repeatStartDate: _.lte(range.endDate)') &&
    getSchedulesSource.includes('repeatEndDate: _.gte(range.startDate)') &&
    getSchedulesSource.includes('if (rule.repeatEndDate < range.startDate) return'),
    '性能优化：循环查询在数据库层限制起止交集并保留服务端防御过滤');
  const dailyDates = septemberV2.list.filter((item) => item.scheduleId === daily.id).map((item) => item.occurrenceDate);
  const weeklyDates = septemberV2.list.filter((item) => item.scheduleId === weekly.id).map((item) => item.occurrenceDate);
  assert(!septemberV2.list.some((item) => item.scheduleId === expiredDaily.id), '性能优化：已结束循环规则不会生成查询区间内实例');
  assert(septemberV2.success && septemberV2.list.some((item) => item.scheduleId === personalMine.id) && dailyDates.join(',') === '2026-09-01,2026-09-02',
    'V2 查询：月查询混合普通事项和跨月 daily，并包含起止边界');
  assert(weeklyDates.join(',') === '2026-09-01,2026-09-03,2026-09-08,2026-09-10', 'V2 循环：weekly 多星期按 ISO 1=周一规则展开');
  assert(!septemberV2.list.some((item) => item.scheduleId === monthly31.id) && septemberV2.list.some((item) => item.scheduleId === monthly30.id && item.occurrenceDate === '2026-09-30'),
    'V2 循环：9 月有 30 日且不存在的 31 日被跳过');
  const octoberV2 = await callAs(A, 'getSchedules', { year: 2026, month: 10 });
  assert(octoberV2.list.some((item) => item.scheduleId === monthly31.id && item.occurrenceDate === '2026-10-31'), 'V2 循环：10 月 31 日正常产生实例');
  const feb28 = await callAs(A, 'getSchedules', { date: '2026-02-28' });
  const feb29 = await callAs(A, 'getSchedules', { date: '2028-02-29' });
  assert(feb28.list.some((item) => item.scheduleId === monthly28.id) && feb29.list.some((item) => item.scheduleId === monthly29.id), 'V2 循环：每月 28 日及闰年 29 日正确展开');
  const singleDay = await callAs(A, 'getSchedules', { date: '2026-09-01' });
  assert(singleDay.success && singleDay.list.every((item) => item.occurrenceDate === '2026-09-01') &&
    singleDay.list.every((item) => item.instanceKey === `${item.scheduleId}:${item.occurrenceDate}`), 'V2 查询：date 查询只返回单日且 instanceKey 正确');
  assert(singleDay.list.find((item) => item.scheduleId === personalMine.id).ownerLabel === '我的' &&
    singleDay.list.find((item) => item.scheduleId === personalPartner.id).ownerLabel === 'TA' &&
    singleDay.list.find((item) => item.scheduleId === coupleOwned.id).ownerLabel === '双人', 'V2 查询：三种 ownerLabel 相对当前用户计算');
  const occurrenceSortKeys = septemberV2.list.map((item) => `${item.occurrenceDate}|${item.startTime || '99:99'}|${item.scheduleId}`);
  assert(deepEqual(occurrenceSortKeys, occurrenceSortKeys.slice().sort()), 'V2 查询：实例按 occurrenceDate、时间稳定排序');

  const recurringTodoComplete = await callAs(A, 'toggleSchedule', { id: daily.id, occurrenceDate: '2026-09-01', completed: true, completedBy: scheduleUserI()._id });
  const dayOneAfterComplete = await callAs(B, 'getSchedules', { date: '2026-09-01' });
  const dayTwoAfterComplete = await callAs(B, 'getSchedules', { date: '2026-09-02' });
  assert(recurringTodoComplete.success && recurringTodoComplete.schedule.completedBy === scheduleUserA()._id &&
    dayOneAfterComplete.list.find((item) => item.scheduleId === daily.id).completed && !dayTwoAfterComplete.list.find((item) => item.scheduleId === daily.id).completed,
    'V2 完成：循环 todo 每个 occurrence 独立且 completedBy 由服务端生成');
  const recurringCheckinComplete = await callAs(B, 'toggleSchedule', { id: weekly.id, occurrenceDate: '2026-09-03', completed: true });
  assert(recurringCheckinComplete.success && recurringCheckinComplete.schedule.completed, 'V2 完成：循环 checkin 可独立完成');
  const invalidDailyOccurrence = await callAs(A, 'toggleSchedule', { id: daily.id, occurrenceDate: '2026-09-03', completed: true });
  const invalidWeeklyOccurrence = await callAs(A, 'toggleSchedule', { id: weekly.id, occurrenceDate: '2026-09-02', completed: true });
  const invalidMonthlyOccurrence = await callAs(A, 'toggleSchedule', { id: monthly30.id, occurrenceDate: '2026-09-29', completed: true });
  assert(!invalidDailyOccurrence.success && !invalidWeeklyOccurrence.success && !invalidMonthlyOccurrence.success &&
    [invalidDailyOccurrence, invalidWeeklyOccurrence, invalidMonthlyOccurrence].every((item) => item.code === 'INVALID_OCCURRENCE'),
    'V2 完成：范围外、weekly 非规则日、monthly 非规则日全部拒绝');
  const recurringSchedule = await callAs(A, 'saveSchedule', { type: 'schedule', title: '循环约会', repeatType: 'daily', repeatStartDate: '2026-09-01', repeatEndDate: '2026-09-02' });
  const recurringScheduleToggle = await callAs(A, 'toggleSchedule', { id: recurringSchedule.id, occurrenceDate: '2026-09-01', completed: true });
  const recurringScheduleDay1 = await callAs(B, 'getSchedules', { date: '2026-09-01' });
  const recurringScheduleDay2 = await callAs(B, 'getSchedules', { date: '2026-09-02' });
  assert(recurringScheduleToggle.success && recurringScheduleToggle.schedule.completed &&
    recurringScheduleDay1.list.find((item) => item.scheduleId === recurringSchedule.id).completed &&
    !recurringScheduleDay2.list.find((item) => item.scheduleId === recurringSchedule.id).completed,
    'V2 完成：循环 schedule 按 occurrence 独立完成，不影响下一实例');
  const cancelRecurring = await callAs(B, 'toggleSchedule', { id: daily.id, occurrenceDate: '2026-09-01', completed: false });
  assert(cancelRecurring.success && !store.schedule_completions.some((item) => item.scheduleId === daily.id && item.occurrenceDate === '2026-09-01'), 'V2 完成：取消完成删除 completion');

  const concurrentComplete = await Promise.all([
    callAs(A, 'toggleSchedule', { id: daily.id, occurrenceDate: '2026-09-02', completed: true }),
    callAs(B, 'toggleSchedule', { id: daily.id, occurrenceDate: '2026-09-02', completed: true })
  ]);
  assert(concurrentComplete.every((item) => item.success) && store.schedule_completions.filter((item) => item.scheduleId === daily.id && item.occurrenceDate === '2026-09-02').length === 1,
    'V2 并发：双方同时完成按唯一索引幂等成功');
  const concurrentCancel = await Promise.all([
    callAs(A, 'toggleSchedule', { id: daily.id, occurrenceDate: '2026-09-02', completed: false }),
    callAs(B, 'toggleSchedule', { id: daily.id, occurrenceDate: '2026-09-02', completed: false })
  ]);
  assert(concurrentCancel.every((item) => item.success) && !store.schedule_completions.some((item) => item.scheduleId === daily.id && item.occurrenceDate === '2026-09-02'),
    'V2 并发：双方同时取消按幂等成功');

  await callAs(A, 'toggleSchedule', { id: weekly.id, occurrenceDate: '2026-09-03', completed: true });
  const foreignRecurringDelete = await callAs(I, 'deleteSchedule', { id: weekly.id });
  const recurringDelete = await callAs(A, 'deleteSchedule', { id: weekly.id });
  assert(!foreignRecurringDelete.success && foreignRecurringDelete.code === 'ACCESS_DENIED', 'V2 删除：第三方不能删除循环规则');
  assert(recurringDelete.success && !store.schedules.some((item) => item._id === weekly.id) && !store.schedule_completions.some((item) => item.scheduleId === weekly.id),
    'V2 删除：删除循环规则并清理 completion');

  const convertedRecurring = await callAs(A, 'saveSchedule', {
    id: personalMine.id, type: 'todo', title: '改成循环', repeatType: 'daily', repeatStartDate: '2026-09-01', repeatEndDate: '2026-09-03',
    ownerType: 'personal', ownerId: scheduleUserA()._id, completed: true
  });
  const convertedBack = await callAs(A, 'saveSchedule', {
    id: personalMine.id, type: 'todo', title: '改回单次', repeatType: 'none', date: '2026-09-04', ownerType: 'personal', ownerId: scheduleUserA()._id
  });
  assert(convertedRecurring.success && convertedRecurring.schedule.completed === false && convertedRecurring.schedule.date === null &&
    convertedBack.success && convertedBack.schedule.completed === false && convertedBack.schedule.repeatStartDate === null,
    'V2 编辑：非循环与循环互转时清空旧完成状态并规范化字段');

  // ---------- 日程页面结构与前端接入 ----------
  console.log('\n== 日程页面结构与前端接入 ==');
  const appConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));
  const schedulePagePath = 'pages/schedule/schedule';
  const scheduleEditPath = 'pages/schedule-edit/schedule-edit';
  const scheduleJs = fs.readFileSync(path.join(__dirname, '..', 'pages', 'schedule', 'schedule.js'), 'utf8');
  const scheduleWxml = fs.readFileSync(path.join(__dirname, '..', 'pages', 'schedule', 'schedule.wxml'), 'utf8');
  const scheduleWxss = fs.readFileSync(path.join(__dirname, '..', 'pages', 'schedule', 'schedule.wxss'), 'utf8');
  const scheduleJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pages', 'schedule', 'schedule.json'), 'utf8'));
  const editJs = fs.readFileSync(path.join(__dirname, '..', 'pages', 'schedule-edit', 'schedule-edit.js'), 'utf8');
  const editWxml = fs.readFileSync(path.join(__dirname, '..', 'pages', 'schedule-edit', 'schedule-edit.wxml'), 'utf8');
  const editJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pages', 'schedule-edit', 'schedule-edit.json'), 'utf8'));
  const calendarUtil = require(path.join(__dirname, '..', 'utils', 'calendar.js'));

  assert(appConfig.pages.includes(schedulePagePath) && appConfig.pages.includes(scheduleEditPath), '日程页面：主页和编辑页已在 app.json 注册');
  const expectedTabPages = ['pages/index/index', 'pages/bill/bill', 'pages/record/record', schedulePagePath, 'pages/mine/mine'];
  const expectedTabTexts = ['首页', '账单', '报备', '日程', '我的'];
  assert(appConfig.tabBar.list.length === 5 && deepEqual(appConfig.tabBar.list.map((item) => item.pagePath), expectedTabPages) &&
    deepEqual(appConfig.tabBar.list.map((item) => item.text), expectedTabTexts),
    'TabBar：正好 5 项，顺序为首页/账单/报备/日程/我的');
  const scheduleTab = appConfig.tabBar.list[3];
  assert(scheduleTab.pagePath === schedulePagePath &&
    fs.existsSync(path.join(__dirname, '..', scheduleTab.iconPath)) && fs.existsSync(path.join(__dirname, '..', scheduleTab.selectedIconPath)),
    'TabBar：日程普通及选中图标均指向真实文件');
  assert(expectedTabPages.slice(0, 3).concat(expectedTabPages[4]).every((pagePath) => appConfig.tabBar.list.some((item) => item.pagePath === pagePath)),
    'TabBar：原有首页、账单、报备、我的入口全部保留');
  const calendarCells = calendarUtil.buildMonth(2026, 8, { today: '2026-08-24', selectedDate: '2026-08-24', markedDates: { '2026-08-24': true } });
  assert(calendarCells.length === 42 && calendarCells.filter((item) => item.currentMonth).length === 31,
    '月历工具：固定生成 6×7 共 42 格并正确包含当月天数');
  const nextYearMonth = calendarUtil.shiftMonth(2026, 12, 1);
  const previousYearMonth = calendarUtil.shiftMonth(2027, 1, -1);
  assert(nextYearMonth.year === 2027 && nextYearMonth.month === 1 &&
    previousYearMonth.year === 2026 && previousYearMonth.month === 12,
    '日程月历滑动：继续复用 shiftMonth，跨年向前和向后切换正确');
  assert(scheduleWxml.includes('bindtap="onPreviousMonth"') && scheduleWxml.includes('bindtap="onNextMonth"'),
    '日程主页：存在上月和下月切换入口');
  assert(scheduleWxml.includes('<swiper class="calendar-swiper"') && scheduleWxml.includes('bindanimationfinish="onCalendarAnimationFinish"') &&
    scheduleWxml.includes('bindchange="onCalendarSwiperChange"'),
    '日程月历动画：月历区域使用原生 swiper 并在 animationfinish 确认切月');
  assert(scheduleJs.includes('calendarPanels: []') && scheduleJs.includes('[-1, 0, 1].map') &&
    scheduleWxml.includes('wx:for="{{calendarPanels}}"'),
    '日程月历动画：始终维护上一月、当前月、下一月三屏日期数据');
  assert(scheduleJs.includes('swiperCurrent: 1') && scheduleWxml.includes('current="{{swiperCurrent}}"'),
    '日程月历动画：swiper 默认停留在中间页');
  assert(!scheduleWxml.includes('bindtouchstart="onCalendarTouchStart"') && !scheduleWxml.includes('bindtouchmove="onCalendarTouchMove"') &&
    !scheduleJs.includes('onCalendarTouchEnd') && !scheduleJs.includes('_monthSwipeThresholdPx'),
    '日程月历动画：原 touch 瞬时切月逻辑已移除');
  assert(scheduleJs.includes('const targetIndex = Number(event.detail.current)') && scheduleJs.includes("targetIndex === 2 ? 1 : -1") &&
    scheduleJs.includes('swiperDuration: 0, swiperCurrent: 1'),
    '日程月历动画：animationfinish 后按方向切月并无动画复位中间页');
  assert(scheduleJs.includes('onPreviousMonth() {\n    this.animateToMonth(-1);') &&
    scheduleJs.includes('onNextMonth() {\n    this.animateToMonth(1);') &&
    scheduleJs.includes('swiperCurrent: offset > 0 ? 2 : 0'),
    '日程月历动画：左右箭头通过 swiper current 产生同样动画');
  assert((scheduleJs.match(/name: 'getSchedules'/g) || []).length === 1 &&
    !/buildCalendarPanels[\s\S]{0,900}getSchedules/.test(scheduleJs),
    '日程月历动画：三屏只生成日期，不预加载三个月日程');
  assert(scheduleJs.includes('this._swiperSettling') && scheduleJs.includes('swiperLocked') &&
    scheduleWxml.includes('disable-touch="{{swiperLocked}}"'),
    '日程月历动画：切换锁防止重复 animationfinish 和快速滑动月份错位');
  assert(scheduleJs.includes('const requestId = ++this._requestId') &&
    (scheduleJs.match(/requestId !== this\._requestId/g) || []).length >= 2,
    '日程月历滑动：快速连续切月继续由原 requestId 丢弃旧月份响应');
  assert(scheduleJs.includes("name: 'getSchedules'") && scheduleJs.includes('data: { year, month }'), '日程主页：已接入按月 getSchedules');
  assert(scheduleJs.includes('selectedList: this._dateMap[date] || []') && (scheduleJs.match(/name: 'getSchedules'/g) || []).length === 1,
    '日程主页：当前月点击日期从 dateMap 筛选，不重复请求 getSchedules');
  assert(/\.create-fab\s*\{[^}]*position:\s*fixed;/s.test(scheduleWxss) && scheduleWxss.includes('safe-area-inset-bottom'),
    '日程主页：新建按钮 fixed 定位并兼顾安全区');
  assert(/\.create-fab\s*\{[^}]*bottom:\s*calc\(120rpx\s*\+\s*env\(safe-area-inset-bottom\)\)/s.test(scheduleWxss) &&
    /\.schedule-page\s*\{[^}]*padding:[^;]*calc\(280rpx\s*\+\s*env\(safe-area-inset-bottom\)\)/s.test(scheduleWxss),
    'TabBar：新建按钮位于原生栏上方，页面底部留白不会遮挡最后一项');
  assert(scheduleJs.includes('schedule-edit/schedule-edit?date=${this.data.selectedDate}'), '日程主页：新建时传入当前选中日期');
  assert(editJs.includes("name: 'saveSchedule'") && editJs.includes("name: 'getScheduleDetail'") &&
    scheduleJs.includes("name: 'toggleSchedule'") && editJs.includes("name: 'deleteSchedule'"),
    '日程页面：5 个后端接口均完成前端接入');
  assert(scheduleWxml.includes('schedule-complete-icon') && scheduleWxml.includes('todo-checkbox') &&
    scheduleWxml.includes('checkin-circle') && scheduleWxml.includes('catchtap="onToggle"'),
    '日程主页：schedule/todo/checkin 均提供区分明确的完成入口');
  assert(editJs.includes('wx.showModal') && editJs.includes('modalResult.confirm'), '日程编辑：删除前有二次确认');
  assert(scheduleJs.includes("result.code === 'NOT_BOUND'") && scheduleWxml.includes('请先绑定') === false &&
    scheduleWxml.includes('bindtap="onGoBind"'), '日程主页：NOT_BOUND 使用明确动态文案并提供去绑定入口');
  assert(!scheduleJs.includes('wx.cloud.database') && !editJs.includes('wx.cloud.database'), '日程页面：不直接访问云数据库');
  assert(!scheduleJs.includes('getOpenid') && !editJs.includes('getOpenid') && !editJs.includes('creatorId:'),
    '日程页面：不使用客户端 OPENID/creatorId 参与权限或保存');
  assert(!scheduleJson.usingComponents && !editJson.usingComponents && !/vant|weui|miniprogram_npm/.test(scheduleJs + editJs + scheduleWxml + editWxml),
    '日程页面：未引入第三方 UI 框架');

  // ---------- 日程 V2 页面与交互结构 ----------
  console.log('\n== 日程 V2 页面与交互结构 ==');
  assert(editJs.includes("label: '我的'") && editJs.includes("label: 'TA的'") && editJs.includes("label: '双人'") && editJs.includes("ownerChoice: 'couple'"),
    'V2 编辑页归属：三段选择齐全且默认双人');
  assert(editJs.includes("item.ownerType === 'personal'") && editJs.includes("let ownerChoice = 'couple'") &&
    editJs.includes("ownerChoice === 'mine' ? this._myId") && editJs.includes("ownerChoice === 'partner' ? this._partnerId"),
    'V2 编辑页归属：V1 默认双人，ownerId 只能由当前双方身份推导');
  assert(!editWxml.includes('bindinput="onOwner') && !editWxml.includes('name="ownerId"'),
    'V2 编辑页归属：没有任意 ownerId 输入入口');
  assert(['不重复', '每天', '每周', '每月'].every((text) => editJs.includes(`label: '${text}'`)) &&
    ['none', 'daily', 'weekly', 'monthly'].every((value) => editJs.includes(`value: '${value}'`)),
    'V2 编辑页重复：none/daily/weekly/monthly 选择完整');
  assert(editWxml.includes("repeatType === 'none'") && editWxml.includes('循环开始日期') && editWxml.includes('循环结束日期') &&
    editJs.includes('repeatEndDate: addDays(start, 30)'), 'V2 编辑页重复：普通日期与循环起止日期按类型展示并默认 30 天');
  assert(editWxml.includes('重复星期') && editWxml.includes('wx:for="{{weekdayOptions}}"') && editJs.includes('selected.sort((a, b) => a - b)') &&
    editJs.includes('请至少选择一个重复星期'), 'V2 weekly：支持星期多选、稳定排序及至少一天校验');
  assert(editJs.includes('isoWeekday(start)') && editJs.includes('dayOfMonth(start)'), 'V2 默认规则：weekly 使用开始日星期，monthly 使用开始日日号');
  assert(editWxml.includes('没有该日期的月份将自动跳过') && editJs.includes('repeatDay >= 29') && editJs.includes('repeatDay <= 31'),
    'V2 monthly：29/30/31 显示月份跳过提示');
  assert(editJs.includes("repeatWeekdays: [], weekdayOptions: markWeekdays([]), repeatDay: null") &&
    editJs.includes("repeatType, date: this.data.repeatStartDate || this.data.date"), 'V2 类型切换：清理无关字段并在循环转普通时恢复 date');
  assert(editWxml.includes('修改将影响整个重复事项，已有完成记录会保留') &&
    editJs.includes('item.repeatStartDate') && editJs.includes('item.repeatWeekdays') && editJs.includes('item.repeatDay'),
    'V2 编辑循环：完整回填规则并提示修改整条规则');
  assert(editWxml.includes('bindtap="onStopRepeat"') && editJs.includes('从今天起停止重复，历史记录会保留。') &&
    editJs.includes('该重复事项尚未产生历史记录，是否直接删除？') && editJs.includes('shanghaiDate(-1)'),
    'V2 停止重复：入口、上海昨天和无历史删除分支齐全');
  assert(editJs.includes('删除后，整个重复事项及其完成记录都将移除，无法恢复。'), 'V2 删除：循环规则使用明确删除确认文案');
  assert(scheduleJs.includes('item.occurrenceDate || item.date') && scheduleJs.includes('dateMap[item.occurrenceDate]') &&
    scheduleWxml.includes('wx:key="instanceKey"'), 'V2 日程主页：occurrenceDate 分组并使用 instanceKey 唯一渲染');
  assert(scheduleJs.includes('item.instanceKey === instanceKey') && scheduleJs.includes('data: { id, occurrenceDate, completed: !completed }') &&
    scheduleWxml.includes('data-occurrence-date="{{item.occurrenceDate}}"'), 'V2 toggle：携带 occurrenceDate 并按 instanceKey 精确更新本地实例');
  const scheduleToggleBody = scheduleJs.slice(scheduleJs.indexOf('async onToggle'), scheduleJs.indexOf('onRetry()'));
  assert(scheduleToggleBody.includes('this._dateMap[occurrenceDate]') && scheduleToggleBody.includes('selectedList[${selectedIndex}]') &&
    !scheduleToggleBody.includes('applyMonthList('), '性能优化：toggle 只同步当前 instanceKey 与选中日列表');
  assert(!scheduleToggleBody.includes('loadCurrentMonth(') && !scheduleToggleBody.includes('rebuildCalendar(') &&
    !scheduleToggleBody.includes('calendar.buildMonth'), '性能优化：toggle 不重新请求整月且不重建 42 格月历');
  assert(scheduleWxml.includes('owner-tag') && scheduleWxml.indexOf('owner-tag') < scheduleWxml.indexOf('type-tag') &&
    scheduleWxml.includes('{{item.ownerLabel}}'), 'V2 卡片：归属标签显示在事项类型之前');
  assert(scheduleWxml.includes('repeat-meta') && scheduleWxml.includes('{{item.repeatText}}重复'), 'V2 卡片：展示轻量循环标识');
  assert(!scheduleWxml.includes('□') && !scheduleWxml.includes('○') && !scheduleWxml.includes('✓'),
    'V2 图标：todo/checkin 不再使用字符方框、圆圈或勾号');
  assert(scheduleWxml.includes('todo-checkbox') && scheduleWxss.includes('.todo-checkbox') && scheduleWxss.includes('.css-checkmark'),
    'V2 图标：存在 WXSS checkbox 与 CSS 勾号');
  assert(scheduleWxml.includes('checkin-circle') && scheduleWxss.includes('.checkin-circle') && scheduleWxss.includes('.checkin-dot') &&
    scheduleWxss.includes('.toggle-button.checkin.checked'), 'V2 图标：存在圆形打卡按钮及完成状态');
  assert(scheduleWxml.includes('schedule-complete-icon') && scheduleWxss.includes('.schedule-complete-icon') &&
    scheduleWxss.includes('.toggle-button.schedule.checked'), 'V2 图标：schedule 存在独立日历完成按钮及实心状态');
  assert(scheduleWxss.includes('.todo-completed .item-title') && !scheduleWxss.includes('.completed .item-title { color: #9AA0A6; text-decoration: line-through;'),
    'V2 完成样式：只有 todo 使用删除线，checkin 保留完成者展示');

  // ---------- 首页聚合优化 ----------
  console.log('\n== 首页聚合优化 ==');
  const indexJs = fs.readFileSync(path.join(__dirname, '..', 'pages', 'index', 'index.js'), 'utf8');
  const indexWxml = fs.readFileSync(path.join(__dirname, '..', 'pages', 'index', 'index.wxml'), 'utf8');
  const indexWxss = fs.readFileSync(path.join(__dirname, '..', 'pages', 'index', 'index.wxss'), 'utf8');
  assert(indexWxml.includes('新建日程') && indexWxml.includes('bindtap="goScheduleCreate"') &&
    indexJs.includes('/pages/schedule-edit/schedule-edit?date=${this.shanghaiToday()}'), '首页快速入口：新建日程携带上海今天日期');
  assert(indexWxml.includes('发起报备') && indexJs.includes("url: '/pages/apply/apply'"), '首页快速入口：复用现有发起报备页');
  assert(indexWxml.includes('记一笔') && indexJs.includes("url: '/pages/bill-edit/bill-edit'"), '首页快速入口：复用现有记一笔页');
  assert(indexJs.includes("name: 'getSchedules'") && indexJs.includes('data: { date: this.shanghaiToday() }'), '首页今日安排：只调用 getSchedules({date})');
  assert(!/name:\s*['"]getSchedules['"][\s\S]{0,160}data:\s*\{\s*year\s*,\s*month/.test(indexJs), '首页今日安排：不查询整月日程');
  assert(indexJs.includes('list.slice(0, 5)') && indexWxml.includes('todayScheduleHasMore') && indexWxml.includes('查看全部 ›'),
    '首页今日安排：最多渲染 5 条，超出后显示查看全部');
  assert(indexWxml.includes('{{item.ownerLabel}}') && !indexWxml.includes('{{item.typeText}}'), '首页今日安排：保留归属并移除重复类型标签');
  assert(indexWxml.includes('catchtap="onTodayEdit"') && indexJs.includes("'/pages/schedule-edit/schedule-edit?id=' + id"),
    '首页今日安排：左滑编辑使用 scheduleId 进入现有编辑页');
  assert(indexJs.includes("data: { role: 'approver', status: 'pending', pageSize: 3 }") &&
    indexJs.includes("r.status === 'pending'") && indexJs.includes('.slice(0, 3)'), '首页待审批：服务端限定 approver/pending/3 条并保留客户端防御过滤');
  assert(!indexJs.includes('loadLatestReports') && !indexJs.includes('latestReports') &&
    !indexJs.includes("role: 'creator'") && !indexWxml.includes('最近报备'),
    '首页精简：最近报备请求、状态、方法和模块已完全删除');
  assert((indexJs.match(/name:\s*'getReports'/g) || []).length === 1,
    '首页性能：只保留待审批一路 getReports 请求');
  assert(indexWxml.includes('wx:if="{{bound && (pendingReports.length > 0 || pendingError)}}"') &&
    !indexWxml.includes('暂无待审批报备'),
    '首页待审批：成功且 pending=0 时整个模块隐藏，失败时保留轻量重试提示');
  assert(indexWxml.includes('bindtap="goDetail"') && indexJs.includes("'/pages/detail/detail?id=' + id"), '首页待审批：点击进入现有详情页');
  assert(indexJs.includes('todayScheduleError: true') && indexJs.includes('pendingError: true') &&
    indexWxml.includes('今日安排暂时加载失败') && indexWxml.includes('待审批暂时加载失败'), '首页模块失败：今日安排和待审批分别独立降级');
  assert(indexJs.includes('Promise.allSettled') && indexJs.includes('this.loadTodaySchedules()') &&
    indexJs.includes('this.loadPendingReports()') && indexJs.includes('this.loadCoupleSettings()'),
    '首页性能：今日日程、待审批和纪念日独立并行加载');
  assert(!/Promise\.allSettled\([\s\S]{0,220}loadLatestReports/.test(indexJs),
    '首页性能：常规聚合仅并行今日日程和待审批');
  assert(!indexJs.includes('userInfo.banners') && indexJs.includes('this.refreshBannerUrls()'), '首页 Banner：不读取 users.banners，仅通过受控云函数刷新关系级数据');
  assert(indexJs.includes('now - (this._lastUserRefreshAt || 0) > 30000') && !indexJs.includes("name: 'getBillStats'"),
    '首页性能：登录资料短缓存且移除首页月账单统计请求');
  assert(indexWxml.includes('banner-swiper') && indexJs.includes('refreshBannerUrls') && indexWxml.includes('onManageBanners'),
    '首页兼容：原 Banner 展示与管理功能保留');
  assert(!indexWxml.includes('空间') && !indexJs.includes('/pages/space/'), '首页范围：未新增空间入口');
  assert(!/vant|weui|miniprogram_npm/.test(indexJs + indexWxml) && indexWxss.includes('.quick-grid'),
    '首页视觉：不引入第三方 UI，快速入口使用轻量三列布局');
  assert(indexWxml.includes('catchtap="onTodayItemTap"') && indexWxml.includes('data-occurrence-date="{{item.occurrenceDate}}"') &&
    indexJs.includes("name: 'toggleSchedule'") && indexJs.includes('data: { id: scheduleId, occurrenceDate, completed: !completed }'),
    '首页今日安排：整卡点击携带 occurrenceDate 切换完成状态');
  assert(indexJs.includes('updateTodayInstance(instanceKey') && indexJs.includes("this._todayTogglingKeys.has(instanceKey)") &&
    !/onTodayItemTap[\s\S]{0,1800}this\.init\(/.test(indexJs), '首页今日安排：按 instanceKey 局部更新、单项锁定且不触发完整 init');
  assert(indexJs.includes("toggle today schedule failed") && indexJs.includes("util.toast((err && err.message) || '操作失败，请重试')"),
    '首页今日安排：toggle 失败解除单项状态并明确提示');
  assert(indexWxml.includes("swipedScheduleKey === item.instanceKey ? 'swiped' : ''") && indexWxml.includes('catchtap="onTodayItemTap"') &&
    !indexWxml.includes('today-toggle'), '首页今日安排：移除右侧完成按钮并由整卡切换完成状态');
  assert(indexWxml.includes('quick-icon-bubble') && indexWxml.includes('calendar-heart') && indexWxml.includes('clipboard-clip') &&
    indexWxml.includes('paper-plane') && indexWxml.includes('wallet-icon') && indexWxml.includes('wallet-coin') && indexWxss.includes('.cute-spark'),
    '首页快速入口：爱心日历、剪贴板纸飞机、钱包硬币均使用统一多层卡通 WXSS 图标');
  assert(!/https?:\/\//.test(indexWxml) && !indexWxml.includes('<image class="quick'), '首页快速入口：未增加网络图片或位图资源');
  assert(indexWxml.includes('bindtouchstart="onTodayTouchStart"') && indexWxml.includes('bindtouchmove="onTodayTouchMove"') &&
    indexWxml.includes('bindtouchend="onTodayTouchEnd"') && indexJs.includes('deltaX <= -50') && indexJs.includes('deltaX >= 40') &&
    indexJs.includes('Math.abs(deltaX) > Math.abs(deltaY)') && !indexJs.includes('_todayTouchMoved') && !indexJs.includes('_todaySwipeTriggered'),
    '首页今日安排：touchend 单独按方向和距离决定展开或右滑收起');
  assert(indexJs.includes('this._suppressTodayTapUntil = Date.now() + 300') &&
    indexJs.includes('Date.now() < (this._suppressTodayTapUntil || 0)') &&
    /onTodayItemTap[\s\S]{0,500}if \(openedKey\) this\.setData\(\{ swipedScheduleKey: '' \}\)[\s\S]{0,500}name: 'toggleSchedule'/.test(indexJs) &&
    !/onTodayItemTap[\s\S]{0,500}swipedScheduleKey:\s*instanceKey/.test(indexJs),
    '首页今日安排：普通 tap 只清空已有展开项并 toggle，绝不负责展开');
  assert(indexWxml.includes('catchtap="onTodayEdit"') && indexWxml.includes('catchtap="onTodayDelete"') &&
    indexJs.includes("name: 'deleteSchedule'") && indexJs.includes('这是重复事项，删除后整个重复事项及其完成记录都会被移除') &&
    !/onTodayDelete[\s\S]{0,1800}this\.init\(/.test(indexJs),
    '首页今日安排：编辑/删除阻止冒泡，重复规则明确确认且删除后不整页 init');
  assert(indexWxss.includes('.today-item.swiped') && indexJs.includes('swipedScheduleKey: info.instanceKey') &&
    (indexJs.match(/swipedScheduleKey:/g) || []).length >= 2 && !indexJs.includes('swiped: false') && !indexJs.includes('swiped: true'),
    '首页今日安排：只用一个 swipedScheduleKey 保证一次展开一项');
  assert(!indexWxml.includes('type-tag') && !indexWxss.includes('.type-tag') && !indexJs.includes('typeText:') &&
    indexJs.includes("nextCompleted ? '已打卡' : '待打卡'") && indexJs.includes("nextCompleted ? '已完成' : '待完成'"),
    '首页今日安排：日程/待办/打卡类型胶囊完全删除，状态文案保留');
  assert(!/\.today-item\.loading\s*\{[^}]*opacity/s.test(indexWxss) &&
    indexWxss.includes('.today-item.loading .today-main { opacity: .55; }') &&
    indexWxss.includes('.today-item {') && indexWxss.includes('background: #fff'),
    '首页今日安排：toggle 加载态不再降低整个前景层透明度，后方操作区不会透出');
  assert(indexWxml.indexOf('banner-wrap') < indexWxml.indexOf('quick-card') &&
    indexWxml.indexOf('banner-wrap') < indexWxml.indexOf('anniversary-display') &&
    indexWxml.indexOf('anniversary-display') < indexWxml.indexOf('quick-card') &&
    indexWxml.indexOf('quick-card') < indexWxml.indexOf('today-card') &&
    indexWxml.indexOf('today-card') < indexWxml.indexOf('pending-card') &&
    indexWxml.indexOf('pending-card') < indexWxml.indexOf('bound-bar'),
    '首页最终顺序：Banner、纪念日、快速入口、今日安排、待审批、绑定状态');
  const applyJs = fs.readFileSync(path.join(__dirname, '..', 'pages', 'apply', 'apply.js'), 'utf8');
  const applyWxml = fs.readFileSync(path.join(__dirname, '..', 'pages', 'apply', 'apply.wxml'), 'utf8');
  const dateUtil = require(path.join(__dirname, '..', 'utils', 'util.js'));
  assert(dateUtil.weekdayText('2026-08-24') === '周一' && dateUtil.weekdayText('2026-08-30') === '周日' &&
    dateUtil.weekdayText('2026-09-01') === '周二' && dateUtil.weekdayText('2027-01-01') === '周五' &&
    dateUtil.weekdayText('2028-02-29') === '周二',
    '报备日期：周一至周日、跨月、跨年和闰年星期计算正确');
  assert(!applyWxml.includes('mode="date"') && (applyWxml.match(/mode="multiSelector"/g) || []).length === 2 &&
    applyWxml.includes('bindcolumnchange="onStartDateColumnChange"') && applyWxml.includes('bindcolumnchange="onDateColumnChange"'),
    '报备日期：开始和结束日期均使用原生 multiSelector 联动选择器');
  assert(applyJs.includes('buildDayOptions(year, month)') && applyJs.includes('util.daysInMonth(year, month)') &&
    applyJs.includes('`${day}日 ${util.weekdayText(date)}`') && applyJs.includes('value[2] = Math.min(value[2], range[2].length - 1)'),
    '报备日期：年月变化重建带星期的实际天数，并自动修正越界日');
  assert(dateUtil.daysInMonth(2026, 2) === 28 && dateUtil.daysInMonth(2028, 2) === 29 &&
    dateUtil.daysInMonth(2026, 4) === 30 && dateUtil.daysInMonth(2026, 8) === 31,
    '报备日期：普通年、闰年、30天和31天月份天数正确');
  assert(applyWxml.includes('{{startDateText ||') && applyWxml.includes('{{dateText ||') &&
    applyJs.includes('util.formatDateWithWeek(date)') &&
    applyJs.includes('startTime: `${startDate} ${startTime}`') && applyJs.includes('returnTime: `${date} ${time}`'),
    '报备日期：页面结果显示星期，提交仍使用原 YYYY-MM-DD 与时间协议');
  const anniversaryPagePath = 'pages/anniversary-edit/anniversary-edit';
  const anniversaryEditJs = fs.readFileSync(path.join(__dirname, '..', anniversaryPagePath + '.js'), 'utf8');
  const anniversaryEditWxml = fs.readFileSync(path.join(__dirname, '..', anniversaryPagePath + '.wxml'), 'utf8');
  const anniversaryEditWxss = fs.readFileSync(path.join(__dirname, '..', anniversaryPagePath + '.wxss'), 'utf8');
  const mineJs = fs.readFileSync(path.join(__dirname, '..', 'pages', 'mine', 'mine.js'), 'utf8');
  const mineWxml = fs.readFileSync(path.join(__dirname, '..', 'pages', 'mine', 'mine.wxml'), 'utf8');
  assert(appConfig.pages.includes(anniversaryPagePath) && !appConfig.tabBar.list.some((item) => item.pagePath === anniversaryPagePath),
    '纪念日编辑页：已注册为轻量非 Tab 页面');
  assert(indexWxml.includes('我们在一起') && indexWxml.includes('{{anniversaryDays}}') &&
    indexWxml.includes('纪念日：{{anniversaryDateText}}') && indexWxml.includes('设置我们的纪念日') &&
    indexWxml.includes('wx:if="{{bound && !anniversaryLoading && !anniversaryError}}"'),
    '首页纪念日：已设置展示天数和日期，绑定但未设置展示轻量入口，未绑定不显示');
  assert(indexWxml.includes('bindtap="goAnniversaryEdit"') && mineWxml.includes('bindtap="goAnniversaryEdit"') &&
    indexJs.includes("url: '/pages/anniversary-edit/anniversary-edit'") &&
    mineJs.includes("url: '/pages/anniversary-edit/anniversary-edit'"),
    '纪念日入口：首页卡片和我的设置项复用同一个编辑页');
  assert(mineWxml.includes('<text class="bind-label">纪念日</text>') && mineWxml.includes("anniversaryText") &&
    mineWxml.indexOf('anniversary-setting') > mineWxml.indexOf('<block wx:if="{{bound}}">'),
    '我的纪念日：仅在已绑定设置列表中显示未设置或 YYYY.MM.DD');
  assert(anniversaryEditWxml.includes('picker mode="date"') && anniversaryEditWxml.includes('end="{{maxDate}}"') &&
    anniversaryEditWxml.includes('这一天将作为我们在一起的第1天') && anniversaryEditWxml.includes('bindtap="onSave"') &&
    anniversaryEditWxss.includes('.save-button'),
    '纪念日编辑页：只有日期选择、第一天提示和保存操作');
  assert(anniversaryEditJs.includes("name: 'saveAnniversary'") &&
    anniversaryEditJs.includes("channel.emit('anniversarySaved'") &&
    indexJs.includes("res.eventChannel.on('anniversarySaved'") && mineJs.includes("res.eventChannel.on('anniversarySaved'") &&
    /if \(this\._anniversaryDirty\)[\s\S]{0,150}this\.loadCoupleSettings\(\)/.test(indexJs) &&
    /if \(this\._loaded && this\._anniversaryDirty\)[\s\S]{0,150}this\.loadCoupleSettings\(\)/.test(mineJs),
    '纪念日保存同步：返回首页或我的后只刷新纪念日数据');
  assert(!indexWxml.includes('最近报备') && !indexWxml.includes('我们的今天'),
    '首页纪念日接入：不恢复最近报备或我们的今天');
  // ---------- 报备记录页固定发起入口 ----------
  console.log('\n== 报备记录页固定发起入口 ==');
  const recordJs = fs.readFileSync(path.join(__dirname, '..', 'pages', 'record', 'record.js'), 'utf8');
  const recordWxml = fs.readFileSync(path.join(__dirname, '..', 'pages', 'record', 'record.wxml'), 'utf8');
  const recordWxss = fs.readFileSync(path.join(__dirname, '..', 'pages', 'record', 'record.wxss'), 'utf8');
  assert(recordWxml.includes('class="create-report-fab"') && recordWxml.includes('bindtap="onCreateReport"') &&
    recordJs.includes("wx.navigateTo({ url: '/pages/apply/apply' })"), '报备记录页：固定入口复用现有 apply 页面');
  assert(/\.create-report-fab\s*\{[^}]*position:\s*fixed;/s.test(recordWxss) &&
    /bottom:\s*calc\(120rpx\s*\+\s*env\(safe-area-inset-bottom\)\)/.test(recordWxss), '报备记录页：按钮 fixed 定位于 TabBar 和安全区上方');
  assert(/\.page\s*\{[^}]*padding-bottom:\s*calc\(220rpx\s*\+\s*env\(safe-area-inset-bottom\)\)/s.test(recordWxss),
    '报备记录页：列表预留底部空间避免遮挡最后一条');
  assert(recordJs.includes('const requestId = (this._requestId || 0) + 1') &&
    (recordJs.match(/requestId !== this\._requestId/g) || []).length >= 3,
    '性能优化：record refresh 生成请求版本，登录后、响应后和异常路径均丢弃旧请求');
  assert(recordJs.includes('this.setData({ loadingMore: true })') && recordJs.includes('this.setData({ loadingMore: false })') &&
    recordJs.includes('if (this.data.loadingMore || !this.data.hasMore || this.data.loading) return'),
    '性能优化：record 翻页期间启用 loadingMore 单请求锁并在结束后恢复');
  assert(recordJs.includes('const role = this.data.activeRole') && recordJs.includes('const status = this.data.activeStatus') &&
    recordJs.includes('this.fetchPage(0, requestId)'), '性能优化：角色和状态切换后的请求使用同一版本快照，旧结果不能覆盖新筛选');

  // ---------- Banner 原子同步与受控访问 ----------
  console.log('\n== Banner 原子同步与受控访问 ==');
  const bannerCropPath = 'pages/banner-crop/banner-crop';
  const bannerCropJs = fs.readFileSync(path.join(__dirname, '..', bannerCropPath + '.js'), 'utf8');
  const bannerCropWxml = fs.readFileSync(path.join(__dirname, '..', bannerCropPath + '.wxml'), 'utf8');
  const bannerCropWxss = fs.readFileSync(path.join(__dirname, '..', bannerCropPath + '.wxss'), 'utf8');
  assert(appConfig.pages.includes(bannerCropPath) && indexJs.includes("url: '/pages/banner-crop/banner-crop'") &&
    indexJs.includes("navRes.eventChannel.emit('cropSource'"), 'Banner 裁剪：选择图片后进入已注册的原生裁剪页');
  assert(bannerCropWxss.includes('width: 702rpx') && bannerCropWxss.includes('height: 320rpx') &&
    bannerCropJs.includes('const AREA_WIDTH_RPX = 702') && bannerCropJs.includes('const AREA_HEIGHT_RPX = 320'),
    'Banner 裁剪：裁剪框固定匹配首页 702rpx × 320rpx 横幅比例');
  assert(bannerCropJs && bannerCropWxml.includes('选择展示区域') &&
    bannerCropWxml.includes('拖动或缩放图片，选择想展示的部分') &&
    !bannerCropWxml.includes('Banner'),
    'Banner 裁剪文案：面向用户使用展示区域表述，不显示技术术语');
  assert(/\.crop-button\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s.test(bannerCropWxss) &&
    /\.crop-button\s*\{[^}]*height:\s*92rpx;[^}]*min-height:\s*92rpx;[^}]*padding:\s*0;/s.test(bannerCropWxss),
    'Banner 裁剪按钮：等高 flex 布局且文字水平垂直居中');
  assert(bannerCropWxml.includes('<movable-area') && bannerCropWxml.includes('<movable-view') &&
    bannerCropWxml.includes('direction="all"') && bannerCropWxml.includes('scale-min="1"') && bannerCropWxml.includes('scale-max="3"'),
    'Banner 裁剪：图片支持原生拖动和 1～3 倍双指缩放');
  assert(bannerCropWxml.includes('canvas-id="bannerCropCanvas"') && bannerCropJs.includes("wx.createCanvasContext('bannerCropCanvas'") &&
    bannerCropJs.includes('wx.canvasToTempFilePath') && bannerCropJs.includes('const OUTPUT_WIDTH = 1080') &&
    bannerCropJs.includes('const OUTPUT_HEIGHT = 492') && bannerCropJs.includes("fileType: 'jpg'") && bannerCropJs.includes('quality: 0.86'),
    'Banner 裁剪：使用真实小程序 Canvas API 输出 1080×492 压缩 JPEG');
  assert(indexJs.includes('uploadCroppedBanners(croppedFiles)') &&
    indexJs.includes('filePath: croppedFiles[i]') && !indexJs.includes('filePath: f.tempFilePath'),
    'Banner 上传：只上传 Canvas 裁剪结果，不再上传选择的原始大图');
  assert(bannerCropJs.includes("emit('bannerCropCancelled')") && indexJs.includes("on('bannerCropCancelled'") &&
    indexJs.includes('this._croppedBannerFiles = []'), 'Banner 裁剪：取消或直接返回会清空队列且不上传');
  assert(indexJs.includes("util.toast('图片上传失败:") && indexJs.includes("result.msg || '上传失败，请重试'") &&
    indexJs.includes('上传成功，Banner 刷新失败，请稍后重试'), 'Banner 上传：uploadFile、业务更新和后续刷新使用分层反馈');
  assert(indexJs.includes("updateSharedBanners('add'") && indexJs.includes("result.code !== 'TRANSACTION_FAILED'") &&
    indexJs.includes("source: 'database-reconciliation'"),
    'Banner 上传：reject 或技术性失败响应都会通过数据库事实对账，已成功入库不再误报失败');
  assert(indexJs.includes("action === 'add'") && indexJs.includes('targets.every((fileID) => banners.includes(fileID))') &&
    indexJs.includes('targets.every((fileID) => !banners.includes(fileID))'),
    'Banner 对账：上传只验证目标 fileID 存在，删除只验证目标 fileID 不存在，不要求完整数组相等');
  assert(indexJs.includes("updateSharedBanners('remove'") && indexJs.includes("code: 'BANNER_STATE_UNCONFIRMED'") &&
    indexJs.includes("util.toast('操作状态未确认，请稍后刷新')"),
    'Banner 删除：响应异常可对账，仅在无法读取数据库事实时提示状态未确认');
  assert(indexJs.includes('[BannerMutation][CALL_START]') && indexJs.includes('[BannerMutation][CALL_RESOLVE]') &&
    indexJs.includes('[BannerMutation][CALL_REJECT]') && indexJs.includes('[BannerMutation][RECONCILE_RESULT]') &&
    indexJs.includes('[BannerMutation][FINAL_DECISION]'),
    'Banner 诊断：前端记录调用、响应、对账和最终判定且只输出脱敏 fileID');
  const updateBannersJs = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'updateBanners', 'index.js'), 'utf8');
  assert(updateBannersJs.includes('[updateBanners][TRANSACTION_START]') &&
    updateBannersJs.includes('[updateBanners][TRANSACTION_SUCCESS]') &&
    updateBannersJs.includes('[updateBanners][FUNCTION_RETURN_SUCCESS]') &&
    updateBannersJs.includes('[updateBanners][FUNCTION_ERROR]'),
    'Banner 诊断：云函数清晰区分事务成功、函数返回成功和函数错误');
  assert(updateBannersJs.includes('let committedBanners = []') &&
    !updateBannersJs.includes('txRes.result.banners'),
    'Banner 云函数：事务提交后使用已提交快照构造响应，不依赖 SDK 返回包装结构');
  assert(indexJs.includes('applyOptimisticBanners(result.banners, previewByFileID)') &&
    indexJs.includes('previewByFileID[fileID] = croppedFiles[index]'), 'Banner 上传：业务成功后立即使用裁剪本地路径乐观显示');
  assert(indexJs.includes('applyOptimisticBanners(result.banners)') && indexJs.includes("util.toast('删除成功')"),
    'Banner 删除：业务成功后立即从当前页面和管理列表移除');
  assert(indexJs.includes('this._bannerStateVersion = (this._bannerStateVersion || 0) + 1') &&
    indexJs.includes('bannerStateVersion !== (this._bannerStateVersion || 0)') &&
    indexJs.includes('this._bannerRequestId = (this._bannerRequestId || 0) + 1'),
    'Banner 即时显示：乐观更新递增状态版本并使上传前的 Banner 请求失效');
  assert(indexJs.includes('refreshBannerUrls(result.banners)') &&
    indexJs.includes('返回的 Banner 版本落后，保留当前本地预览') &&
    indexJs.includes('banners: banners.slice()') && indexJs.includes('bannerUrls: bannerUrls.slice()'),
    'Banner 即时显示：后台刷新只接受预期版本，并使用新数组引用更新 swiper 数据源');
  assert(indexJs.includes('const bannerStateVersion = this._bannerStateVersion || 0') &&
    indexJs.includes('if (bannerStateChanged)') && indexJs.includes('else if (userInfo.partnerId)') &&
    indexJs.includes('banners: this.data.banners.slice()'),
    'Banner 即时显示：裁剪返回触发的旧 init 不会覆盖刚完成的上传或删除状态');
  assert(indexJs.includes('else if (userInfo.partnerId)') && indexJs.includes('this.refreshBannerUrls()'),
    'Banner 刷新：绑定状态每次初始化核对当前 couple_settings，失败可在下次 onShow 重试');
  assert(indexJs.includes('saveReorder(list)') && indexJs.includes("data: { action: 'reorder', order: list }") &&
    indexJs.includes('currentCount >= 10'), 'Banner 兼容：现有排序流程和最多 10 张限制保持不变');
  const banner1 = 'cloud://test-env/banners/openid-AAA/a-1.jpg';
  const banner2 = 'cloud://test-env/banners/openid-AAA/a-2.jpg';
  const banner3 = 'cloud://test-env/banners/openid-AAA/a-3.jpg';
  const strangerBanner = 'cloud://test-env/private/stranger.jpg';
  const bannerUserA = () => store.couple_settings.find((settings) => settings.pairKey === expectedPairKey);
  const bannerUserB = bannerUserA;

  const addBanner = await callAs(A, 'updateBanners', { action: 'add', fileIDs: [banner1, banner2] });
  assert(addBanner.success && deepEqual(bannerUserA().banners, [banner1, banner2]) && deepEqual(bannerUserB().banners, [banner1, banner2]),
    'Banner add：双方原子写入同一个最终数组');
  const duplicateAdd = await callAs(A, 'updateBanners', { action: 'add', fileIDs: [banner2, banner2] });
  assert(duplicateAdd.success && deepEqual(duplicateAdd.banners, [banner1, banner2]), 'Banner add：重复 fileID 自动去重');

  const reorder = await callAs(A, 'updateBanners', { action: 'reorder', order: [banner2, banner1] });
  assert(reorder.success && deepEqual(bannerUserA().banners, [banner2, banner1]) && deepEqual(bannerUserB().banners, [banner2, banner1]),
    'Banner reorder：只调整顺序并同步双方');
  const reorderAddUnknown = await callAs(A, 'updateBanners', { action: 'reorder', order: [banner2, banner1, strangerBanner] });
  assert(!reorderAddUnknown.success && reorderAddUnknown.code === 'INVALID_REORDER', 'Banner reorder：增加陌生 fileID 被拒绝');
  const reorderRemoveOne = await callAs(A, 'updateBanners', { action: 'reorder', order: [banner2] });
  assert(!reorderRemoveOne.success && reorderRemoveOne.code === 'INVALID_REORDER', 'Banner reorder：删除现有 fileID 被拒绝');

  const removeMissing = await callAs(A, 'updateBanners', { action: 'remove', fileID: banner3 });
  assert(!removeMissing.success && removeMissing.code === 'BANNER_NOT_FOUND', 'Banner delete：删除不存在项返回明确业务结果');
  const removeBanner = await callAs(B, 'updateBanners', { action: 'remove', fileID: banner1 });
  assert(removeBanner.success && deepEqual(bannerUserA().banners, [banner2]) && deepEqual(bannerUserB().banners, [banner2]),
    'Banner delete：正常删除并同步双方');

  transactionFailAfterWrites = 0;
  const failedBannerWrite = await callAs(A, 'updateBanners', { action: 'add', fileIDs: [banner3] });
  transactionFailAfterWrites = null;
  assert(!failedBannerWrite.success && deepEqual(bannerUserA().banners, [banner2]) && deepEqual(bannerUserB().banners, [banner2]),
    'Banner 伴侣写入失败：事务整体回滚，不产生单向状态');

  const concurrentBanner = await Promise.all([
    callAs(A, 'updateBanners', { action: 'add', fileIDs: [banner1] }),
    callAs(A, 'updateBanners', { action: 'add', fileIDs: [banner3] })
  ]);
  assert(concurrentBanner.every((result) => result.success) && deepEqual(bannerUserA().banners, bannerUserB().banners) &&
    bannerUserA().banners.includes(banner1) && bannerUserA().banners.includes(banner3),
    'Banner 并发操作：基于事务最新数据计算且双方保持一致');

  const boundBannerUserB = store.users.find((user) => user.openid === B);
  const originalPartnerId = boundBannerUserB.partnerId;
  boundBannerUserB.partnerId = '';
  const mismatchedRelation = await callAs(A, 'updateBanners', { action: 'add', fileIDs: [strangerBanner] });
  store.users.find((user) => user.openid === B).partnerId = originalPartnerId;
  assert(!mismatchedRelation.success && mismatchedRelation.code === 'BINDING_INVALID' && !bannerUserA().banners.includes(strangerBanner),
    'Banner 双方关系不一致：拒绝更新且不写入');

  const arbitraryRead = await callAs(A, 'getSharedBanners', { fileIDs: [strangerBanner], fileID: strangerBanner });
  assert(arbitraryRead.success && arbitraryRead.items.length === bannerUserA().banners.length &&
    !arbitraryRead.items.some((item) => item.fileID === strangerBanner),
    'getSharedBanners：忽略客户端任意 fileID，只读取当前用户共享 Banner');
  tempFileFailures = new Set([banner1]);
  const partialURLFailure = await callAs(B, 'getSharedBanners', {});
  tempFileFailures = new Set();
  assert(partialURLFailure.success && partialURLFailure.items.length === bannerUserB().banners.length &&
    partialURLFailure.items.some((item) => item.fileID === banner1 && !item.success) &&
    partialURLFailure.items.some((item) => item.success),
    'getSharedBanners：单张 URL 失败可识别且不影响其他图片');

  const foreignEnvBanner = await callAs(A, 'updateBanners', { action: 'add', fileIDs: ['cloud://other-env/banners/openid-AAA/x.jpg'] });
  const foreignOwnerBanner = await callAs(A, 'updateBanners', { action: 'add', fileIDs: ['cloud://test-env/banners/openid-CCC/x.jpg'] });
  assert(!foreignEnvBanner.success && foreignEnvBanner.code === 'FILE_ENV_MISMATCH' &&
    !foreignOwnerBanner.success && foreignOwnerBanner.code === 'FILE_OWNER_MISMATCH',
    'Banner 来源校验：拒绝其他云环境和其他用户路径的 fileID');

  const bannersBeforeAnniversaryPatch = bannerUserA().banners.slice();
  await callAs(A, 'saveAnniversary', { anniversaryDate: '2025-08-25' });
  assert(deepEqual(bannerUserA().banners, bannersBeforeAnniversaryPatch) && bannerUserA().anniversaryDate === '2025-08-25',
    'couple_settings 字段保护：修改纪念日不覆盖 banners，修改 Banner 也保留 anniversaryDate');

  const unboundBanners = await callAs(C, 'getSharedBanners');
  const unboundBannerUpdate = await callAs(C, 'updateBanners', { action: 'add', fileIDs: ['cloud://test-env/banners/openid-CCC/c.jpg'] });
  assert(!unboundBanners.success && unboundBanners.code === 'NOT_BOUND' &&
    !unboundBannerUpdate.success && unboundBannerUpdate.code === 'NOT_BOUND',
    'Banner 情侣资产：未绑定用户不能读取或维护');

  const ijBanner = 'cloud://test-env/banners/openid-III/ij.jpg';
  const ijAdd = await callAs(I, 'updateBanners', { action: 'add', fileIDs: [ijBanner] });
  const ijRead = await callAs(J, 'getSharedBanners');
  const abReadAfterIJ = await callAs(A, 'getSharedBanners');
  assert(ijAdd.success && ijRead.success && ijRead.banners.includes(ijBanner) &&
    !abReadAfterIJ.banners.includes(ijBanner) && !ijRead.banners.some((fileID) => bannersBeforeAnniversaryPatch.includes(fileID)),
    'Banner 多情侣隔离：两对情侣只读取各自 couple_settings.banners');

  const bindGHForMigration = await callAs(G, 'bind', { code: loginH.userInfo.bindCode });
  const migrationUserG = store.users.find((user) => user.openid === G);
  const migrationUserH = store.users.find((user) => user.openid === H);
  const legacyBanners = ['cloud://test-env/banners/openid-GGG/legacy.jpg'];
  migrationUserG.banners = legacyBanners.slice();
  migrationUserH.banners = ['cloud://test-env/banners/openid-HHH/conflict.jpg'];
  const migrationConflict = await callAs(G, 'migrateBanners', { mode: 'dryRun' });
  assert(bindGHForMigration.success && !migrationConflict.success && migrationConflict.code === 'BANNER_HISTORY_CONFLICT',
    'Banner 迁移：双方 users.banners 不一致时 dryRun 阻止迁移且不写入');
  migrationUserH.banners = legacyBanners.slice();
  const bannerMigrationDryRun = await callAs(G, 'migrateBanners', { mode: 'dryRun' });
  const missingBannerMigrationConfirm = await callAs(G, 'migrateBanners', { mode: 'apply' });
  assert(bannerMigrationDryRun.success && bannerMigrationDryRun.summary.toMigrate === 1 &&
    !missingBannerMigrationConfirm.success && missingBannerMigrationConfirm.code === 'CONFIRM_REQUIRED',
    'Banner 迁移：dryRun 完全只读，apply 必须显式 MIGRATE_BANNERS 确认');
  const bannerMigrationApply = await callAs(G, 'migrateBanners', { mode: 'apply', confirm: 'MIGRATE_BANNERS' });
  const bannerMigrationSecondApply = await callAs(G, 'migrateBanners', { mode: 'apply', confirm: 'MIGRATE_BANNERS' });
  const bannerMigrationFinalDryRun = await callAs(H, 'migrateBanners', { mode: 'dryRun' });
  const pairGH = [migrationUserG._id, migrationUserH._id].sort().join('|');
  const migratedSettings = store.couple_settings.find((settings) => settings.pairKey === pairGH);
  assert(bannerMigrationApply.success && bannerMigrationApply.migrated === 1 && deepEqual(migratedSettings.banners, legacyBanners) &&
    bannerMigrationSecondApply.success && bannerMigrationSecondApply.migrated === 0 && bannerMigrationFinalDryRun.summary.toMigrate === 0 &&
    bannerMigrationFinalDryRun.summary.alreadyMigrated && deepEqual(migrationUserG.banners, legacyBanners),
    'Banner 迁移：只复制 fileID 引用，第二次 apply 幂等，最终 dryRun toMigrate=0');

  const snapshotBill = { _id: 'profile-snapshot-bill', creatorId: migrationUserG._id, creatorName: '旧昵称', pairKey: pairGH };
  const snapshotReport = { _id: 'profile-snapshot-report', creatorId: migrationUserG._id, partnerId: migrationUserH._id, creatorName: '旧昵称', processedByName: '旧审批名', pairKey: pairGH };
  store.bills.push(snapshotBill);
  store.reports.push(snapshotReport);
  const profileUpdate = await callAs(G, 'updateProfile', { nickName: '新昵称' });
  assert(profileUpdate.success && snapshotBill.creatorName === '旧昵称' && snapshotReport.creatorName === '旧昵称' && snapshotReport.processedByName === '旧审批名',
    'updateProfile：昵称只更新用户资料，不批量修改历史 bills/reports 快照');

  // ---------- 账单固定入口结构 ----------
  console.log('\n== 账单固定入口结构 ==');
  const billWxml = fs.readFileSync(path.join(__dirname, '..', 'pages', 'bill', 'bill.wxml'), 'utf8');
  const billWxss = fs.readFileSync(path.join(__dirname, '..', 'pages', 'bill', 'bill.wxss'), 'utf8');
  const billJs = fs.readFileSync(path.join(__dirname, '..', 'pages', 'bill', 'bill.js'), 'utf8');
  assert((billWxml.match(/bindtap="onAdd"/g) || []).length === 1 && billWxml.includes('class="add-fab"'),
    '账单入口：原底部重复入口已移除，悬浮按钮仍绑定 onAdd');
  assert(/\.add-fab\s*\{[^}]*position:\s*fixed;/s.test(billWxss) && /safe-area-inset-bottom/.test(billWxss),
    '账单入口：fixed 定位并兼顾底部安全区');
  assert(/\.page\s*\{[^}]*padding-bottom:\s*calc\(/s.test(billWxss), '账单列表：保留足够 bottom padding 避免遮挡最后一条');
  assert(billJs.includes('const requestId = ++this._billListRequestId') &&
    billJs.includes('const requestId = ++this._billStatsRequestId') &&
    (billJs.match(/version !== this\._billViewVersion/g) || []).length >= 4,
    '性能优化：bill 列表和统计只允许当前月份版本更新状态');
  assert(!billJs.includes('allBills: []') && !billJs.includes('this.data.allBills') && !billJs.includes('this._allBills'),
    '账单 V2 页面：不再保存整月 _allBills');
  assert(billJs.includes('pageSize: 50') && billJs.includes('type: filterType') &&
    billJs.includes('person: filterPerson') && billJs.includes('category: filterCategory'),
    '账单 V2 页面：类型、人员和分类筛选全部传给服务端');
  assert(billJs.includes("months.map((ym) => this.fetchAllBillsForExport(ym))") && billJs.includes("name: 'getBills'") && billJs.includes('parseAndImportCSV'),
    '性能优化：CSV 导入导出仍保留完整独立数据路径');

  const budgetEditJs = fs.readFileSync(path.join(__dirname, '..', 'pages/budget-edit/budget-edit.js'), 'utf8');
  const budgetEditWxml = fs.readFileSync(path.join(__dirname, '..', 'pages/budget-edit/budget-edit.wxml'), 'utf8');
  assert(appConfig.pages.includes('pages/budget-edit/budget-edit') && !appConfig.tabBar.list.some((item) => item.pagePath === 'pages/budget-edit/budget-edit'), '账单 V2 预算：预算编辑页已注册且不是 TabBar 页面');
  assert(billJs.includes('Promise.allSettled') && billJs.includes('loadBillFirstPage(version)') && billJs.includes('loadBillStats(version)'),
    '账单 V2 首次加载：第一页与完整统计并行且独立结算');
  assert(billJs.includes('loadingMore || !this.data.hasMore') && billJs.includes('this.data.page + 1'),
    '账单 V2 分页：loadingMore 防重且 hasMore=false 停止请求');
  assert(billJs.includes('`filteredList[${startIndex + index}]`') && !billJs.includes('filteredList: this.data.filteredList.concat'),
    '账单 V2 分页：后续页使用局部路径追加');
  assert(billJs.includes('createIntersectionObserver') && billJs.includes("observe('.pagination-sentinel'") &&
    billWxml.includes('class="pagination-sentinel"') && billJs.includes('onReachBottom() { this.loadMore(); }'),
    '账单 V2 分页：页面触底与列表末尾哨兵均能触发加载更多');
  assert(billJs.includes('this._loadingMore = true') && billJs.includes('} finally {') &&
    billJs.includes('requestId === this._billListRequestId') && billJs.includes('version !== this._billViewVersion'),
    '账单 V2 分页：实例锁防重复，finally 恢复并丢弃过期响应');
  assert(billWxml.includes('加载中...') && billWxml.includes('没有更多了'), '账单 V2 分页：列表底部状态完整');
  assert(billJs.includes("name: 'getBillStats'") && billJs.includes('raw.categoryStats') && billJs.includes('raw.peopleStats'),
    '账单 V2 统计：月度完整统计仍来自 getBillStats');
  assert(!billWxml.includes('按月') && !billWxml.includes('按分类') && !billWxml.includes('按人员') &&
    !billJs.includes('onDimChange') && !billJs.includes('buildDimList') && !billWxss.includes('.dim-tab'),
    '账单组合筛选：旧统计维度 UI、事件和样式已完整删除');
  assert(!billWxml.includes('class="budget-card"') && billWxml.includes('本月预算') && billWxml.includes('未设置') &&
    billWxml.includes("budget.status === 'overspent'") && billWxml.includes('budget.resultText'),
    '账单 V2 汇总卡：预算并入粉色卡片且区分未设置、可用与超支');
  assert(budgetEditJs.includes('billCategories.EXPENSE_CATEGORIES') && !budgetEditJs.includes("key: 'food'"),
    '账单 V2 预算编辑：复用统一支出分类定义');
  assert(budgetEditJs.includes("name: 'saveBillBudget'") && budgetEditJs.includes('data: payload') &&
    !budgetEditJs.includes('pairKey') && !budgetEditJs.includes('memberIds'),
    '账单 V2 预算保存：只提交允许字段');
  assert(budgetEditJs.includes("name: 'getBillStats'") && budgetEditJs.includes('sameBudget(result.budget, payload)'),
    '账单 V2 预算保存：响应不确定时按数据库预算对账');
  assert(billJs.includes("res.eventChannel.on('budgetSaved'") && billJs.includes('this._budgetDirty = true') &&
    /else if \(this\._budgetDirty\)[\s\S]{0,160}loadBillStats/.test(billJs),
    '账单 V2 生命周期：预算编辑返回只刷新统计');
  assert(billJs.includes('while (hasMore)') && billJs.includes("type: 'all', person: 'all', category: ''") &&
    !/fetchAllBillsForExport[\s\S]{0,900}setData/.test(billJs),
    '账单 V2 CSV：三个月分别分页且完整数据不进入 setData');
  assert(billJs.includes("const csv = '\\uFEFF'") && billJs.includes('.csv`') &&
    billJs.includes('wx.env.USER_DATA_PATH') && billJs.includes("fs.writeFileSync(tmpPath, csv, 'utf8')") &&
    billJs.includes('fs.statSync(tmpPath)') && billJs.includes('wx.shareFileMessage') &&
    billJs.includes("console.error('[BillExport][SHARE_FAILED]', {"),
    '账单导出：真实 UTF-8 BOM CSV 写入用户目录，校验非空后发送并保留真实失败日志');
  assert(billWxml.includes('range="{{filterCategoryOptions}}"') &&
    billWxml.includes('bindchange="onFilterCategoryChange"') &&
    billJs.includes('onFilterCategoryChange(e)') && billJs.includes('buildCategoryOptions(type)') &&
    billJs.includes("return [{ key: '', name: '全部' }].concat(this.getFilterCategories(type))") &&
    billJs.includes('getFilterCategories(type)') &&
    billJs.includes("if (type === 'expense') return this._expenseFilterCategories") &&
    billJs.includes("if (type === 'income') return this._incomeFilterCategories") &&
    billJs.includes('filterCategory: categoryValid ? this.data.filterCategory') &&
    billJs.includes('filterPerson: values[idx]') && billJs.includes('filterCategory: selected.key'),
    '账单组合筛选：原生 picker 可点击并生成分类选项，人员/分类只更新自身，类型变化仅在不兼容时清空分类');
  assert(billJs.includes("this.buildCategoryOptions('all')") &&
    billJs.includes('filterCategoryOptions: this.buildCategoryOptions(type)') &&
    billJs.includes('this._expenseFilterCategories = billCategories.EXPENSE_CATEGORIES.map') &&
    billJs.includes('this._incomeFilterCategories = billCategories.INCOME_CATEGORIES.map'),
    '账单分类 picker：全部/支出/收入的数据源随类型正确生成');
  assert(billJs.includes("console.log('[BillExport][FILE_READY]'" ) &&
    billJs.includes("title: '文件已生成'") && billJs.includes("confirmText: '发送文件'") &&
    billJs.includes('that.shareExportFile({ filePath: tmpPath, fileName, fileSize })') &&
    /wx\.shareFileMessage\(\{\s*filePath: file\.filePath,\s*fileName: file\.fileName,/s.test(billJs) &&
    billJs.includes("errMsg: err && err.errMsg") && billJs.includes("errCode: err && err.errCode") &&
    /wx\.openDocument\(\{\s*filePath: file\.filePath,\s*showMenu: true,/s.test(billJs),
    '账单导出真机：记录文件路径/名称/大小，用户二次点击直接分享，失败后尝试 openDocument');
  assert(billJs.includes('`账单_${months[0]}至${months[months.length - 1]}.csv`') &&
    !/const fileName[^\n]*[:\\/*?"<>|]/.test(billJs),
    '账单导出：文件名简短且不含文件系统非法字符');
  assert(budgetEditWxml.includes('月总预算') && budgetEditWxml.includes('分类预算') && budgetEditWxml.includes('type="digit"'),
    '账单 V2 预算编辑：总预算必填与分类预算表单存在');
  const getBillStatsSource = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'getBillStats', 'index.js'), 'utf8');
  assert(getBillStatsSource.includes('Array.isArray(aggregateRes.list)') && getBillStatsSource.includes('aggregateRes.data'),
    '账单 V2 统计：优先解析 CloudBase aggregate().end() 的 list 并兼容旧 data 结构');
  assert(!getBillStatsSource.includes('[BillStats]') && !getBillStatsSource.includes('MATCH_SAMPLE') &&
    !getBillStatsSource.includes('sampleRes'),
    '账单 V2 封板：临时诊断日志和普通查询样本已清理');
  assert(getBillStatsSource.includes("['totalAmount', 'amount', 'sum', 'total']") &&
    getBillStatsSource.includes('$numberDecimal') && getBillStatsSource.includes("group._id || group.id"),
    '账单 V2 统计：兼容聚合字段别名、分组结构和数值包装类型');
  assert(getBillStatsSource.includes('_.gte(range.start).and(_.lt(range.end))') && getBillStatsSource.includes('`${yearMonth}-01`'),
    '账单 V2 统计：YYYY-MM-DD 字符串使用月初闭区间、下月月初开区间查询');
  assert(!billJs.includes('[BillPage][STATS_RESPONSE]') && billJs.includes('const raw = result.filteredStats || result.stats || {}') &&
    billJs.includes('expense: Number(raw.expense)') && billWxml.includes('¥{{stats.expenseText}}'),
    '账单 V2 前端：顶部金额读取筛选统计并绑定 stats.expenseText');
  assert(billJs.includes('data: { yearMonth, type: filterType, person: filterPerson, category: filterCategory }') &&
    /reloadFilteredList\(\)[\s\S]{0,500}this\.loadBillFirstPage[\s\S]{0,160}this\.loadBillStats/.test(billJs),
    '账单筛选联动：筛选变化并行刷新第一页和服务端完整统计');
  assert(getBillStatsSource.includes('monthStats') && getBillStatsSource.includes('filteredStats') &&
    getBillStatsSource.includes('budget: buildBudget(record, monthStats.expense, monthCategoryExpense)'),
    '账单筛选统计：同一次整月聚合派生筛选统计，预算始终使用整月支出');
  assert(billJs.includes("else if (this._budgetDirty) {\n      this._budgetDirty = false;\n      this.loadBillStats(this._billViewVersion);"),
    '账单 V2 预算刷新：只刷新统计且不会用零值重置列表或月度汇总');

  // ---------- 记账 ----------
  console.log('\n== 记账（共享账本） ==');
  const unboundBill = await callAs(C, 'addBill', { type: 'expense', amount: 10, billDate: '2026-08-19', category: 'food' });
  assert(!unboundBill.success && unboundBill.msg.indexOf('绑定') >= 0, '未绑定的 C 记账：被拒绝');
  const badAmount = await callAs(A, 'addBill', { type: 'expense', amount: -5, billDate: '2026-08-19', category: 'food' });
  assert(!badAmount.success, '负数金额：被拒绝');
  const badDate = await callAs(A, 'addBill', { type: 'expense', amount: 10, billDate: '昨天', category: 'food' });
  assert(!badDate.success, '非法日期：被拒绝');
  const billA = await callAs(A, 'addBill', { type: 'expense', amount: 33.333, billDate: '2026-08-19', category: 'food', note: '午餐' });
  assert(billA.success, 'A 记一笔：成功');
  const savedA = store.bills.find((b) => b._id === billA.id);
  assert(savedA.amount === 33.33, '金额自动保留两位小数（33.333 → 33.33）');
  const billB = await callAs(B, 'addBill', { type: 'income', amount: 5000, billDate: '2026-08-18', category: 'salary', note: '工资' });
  assert(billB.success, 'B 记一笔收入：成功');

  // 共享账本查询
  const billsA = await callAs(A, 'getBills', { yearMonth: '2026-08' });
  assert(billsA.success && billsA.list.length === 2, '共享账本：A 能看到双方共 2 笔账');
  const mineFlags = billsA.list.map((x) => x.mine);
  assert(mineFlags.filter(Boolean).length === 1, '账单「是否自己记的」标记正确');
  const billsFiltered = await callAs(A, 'getBills', { yearMonth: '2026-08', type: 'income' });
  assert(billsFiltered.list.length === 1 && billsFiltered.list[0].categoryName === '工资', '按类型筛选收入：只返回 1 笔工资');

  // 删除权限
  const delOthers = await callAs(A, 'deleteBill', { id: billB.id });
  assert(!delOthers.success && delOthers.msg.indexOf('自己') >= 0, 'A 删 B 记的账：被拒绝（只能删自己的）');
  const delOwn = await callAs(B, 'deleteBill', { id: billB.id });
  assert(delOwn.success, 'B 删自己记的账：成功');
  const billsAfter = await callAs(A, 'getBills', { yearMonth: '2026-08' });
  assert(billsAfter.list.length === 1, '删除后账本只剩 1 笔');

  // ---------- 账单 V2：分页、完整统计与共享月预算 ----------
  console.log('\n== 账单 V2：分页、完整统计与共享月预算 ==');
  const userAId = store.users.find((u) => u.openid === A)._id;
  const userBId = store.users.find((u) => u.openid === B)._id;
  const billPairKey = [userAId, userBId].sort().join('|');
  const billMemberIds = [userAId, userBId].sort();
  for (let i = 0; i < 123; i++) {
    const mine = i % 2 === 0;
    const income = i % 5 === 0;
    store.bills.push({
      _id: `paged-${String(i).padStart(3, '0')}`,
      creatorId: mine ? userAId : userBId,
      creatorName: mine ? 'A' : 'B',
      partnerId: mine ? userBId : userAId,
      pairKey: billPairKey, memberIds: billMemberIds,
      type: income ? 'income' : 'expense',
      category: income ? 'salary' : (i % 3 === 0 ? 'food' : 'shopping'),
      categoryName: income ? '工资' : (i % 3 === 0 ? '餐饮' : '购物'),
      amount: 1,
      billDate: `2026-07-${String(1 + (i % 28)).padStart(2, '0')}`,
      createdAt: '2026-07-15T12:00:00.000Z'
    });
  }
  const firstBillPage = await callAs(A, 'getBills', { yearMonth: '2026-07', page: 0, pageSize: 500 });
  const secondBillPage = await callAs(A, 'getBills', { yearMonth: '2026-07', page: 1, pageSize: 50 });
  const lastBillPage = await callAs(A, 'getBills', { yearMonth: '2026-07', page: 2, pageSize: 50 });
  assert(firstBillPage.success && firstBillPage.list.length === 50 && firstBillPage.pageSize === 50 && firstBillPage.hasMore,
    '账单 V2 分页：第一页最多 50 条，第 51 条仅用于 hasMore，客户端不能请求 500 条');
  assert(secondBillPage.list.length === 50 && secondBillPage.hasMore &&
    !secondBillPage.list.some((item) => firstBillPage.list.some((first) => first.id === item.id)),
    '账单 V2 分页：第二页正确且不重复第一页');
  assert(lastBillPage.list.length === 23 && !lastBillPage.hasMore, '账单 V2 分页：最后一页返回剩余记录且 hasMore=false');
  const boundaryCases = [
    { month: '2025-01', count: 49, lengths: [49], more: [false] },
    { month: '2025-02', count: 50, lengths: [50], more: [false] },
    { month: '2025-03', count: 51, lengths: [50, 1], more: [true, false] },
    { month: '2025-04', count: 100, lengths: [50, 50], more: [true, false] },
    { month: '2025-05', count: 101, lengths: [50, 50, 1], more: [true, true, false] }
  ];
  for (const testCase of boundaryCases) {
    for (let i = 0; i < testCase.count; i++) {
      store.bills.push({
        _id: `boundary-${testCase.month}-${i}`,
        creatorId: userAId, creatorName: 'A', partnerId: userBId,
        pairKey: billPairKey, memberIds: billMemberIds,
        type: 'expense', category: 'food', categoryName: '餐饮', amount: 1,
        billDate: `${testCase.month}-${String(1 + (i % 28)).padStart(2, '0')}`,
        createdAt: `${testCase.month}-15T12:00:00.000Z`
      });
    }
    const pages = [];
    for (let page = 0; page < testCase.lengths.length; page++) {
      pages.push(await callAs(A, 'getBills', { yearMonth: testCase.month, page, pageSize: 50 }));
    }
    assert(pages.every((item, index) => item.list.length === testCase.lengths[index] && item.hasMore === testCase.more[index]),
      `账单 V2 分页边界：${testCase.count} 条按 50 条分页且 hasMore 正确`);
  }
  const expensePage = await callAs(A, 'getBills', { yearMonth: '2026-07', type: 'expense' });
  const incomePage = await callAs(A, 'getBills', { yearMonth: '2026-07', type: 'income' });
  const minePage = await callAs(A, 'getBills', { yearMonth: '2026-07', person: 'mine' });
  const partnerPage = await callAs(A, 'getBills', { yearMonth: '2026-07', person: 'partner' });
  const foodPage = await callAs(A, 'getBills', { yearMonth: '2026-07', category: 'food' });
  assert(expensePage.list.every((item) => item.type === 'expense') && incomePage.list.every((item) => item.type === 'income'),
    '账单 V2 筛选：expense/income 在服务端过滤');
  assert(minePage.list.every((item) => item.creatorId === userAId) && partnerPage.list.every((item) => item.creatorId === userBId),
    '账单 V2 筛选：mine/partner 由服务端真实双方身份映射');
  assert(foodPage.list.length > 0 && foodPage.list.every((item) => item.category === 'food'), '账单 V2 筛选：分类在服务端过滤');
  const partnerFoodExpense = await callAs(A, 'getBills', {
    yearMonth: '2026-07', page: 0, pageSize: 50, type: 'expense', person: 'partner', category: 'food'
  });
  assert(partnerFoodExpense.list.length > 0 && partnerFoodExpense.list.every((item) =>
    item.type === 'expense' && item.creatorId === userBId && item.category === 'food'),
  '账单组合筛选：expense + partner + food 三个条件同时生效');
  const partnerFoodExpensePage2 = await callAs(A, 'getBills', {
    yearMonth: '2026-07', page: 1, pageSize: 50, type: 'expense', person: 'partner', category: 'food'
  });
  assert(partnerFoodExpensePage2.success && partnerFoodExpensePage2.page === 1 && partnerFoodExpensePage2.list.every((item) =>
    item.type === 'expense' && item.creatorId === userBId && item.category === 'food'),
  '账单组合筛选：第二页继续继承完整三条件');
  const forgedScope = await callAs(A, 'getBills', {
    yearMonth: '2026-07', creatorId: 'id-foreign', partnerId: 'id-foreign', openid: C, userId: 'id-foreign'
  });
  assert(forgedScope.success && forgedScope.list.every((item) => [userAId, userBId].includes(item.creatorId)),
    '账单 V2 权限：客户端伪造身份字段不能改变查询范围');
  const stablePage = firstBillPage.list.slice().sort((left, right) =>
    String(right.billDate).localeCompare(String(left.billDate)) || String(right.createdAt).localeCompare(String(left.createdAt)) || String(right.id).localeCompare(String(left.id))
  );
  assert(deepEqual(firstBillPage.list.map((item) => item.id), stablePage.map((item) => item.id)),
    '账单 V2 分页：billDate/createdAt/_id 三字段降序稳定');

  for (let i = 0; i < 1005; i++) {
    store.bills.push({
      _id: `stats-${String(i).padStart(4, '0')}`, creatorId: i % 2 ? userAId : userBId,
      creatorName: i % 2 ? 'A' : 'B', partnerId: i % 2 ? userBId : userAId,
      pairKey: billPairKey, memberIds: billMemberIds,
      type: i % 10 === 0 ? 'income' : 'expense', category: i % 2 ? 'food' : 'other',
      categoryName: i % 2 ? '餐饮' : '其他', amount: 1, billDate: '2026-06-15', createdAt: '2026-06-15T10:00:00.000Z'
    });
  }
  const statsBeforeBudget = await callAs(A, 'getBillStats', { yearMonth: '2026-06' });
  assert(statsBeforeBudget.success && statsBeforeBudget.stats.count === 1005 &&
    statsBeforeBudget.stats.expense === 904 && statsBeforeBudget.stats.income === 101,
    '账单 V2 统计：超过 1000 条仍通过数据库聚合覆盖完整自然月且收支正确');
  assert(statsBeforeBudget.stats.categoryStats.reduce((sum, item) => sum + item.amount, 0) === 904 &&
    statsBeforeBudget.stats.peopleStats.reduce((sum, item) => sum + item.count, 0) === 1005,
    '账单 V2 统计：分类和人员聚合覆盖完整月份，不依赖 getBills 第一页');
  const filteredJuneStats = await callAs(A, 'getBillStats', {
    yearMonth: '2026-06', type: 'expense', person: 'partner', category: 'other'
  });
  assert(filteredJuneStats.success && filteredJuneStats.filteredStats.count === 402 &&
    filteredJuneStats.filteredStats.expense === 402 && filteredJuneStats.filteredStats.income === 0 &&
    filteredJuneStats.filteredStats.balance === -402,
    '账单筛选统计：expense + partner + other 覆盖完整月份而非前 50 条');
  assert(filteredJuneStats.monthStats.count === 1005 && filteredJuneStats.stats.count === 1005,
    '账单筛选统计：monthStats 与兼容 stats 仍保持完整月份口径');
  assert(statsBeforeBudget.budget === null, '账单 V2 预算：未设置月份明确返回 budget=null');

  [100, 7.5, 46.93].forEach((amount, index) => store.bills.push({
    _id: `budget-stable-${index}`, creatorId: index % 2 ? userAId : userBId,
    pairKey: billPairKey, memberIds: billMemberIds,
    creatorName: index % 2 ? 'A' : 'B', type: 'expense', category: index === 2 ? 'shopping' : 'food',
    categoryName: index === 2 ? '购物' : '餐饮', amount, billDate: `2026-04-${String(index + 2).padStart(2, '0')}`, createdAt: `2026-04-0${index + 2}T10:00:00.000Z`
  }));
  store.bills.push({
    _id: 'budget-stable-income', creatorId: userAId, creatorName: 'A', type: 'income', category: 'salary',
    pairKey: billPairKey, memberIds: billMemberIds,
    categoryName: '工资', amount: 500, billDate: '2026-04-08', createdAt: '2026-04-08T10:00:00.000Z'
  });
  const aprilBeforeBudget = await callAs(A, 'getBillStats', { yearMonth: '2026-04' });
  await callAs(A, 'saveBillBudget', { month: '2026-04', totalBudget: 1000, categoryBudgets: { food: 200, shopping: 100 } });
  const aprilAfterBudget = await callAs(B, 'getBillStats', { yearMonth: '2026-04' });
  await callAs(B, 'saveBillBudget', { month: '2026-04', totalBudget: 900, categoryBudgets: { food: 150, shopping: 80 } });
  const aprilAfterModify = await callAs(A, 'getBillStats', { yearMonth: '2026-04' });
  assert(aprilBeforeBudget.stats.expense === 154.43 && aprilAfterBudget.stats.expense === 154.43 && aprilAfterModify.stats.expense === 154.43,
    '账单 V2 预算回归：设置和修改预算均不改变当月完整支出');
  assert(aprilAfterBudget.stats.income === 500 && aprilAfterBudget.budget.availableAmount === 845.57,
    '账单 V2 预算回归：可用额度只以 1000-154.43 计算，收入不参与扣减');
  assert(aprilAfterBudget.stats.categoryStats.reduce((sum, item) => sum + item.amount, 0) === 154.43 &&
    aprilAfterBudget.budget.categoryUsage.food.expense === 107.5 && aprilAfterBudget.budget.categoryUsage.shopping.expense === 46.93,
    '账单 V2 预算回归：分类预算使用完整月份分类支出');

  const invalidNegativeBudget = await callAs(A, 'saveBillBudget', { month: '2026-08', totalBudget: -1, categoryBudgets: {} });
  const invalidStringBudget = await callAs(A, 'saveBillBudget', { month: '2026-08', totalBudget: '5000', categoryBudgets: {} });
  const invalidPrecisionBudget = await callAs(A, 'saveBillBudget', { month: '2026-08', totalBudget: 1.234, categoryBudgets: {} });
  const invalidIncomeCategory = await callAs(A, 'saveBillBudget', { month: '2026-08', totalBudget: 5000, categoryBudgets: { salary: 100 } });
  assert(!invalidNegativeBudget.success && !invalidStringBudget.success && !invalidPrecisionBudget.success,
    '账单 V2 预算校验：负数、数字字符串和超过两位小数均拒绝');
  assert(!invalidIncomeCategory.success && invalidIncomeCategory.code === 'INVALID_BUDGET_CATEGORY',
    '账单 V2 预算校验：收入分类不能进入 categoryBudgets');
  const zeroBudget = await callAs(A, 'saveBillBudget', {
    month: '2026-05', totalBudget: 0, categoryBudgets: {}, pairKey: 'forged', memberIds: ['x'], updatedBy: 'x'
  });
  const zeroStats = await callAs(B, 'getBillStats', { yearMonth: '2026-05' });
  assert(zeroBudget.success && zeroStats.budget && zeroStats.budget.totalBudget === 0,
    '账单 V2 预算：明确设置 0 合法，且与未设置 budget=null 区分');
  assert(zeroBudget.budget.pairKey === [userAId, userBId].sort().join('|') && zeroBudget.budget.updatedBy === userAId,
    '账单 V2 预算：pairKey/memberIds/updatedBy 均由服务端真实身份生成，客户端伪造无效');

  const savedBudget = await callAs(A, 'saveBillBudget', {
    month: '2026-08', totalBudget: 100, categoryBudgets: { food: 50, shopping: 120 }
  });
  const budgetReadByB = await callAs(B, 'getBillStats', { yearMonth: '2026-08' });
  assert(savedBudget.success && budgetReadByB.budget && budgetReadByB.budget.totalBudget === 100,
    '账单 V2 预算：A 设置后 B 可读取同一份共享预算');
  assert(Object.keys(budgetReadByB.budget.categoryUsage).length === 2 &&
    budgetReadByB.budget.categoryUsage.food.expense === 33.33 && budgetReadByB.budget.categoryUsage.food.availableAmount === 16.67,
    '账单 V2 预算：只生成已设置分类，分类可用额度计算正确');
  assert(budgetReadByB.budget.status === 'available' && budgetReadByB.budget.availableAmount === 66.67,
    '账单 V2 预算：总预算可用额度仅扣除支出，不扣除收入');
  const overspentSave = await callAs(B, 'saveBillBudget', {
    month: '2026-08', totalBudget: 20, categoryBudgets: { food: 10, shopping: 5 }
  });
  const overspentRead = await callAs(A, 'getBillStats', { yearMonth: '2026-08' });
  assert(overspentSave.success && overspentRead.budget.status === 'overspent' &&
    overspentRead.budget.availableAmount === 0 && overspentRead.budget.overspentAmount === 13.33,
    '账单 V2 预算：B 修改后 A 可读取，超支返回正数且可用额度为 0');
  assert(overspentRead.budget.categoryUsage.food.status === 'overspent' &&
    overspentRead.budget.categoryUsage.food.overspentAmount === 23.33,
    '账单 V2 预算：分类超支金额和状态正确，分类预算总和可大于或小于总预算');

  const concurrentFirstBudget = await Promise.all([
    callAs(A, 'saveBillBudget', { month: '2026-09', totalBudget: 1000, categoryBudgets: { food: 100 } }),
    callAs(B, 'saveBillBudget', { month: '2026-09', totalBudget: 2000, categoryBudgets: { shopping: 300 } })
  ]);
  const septemberPairKey = [userAId, userBId].sort().join('|');
  assert(concurrentFirstBudget.every((item) => item.success) &&
    store.bill_budgets.filter((item) => item.pairKey === septemberPairKey && item.month === '2026-09').length === 1,
    '账单 V2 预算并发：双方同时首次设置只产生一条确定性文档');
  const concurrentModifyBudget = await Promise.all([
    callAs(A, 'saveBillBudget', { month: '2026-09', totalBudget: 3000, categoryBudgets: {} }),
    callAs(B, 'saveBillBudget', { month: '2026-09', totalBudget: 4000, categoryBudgets: { gift: 20 } })
  ]);
  const finalSeptember = await callAs(A, 'getBillStats', { yearMonth: '2026-09' });
  assert(concurrentModifyBudget.every((item) => item.success) && [3000, 4000].includes(finalSeptember.budget.totalBudget) &&
    store.bill_budgets.filter((item) => item.pairKey === septemberPairKey && item.month === '2026-09').length === 1,
    '账单 V2 预算并发：同时修改采用最后成功提交且最终只有一份状态');

  const originalBPartnerForBudget = store.users.find((u) => u.openid === B).partnerId;
  store.users.find((u) => u.openid === B).partnerId = '';
  const invalidBindingBills = await callAs(A, 'getBills', { yearMonth: '2026-08' });
  const invalidBindingStats = await callAs(A, 'getBillStats', { yearMonth: '2026-08' });
  const invalidBindingSave = await callAs(A, 'saveBillBudget', { month: '2026-10', totalBudget: 100, categoryBudgets: {} });
  store.users.find((u) => u.openid === B).partnerId = originalBPartnerForBudget;
  assert([invalidBindingBills, invalidBindingStats, invalidBindingSave].every((item) => !item.success && item.code === 'BINDING_INVALID'),
    '账单 V2 权限：双向绑定异常时分页、统计和预算保存统一拒绝');

  // ---------- 解绑事务 ----------
  console.log('\n== 解绑事务 ==');
  const abnormalC = store.users.find((u) => u.openid === C);
  const beforeAbnormalBPartner = store.users.find((u) => u.openid === B).partnerId;
  abnormalC.partnerId = store.users.find((u) => u.openid === B)._id;
  abnormalC.partnerName = '异常关系';
  const repairUnbind = await callAs(C, 'unbind');
  const afterAbnormalBPartner = store.users.find((u) => u.openid === B).partnerId;
  assert(repairUnbind.success && repairUnbind.repaired, '关系异常时解绑：安全清理当前用户');
  assert(!abnormalC.partnerId && afterAbnormalBPartner === beforeAbnormalBPartner,
    '关系异常时解绑：不误解绑对方的有效关系');

  const normalUnbind = await callAs(A, 'unbind');
  assert(normalUnbind.success, '正常双向解绑：请求成功');
  assert(!store.users.find((u) => u.openid === A).partnerId && !store.users.find((u) => u.openid === B).partnerId,
    '正常双向解绑：双方关系同时清空');

  // ---------- 多情侣数据隔离 V1.1 Phase 1 ----------
  console.log('\n== 多情侣数据隔离 V1.1 Phase 1 ==');
  await callAs(K, 'login');
  const userA = store.users.find((u) => u.openid === A);
  const userB = store.users.find((u) => u.openid === B);
  const userC = store.users.find((u) => u.openid === C);
  const userD = store.users.find((u) => u.openid === K);
  await callAs(A, 'bind', { code: userB.bindCode });
  await callAs(C, 'bind', { code: userD.bindCode });
  const pairAB = [userA._id, userB._id].sort().join('|');
  const pairCD = [userC._id, userD._id].sort().join('|');

  const abBill = await callAs(A, 'addBill', {
    type: 'expense', category: 'food', amount: 12, billDate: '2026-08-20',
    pairKey: pairCD, memberIds: [userC._id, userD._id], partnerId: userD._id, creatorId: userC._id
  });
  const cdBill = await callAs(C, 'addBill', { type: 'expense', category: 'food', amount: 13, billDate: '2026-08-20' });
  const abBillRecord = store.bills.find((item) => item._id === abBill.id);
  const cdBillRecord = store.bills.find((item) => item._id === cdBill.id);
  assert(abBillRecord.pairKey === pairAB && deepEqual(abBillRecord.memberIds, [userA._id, userB._id].sort()) && abBillRecord.partnerId === userB._id,
    'PairKey：A 伪造 pairKey/memberIds/partnerId/creatorId 不影响服务端写入 A|B');
  assert(cdBillRecord.pairKey === pairCD && cdBillRecord.partnerId === userD._id,
    'PairKey：C/D 新账单写入独立 pairKey');

  const abReport = await callAs(A, 'createReport', {
    location: 'A地', returnTime: '2026-08-21 20:00', reason: '测试',
    images: [`cloud://test-env/report-images/${A}/ab.jpg`]
  });
  const cdReport = await callAs(C, 'createReport', {
    location: 'C地', returnTime: '2026-08-21 20:00', reason: '测试',
    images: [`cloud://test-env/report-images/${C}/cd.jpg`]
  });
  assert(store.reports.find((item) => item._id === abReport.id).pairKey === pairAB &&
    store.reports.find((item) => item._id === cdReport.id).pairKey === pairCD,
  'PairKey：A/B 与 C/D 新报备写入独立 pairKey');

  const abSchedule = await callAs(A, 'saveSchedule', {
    type: 'todo', title: 'AB循环事项', ownerType: 'couple', repeatType: 'daily',
    repeatStartDate: '2026-08-20', repeatEndDate: '2026-08-22', pairKey: pairCD, partnerId: userD._id
  });
  const cdSchedule = await callAs(C, 'saveSchedule', {
    type: 'todo', title: 'CD循环事项', ownerType: 'couple', repeatType: 'daily',
    repeatStartDate: '2026-08-20', repeatEndDate: '2026-08-22'
  });
  const abScheduleRecord = store.schedules.find((item) => item._id === abSchedule.id);
  const cdScheduleRecord = store.schedules.find((item) => item._id === cdSchedule.id);
  assert(abScheduleRecord.pairKey === pairAB && cdScheduleRecord.pairKey === pairCD,
    'PairKey：A/B 与 C/D 新日程忽略客户端身份并写入独立 pairKey');
  const abToggle = await callAs(A, 'toggleSchedule', { id: abSchedule.id, occurrenceDate: '2026-08-20', completed: true });
  const abCompletion = store.schedule_completions.find((item) => item.scheduleId === abSchedule.id && item.occurrenceDate === '2026-08-20');
  assert(abToggle.success && abCompletion.pairKey === pairAB,
    'PairKey：循环 completion 从已验证父日程继承 A|B');
  const forgedScheduleToggle = await callAs(A, 'toggleSchedule', { id: cdSchedule.id, occurrenceDate: '2026-08-20', completed: true });
  assert(!forgedScheduleToggle.success,
    'PairKey：A 伪造 C/D scheduleId 无法 toggle 新格式日程');

  const cdBudget = await callAs(C, 'saveBillBudget', { month: '2026-11', totalBudget: 88, categoryBudgets: {}, pairKey: pairAB });
  const cdAnniversary = await callAs(C, 'saveAnniversary', { anniversaryDate: '2026-01-01', pairKey: pairAB });
  const cdSettingsRecord = store.couple_settings.find((item) => item.pairKey === pairCD);
  assert(cdBudget.success && cdBudget.budget.pairKey === pairCD && cdAnniversary.success && !!cdSettingsRecord,
    'PairKey：预算和纪念日继续忽略伪造 pairKey');

  const abBudgetBeforeRebind = await callAs(A, 'saveBillBudget', { month: '2026-12', totalBudget: 66, categoryBudgets: {} });
  const abAnniversaryBeforeRebind = await callAs(A, 'saveAnniversary', { anniversaryDate: '2025-01-02' });
  const attackBillList = await callAs(A, 'getBills', { yearMonth: '2026-08', pairKey: pairCD });
  const attackBillDetail = await callAs(A, 'getBillById', { id: cdBill.id });
  const attackBillUpdate = await callAs(A, 'updateBill', { id: cdBill.id, type: 'expense', category: 'food', amount: 99, billDate: '2026-08-20' });
  const attackBillDelete = await callAs(A, 'deleteBill', { id: cdBill.id });
  assert(attackBillList.success && !attackBillList.list.some((item) => item.id === cdBill.id) &&
    [attackBillDetail, attackBillUpdate, attackBillDelete].every((item) => !item.success && item.code === 'ACCESS_DENIED') &&
    store.bills.some((item) => item._id === cdBill.id),
  'Phase 3 Bills：A 无法通过列表、详情、修改、删除或伪造 pairKey 访问 C/D 账单');

  const attackReportList = await callAs(A, 'getReports', { role: '', pairKey: pairCD });
  const tempCallsBeforeCrossPairDetail = tempFileURLCalls.length;
  const attackReportDetail = await callAs(A, 'getReportDetail', { reportId: cdReport.id });
  const attackReportApprove = await callAs(A, 'approveReport', { reportId: cdReport.id, action: 'approve' });
  const attackMessages = await callAs(A, 'getMessages');
  assert(attackReportList.success && !attackReportList.list.some((item) => item._id === cdReport.id) &&
    !attackReportDetail.success && attackReportDetail.code === 'ACCESS_DENIED' && tempFileURLCalls.length === tempCallsBeforeCrossPairDetail &&
    !attackReportApprove.success && attackReportApprove.code === 'ACCESS_DENIED' &&
    attackMessages.success && !attackMessages.list.some((item) => item.reportId === cdReport.id),
  'Phase 3 Reports：A 无法查询、查看、审批 C/D 报备，消息中也不出现 C/D');

  const attackScheduleList = await callAs(A, 'getSchedules', { date: '2026-08-20', pairKey: pairCD });
  const attackScheduleDetail = await callAs(A, 'getScheduleDetail', { id: cdSchedule.id });
  const attackScheduleEdit = await callAs(A, 'saveSchedule', {
    id: cdSchedule.id, type: 'todo', title: '越权', ownerType: 'couple', repeatType: 'daily',
    repeatStartDate: '2026-08-20', repeatEndDate: '2026-08-22'
  });
  const attackScheduleDelete = await callAs(A, 'deleteSchedule', { id: cdSchedule.id });
  assert(attackScheduleList.success && !attackScheduleList.list.some((item) => item.scheduleId === cdSchedule.id) &&
    [attackScheduleDetail, attackScheduleEdit, forgedScheduleToggle, attackScheduleDelete].every((item) =>
      !item.success && item.code === 'ACCESS_DENIED') && store.schedules.some((item) => item._id === cdSchedule.id),
  'Phase 3 Schedules：A 无法查询、查看、编辑、完成或删除 C/D 日程及其 completion');

  const legacyBill = { _id: 'legacy-no-pair-bill', creatorId: userA._id, partnerId: userB._id, amount: 1, billDate: '2026-08-20' };
  const legacyReport = { _id: 'legacy-no-pair-report', creatorId: userA._id, openid: A, partnerId: userB._id, status: 'pending' };
  store.bills.push(legacyBill);
  store.reports.push(legacyReport);
  const legacyBillRead = await callAs(A, 'getBillById', { id: legacyBill._id });
  const legacyBillUpdate = await callAs(A, 'updateBill', { id: legacyBill._id, type: 'expense', category: 'food', amount: 2, billDate: '2026-08-20' });
  const legacyBillDelete = await callAs(A, 'deleteBill', { id: legacyBill._id });
  const legacyReportRead = await callAs(A, 'getReportDetail', { reportId: legacyReport._id });
  const legacyReportApprove = await callAs(B, 'approveReport', { reportId: legacyReport._id, action: 'approve' });
  assert([legacyBillRead, legacyBillUpdate, legacyBillDelete, legacyReportRead, legacyReportApprove].every((item) =>
    !item.success && item.code === 'DATA_ISOLATION_ERROR'),
  'Phase 3 Legacy：缺少 pairKey 的 bill/report 正式详情与操作统一拒绝');

  const phaseLegacySchedule = {
    _id: 'legacy-no-pair-schedule', creatorId: userA._id, creatorName: 'A', type: 'todo', title: '旧事项',
    ownerType: 'couple', repeatType: 'none', date: '2026-08-23', completed: false
  };
  store.schedules.push(phaseLegacySchedule);
  const legacyEdit = await callAs(A, 'saveSchedule', {
    id: phaseLegacySchedule._id, type: 'todo', title: '旧事项编辑', ownerType: 'couple', repeatType: 'none', date: '2026-08-23'
  });
  const legacyScheduleDetail = await callAs(A, 'getScheduleDetail', { id: phaseLegacySchedule._id });
  const legacyScheduleToggle = await callAs(A, 'toggleSchedule', { id: phaseLegacySchedule._id, completed: true });
  const legacyScheduleDelete = await callAs(A, 'deleteSchedule', { id: phaseLegacySchedule._id });
  assert([legacyEdit, legacyScheduleDetail, legacyScheduleToggle, legacyScheduleDelete].every((item) =>
    !item.success && item.code === 'DATA_ISOLATION_ERROR') &&
    !store.schedules.find((item) => item._id === phaseLegacySchedule._id).pairKey,
  'PairKey：缺少 pairKey 的旧日程拒绝详情、编辑、完成和删除且不会危险回填');

  await callAs(A, 'unbind');
  await callAs(C, 'unbind');
  await callAs(A, 'bind', { code: userC.bindCode });
  const pairAC = [userA._id, userC._id].sort().join('|');
  const bannersAfterRebind = await callAs(A, 'getSharedBanners');
  const acBanner = 'cloud://test-env/banners/openid-AAA/ac.jpg';
  const createAcBanner = await callAs(A, 'updateBanners', { action: 'add', fileIDs: [acBanner] });
  const acBannersForC = await callAs(C, 'getSharedBanners');
  const acBannersForB = await callAs(B, 'getSharedBanners');
  assert(bannersAfterRebind.success && bannersAfterRebind.banners.length === 0 && createAcBanner.success &&
    acBannersForC.success && deepEqual(acBannersForC.banners, [acBanner]) &&
    !acBannersForB.success && acBannersForB.code === 'NOT_BOUND',
    'Phase 4A Rebind：A/C 不读取 A/B Banner，可创建自己的 Banner，解绑后的 B 不能读取 A/C');

  const oldAbBillForProfile = store.bills.find((item) => item._id === abBill.id);
  const oldAbReportForProfile = store.reports.find((item) => item._id === abReport.id);
  const oldAbBillName = oldAbBillForProfile.creatorName;
  const oldAbReportName = oldAbReportForProfile.creatorName;
  await callAs(A, 'updateProfile', { nickName: 'A重绑后昵称' });
  assert(oldAbBillForProfile.creatorName === oldAbBillName && oldAbReportForProfile.creatorName === oldAbReportName,
    'Phase 4A Rebind：A 修改昵称不会改写旧 A/B bills/reports 快照');
  const acBill = await callAs(A, 'addBill', { type: 'expense', category: 'other', amount: 21, billDate: '2026-08-24' });
  const acSchedule = await callAs(A, 'saveSchedule', { type: 'todo', title: 'AC事项', ownerType: 'couple', repeatType: 'none', date: '2026-08-24' });
  const acReport = await callAs(A, 'createReport', { location: 'AC地', returnTime: '2026-08-24 20:00', reason: '测试' });
  assert(store.bills.find((item) => item._id === acBill.id).pairKey === pairAC &&
    store.schedules.find((item) => item._id === acSchedule.id).pairKey === pairAC &&
    store.reports.find((item) => item._id === acReport.id).pairKey === pairAC && pairAC !== pairAB,
  'PairKey：A/B 解绑后 A/C 新账单、日程、报备全部切换为 A|C');
  const acBillsForA = await callAs(A, 'getBills', { yearMonth: '2026-08' });
  const acBillsForC = await callAs(C, 'getBills', { yearMonth: '2026-08' });
  const acReportsForA = await callAs(A, 'getReports', { role: '' });
  const acReportsForC = await callAs(C, 'getReports', { role: '' });
  const acSchedulesForA = await callAs(A, 'getSchedules', { date: '2026-08-24' });
  const acSchedulesForC = await callAs(C, 'getSchedules', { date: '2026-08-24' });
  const oldBudgetAfterRebind = await callAs(A, 'getBillStats', { yearMonth: '2026-12' });
  const oldAnniversaryAfterRebind = await callAs(A, 'getCoupleSettings');
  const oldBillAfterRebind = await callAs(A, 'getBillById', { id: abBill.id });
  const oldReportAfterRebind = await callAs(A, 'getReportDetail', { reportId: abReport.id });
  const oldScheduleAfterRebind = await callAs(A, 'getScheduleDetail', { id: abSchedule.id });
  const bReadsAc = await Promise.all([
    callAs(B, 'getBillById', { id: acBill.id }),
    callAs(B, 'getReportDetail', { reportId: acReport.id }),
    callAs(B, 'getScheduleDetail', { id: acSchedule.id })
  ]);
  assert(abBudgetBeforeRebind.success && abAnniversaryBeforeRebind.success &&
    acBillsForA.list.some((item) => item.id === acBill.id) && acBillsForC.list.some((item) => item.id === acBill.id) &&
    !acBillsForA.list.some((item) => item.id === abBill.id) &&
    acReportsForA.list.some((item) => item._id === acReport.id) && acReportsForC.list.some((item) => item._id === acReport.id) &&
    !acReportsForA.list.some((item) => item._id === abReport.id) &&
    acSchedulesForA.list.some((item) => item.scheduleId === acSchedule.id) && acSchedulesForC.list.some((item) => item.scheduleId === acSchedule.id) &&
    !acSchedulesForA.list.some((item) => item.scheduleId === abSchedule.id) &&
    oldBudgetAfterRebind.budget === null && (!oldAnniversaryAfterRebind.settings || !oldAnniversaryAfterRebind.settings.anniversaryDate),
  'Phase 3 Rebind：A/C 共享新数据且看不到 A/B 的账单、报备、日程、预算和纪念日');
  assert([oldBillAfterRebind, oldReportAfterRebind, oldScheduleAfterRebind].every((item) =>
    !item.success && item.code === 'ACCESS_DENIED') && bReadsAc.every((item) => !item.success),
  'Phase 3 Rebind：旧关系 ID 访问被拒绝，B 也无法读取 A/C 新共享数据');

  const migrationAudit = require('./audit_pairkey_migration');
  const migrationConfig = {
    knownPairs: [
      { memberIds: [userA._id, userB._id], pairKey: pairAB },
      { memberIds: [userC._id, userD._id], pairKey: pairCD }
    ],
    legacyScheduleOwnership: { [userA._id]: pairAB }
  };
  const dryRun = migrationAudit.analyzeMigration({
    bills: [
      { _id: 'b-safe', creatorId: userA._id, partnerId: userB._id },
      { _id: 'b-manual', creatorId: userA._id },
      { _id: 'b-done', creatorId: userA._id, partnerId: userB._id, pairKey: pairAB, memberIds: [userA._id, userC._id] }
    ],
    reports: [{ _id: 'r-safe', creatorId: userC._id, partnerId: userD._id }],
    schedules: [
      { _id: 's-safe', creatorId: userA._id },
      { _id: 's-manual', creatorId: userC._id },
      { _id: 's-done', creatorId: userA._id, pairKey: pairAB, memberIds: [userA._id, userB._id] }
    ],
    schedule_completions: [
      { _id: 'c-safe', scheduleId: 's-safe' },
      { _id: 'c-manual', scheduleId: 's-manual' },
      { _id: 'c-done', scheduleId: 's-done', pairKey: pairAB, memberIds: [userA._id, userB._id] },
      { _id: 'c-orphan', scheduleId: 'missing' }
    ],
    bill_budgets: [
      { _id: 'budget-1', pairKey: pairAB, memberIds: [userA._id, userB._id], month: '2026-01' },
      { _id: 'budget-2', pairKey: pairAB, memberIds: [userA._id, userB._id], month: '2026-01' }
    ],
    couple_settings: [{ _id: 'settings-bad', pairKey: pairAB, memberIds: [userA._id, userC._id] }]
  }, migrationConfig);
  assert(dryRun.report.autoSafe.bills.some((item) => item._id === 'b-safe') &&
    dryRun.report.manualReview.bills.some((item) => item._id === 'b-manual') &&
    dryRun.report.autoSafe.reports.some((item) => item._id === 'r-safe'),
  'PairKey migration：bill/report 仅在记录参与者命中 knownPairs 时 AUTO_SAFE');
  assert(dryRun.report.autoSafe.schedules.some((item) => item._id === 's-safe') &&
    dryRun.report.manualReview.schedules.some((item) => item._id === 's-manual'),
  'PairKey migration：旧 schedule 只有显式 legacyScheduleOwnership 才 AUTO_SAFE');
  assert(dryRun.report.autoSafe.schedule_completions.some((item) => item._id === 'c-safe') &&
    dryRun.report.manualReview.schedule_completions.some((item) => item._id === 'c-manual') &&
    dryRun.report.manualReview.schedule_completions.some((item) => item._id === 'c-orphan'),
  'PairKey migration：completion 继承可信父日程，不确定或缺失父日程进入 MANUAL_REVIEW');
  assert(dryRun.report.alreadyMigrated.bills.some((item) => item._id === 'b-done') &&
    dryRun.report.alreadyMigrated.schedule_completions.some((item) => item._id === 'c-done'),
  'PairKey migration：已有 pairKey 的记录识别为 ALREADY_MIGRATED');
  assert(dryRun.report.warnings.some((item) => item.code === 'PAIRKEY_MEMBERIDS_MISMATCH') &&
    dryRun.report.warnings.some((item) => item.code === 'DUPLICATE_PAIR_MONTH_BUDGET') &&
    dryRun.report.warnings.some((item) => item.code === 'COMPLETION_PARENT_NOT_FOUND'),
  'PairKey migration：已有字段不一致、预算重复和孤儿 completion 均输出 WARN');
  assert(dryRun.patch.bills.length === 1 && dryRun.patch.bills[0].set.pairKey === pairAB &&
    dryRun.patch.schedules.length === 1 && dryRun.patch.schedule_completions.length === 1,
  'PairKey migration patch：只包含 AUTO_SAFE，completion 只补 pairKey');
  assert(migrationAudit.unwrapRecords([{ _id: 1 }]).length === 1 &&
    migrationAudit.unwrapRecords({ data: [{ _id: 1 }] }).length === 1 &&
    migrationAudit.unwrapRecords({ records: [{ _id: 1 }] }).length === 1,
  'PairKey migration 输入：兼容数组、data 和 records 三种导出包装');

  const conflict = migrationAudit.analyzeMigration({ bills: [{ _id: 'blocked', creatorId: userA._id, partnerId: userB._id }] }, {
    knownPairs: [
      { memberIds: [userA._id, userB._id], pairKey: pairAB },
      { memberIds: [userA._id, userC._id], pairKey: pairAC }
    ]
  });
  assert(conflict.report.patchBlocked && conflict.report.warnings.some((item) => item.code === 'USER_IN_MULTIPLE_KNOWN_PAIRS') && conflict.patch.bills.length === 0,
    'PairKey migration 配置：用户出现在多个 knownPair 时 WARN 并拒绝生成 patch');

  // ---------- 多情侣数据隔离 V1.1 Phase 2：一次性迁移云函数 ----------
  const migrationCollections = ['bills', 'reports', 'schedules', 'schedule_completions'];
  const originalMigrationData = {};
  migrationCollections.forEach((name) => { originalMigrationData[name] = store[name]; });
  function setMigrationData(overrides) {
    store.bills = [{ _id: 'mb-1', creatorId: userA._id, partnerId: userC._id, type: 'expense', amount: 12.34, note: '不变' }];
    store.reports = [{ _id: 'mr-1', creatorId: userC._id, partnerId: userA._id, status: 'pending', reason: '不变' }];
    store.schedules = [{ _id: 'ms-1', creatorId: userA._id, repeatType: 'daily', title: '不变' }];
    store.schedule_completions = [{ _id: 'mc-1', scheduleId: 'ms-1', completedBy: userC._id }];
    Object.keys(overrides || {}).forEach((name) => { store[name] = overrides[name]; });
  }

  setMigrationData();
  const identityFailureData = JSON.stringify(migrationCollections.map((name) => store[name]));
  const noOpenidMigration = await callAs(undefined, 'migratePairKey', { mode: 'dryRun' });
  const missingUserMigration = await callAs('migration-missing-user', 'migratePairKey', { mode: 'dryRun' });
  const identityFixtures = [
    { _id: 'migration-unbound', openid: 'migration-unbound-openid', partnerId: '' },
    { _id: 'migration-missing-partner', openid: 'migration-missing-partner-openid', partnerId: 'migration-absent' },
    { _id: 'migration-one-way-a', openid: 'migration-one-way-openid', partnerId: 'migration-one-way-b' },
    { _id: 'migration-one-way-b', openid: 'migration-one-way-partner-openid', partnerId: '' }
  ];
  store.users.push(...identityFixtures);
  const unboundMigration = await callAs('migration-unbound-openid', 'migratePairKey', { mode: 'dryRun' });
  const missingPartnerMigration = await callAs('migration-missing-partner-openid', 'migratePairKey', { mode: 'dryRun' });
  const invalidBindingMigration = await callAs('migration-one-way-openid', 'migratePairKey', { mode: 'dryRun' });
  store.users.splice(store.users.length - identityFixtures.length, identityFixtures.length);
  assert(noOpenidMigration.code === 'NO_OPENID' && missingUserMigration.code === 'USER_NOT_FOUND' &&
    unboundMigration.code === 'NOT_BOUND' && missingPartnerMigration.code === 'PARTNER_NOT_FOUND' &&
    invalidBindingMigration.code === 'BINDING_INVALID' &&
    JSON.stringify(migrationCollections.map((name) => store[name])) === identityFailureData,
  'migratePairKey：OPENID、用户、未绑定、伴侣缺失和非双向绑定均明确拒绝且不扫描写入');

  setMigrationData();
  const beforeDryRun = JSON.stringify(migrationCollections.map((name) => store[name]));
  const migrationDryRun = await callAs(A, 'migratePairKey', { mode: 'dryRun', pairKey: pairAB, memberIds: [userA._id, userB._id] });
  assert(migrationDryRun.success && migrationDryRun.mode === 'dryRun' && migrationDryRun.pairKey === pairAC &&
    migrationDryRun.summary.bills.toMigrate === 1 && migrationDryRun.summary.reports.toMigrate === 1 &&
    migrationDryRun.summary.schedules.toMigrate === 1 && migrationDryRun.summary.scheduleCompletions.toMigrate === 1 &&
    JSON.stringify(migrationCollections.map((name) => store[name])) === beforeDryRun,
  'migratePairKey：dryRun 使用真实当前情侣、识别全部旧数据且完全不写数据库');

  setMigrationData({ bills: [{ _id: 'bad-bill', creatorId: userA._id, partnerId: userB._id }] });
  const blockedBill = await callAs(A, 'migratePairKey', { mode: 'apply', confirm: 'MIGRATE', collection: 'bills' });
  setMigrationData({ reports: [{ _id: 'bad-report', creatorId: userA._id, partnerId: userB._id }] });
  const blockedReport = await callAs(A, 'migratePairKey', { mode: 'apply', confirm: 'MIGRATE', collection: 'reports' });
  setMigrationData({ schedules: [{ _id: 'bad-schedule', creatorId: userB._id }], schedule_completions: [] });
  const blockedSchedule = await callAs(A, 'migratePairKey', { mode: 'apply', confirm: 'MIGRATE', collection: 'schedules' });
  setMigrationData({ schedule_completions: [{ _id: 'orphan', scheduleId: 'missing' }] });
  const blockedCompletion = await callAs(A, 'migratePairKey', { mode: 'apply', confirm: 'MIGRATE', collection: 'schedule_completions' });
  assert([blockedBill, blockedReport, blockedSchedule, blockedCompletion].every((item) =>
    !item.success && item.code === 'MIGRATION_BLOCKED'),
  'migratePairKey：非当前情侣 bill/report、未知 schedule creator、孤儿 completion 全部阻止 apply');

  setMigrationData();
  const missingConfirm = await callAs(A, 'migratePairKey', { mode: 'apply' });
  const wrongConfirm = await callAs(A, 'migratePairKey', { mode: 'apply', confirm: 'WRONG' });
  assert([missingConfirm, wrongConfirm].every((item) => !item.success && item.code === 'CONFIRM_REQUIRED') &&
    store.bills[0].pairKey === undefined,
  'migratePairKey：apply 缺少或错误 confirm 时不扫描写入');
  const missingCollection = await callAs(A, 'migratePairKey', { mode: 'apply', confirm: 'MIGRATE' });
  assert(!missingCollection.success && missingCollection.code === 'APPLY_COLLECTION_REQUIRED' && store.bills[0].pairKey === undefined,
    'migratePairKey：分批 apply 必须指定受支持的 collection');

  setMigrationData({
    reports: Array.from({ length: 11 }, (_, index) => ({
      _id: `mr-batch-${index}`, creatorId: userC._id, partnerId: userA._id, status: 'pending', reason: `不变-${index}`
    }))
  });
  const businessBeforeApply = {
    bill: { type: store.bills[0].type, amount: store.bills[0].amount, note: store.bills[0].note },
    report: { status: store.reports[0].status, reason: store.reports[0].reason },
    schedule: { title: store.schedules[0].title, repeatType: store.schedules[0].repeatType },
    completion: { scheduleId: store.schedule_completions[0].scheduleId, completedBy: store.schedule_completions[0].completedBy }
  };
  const billBatch = await callAs(A, 'migratePairKey', { mode: 'apply', confirm: 'MIGRATE', collection: 'bills', pairKey: pairAB, partnerId: userB._id });
  const reportBatch1 = await callAs(A, 'migratePairKey', { mode: 'apply', confirm: 'MIGRATE', collection: 'reports' });
  const reportBatch2 = await callAs(A, 'migratePairKey', { mode: 'apply', confirm: 'MIGRATE', collection: 'reports' });
  const scheduleBatch = await callAs(A, 'migratePairKey', { mode: 'apply', confirm: 'MIGRATE', collection: 'schedules' });
  const completionBatch = await callAs(A, 'migratePairKey', { mode: 'apply', confirm: 'MIGRATE', collection: 'schedule_completions' });
  const migrationVerification = await callAs(A, 'migratePairKey', { mode: 'dryRun' });
  assert(billBatch.success && billBatch.done && reportBatch1.success && reportBatch1.updated === 10 && !reportBatch1.done &&
    reportBatch1.batchLimit === 10 && reportBatch2.success && reportBatch2.updated === 1 && reportBatch2.done &&
    scheduleBatch.success && completionBatch.success && migrationVerification.success &&
    Object.values(migrationVerification.summary).every((item) => item.toMigrate === 0 && item.errors === 0) &&
    store.bills[0].pairKey === pairAC && deepEqual(store.bills[0].memberIds, [userA._id, userC._id].sort()) &&
    store.reports.every((item) => item.pairKey === pairAC) && store.schedules[0].pairKey === pairAC &&
    store.schedule_completions[0].pairKey === pairAC,
  'migratePairKey：单次最多10条，按集合续跑后由最终 dryRun 确认全部迁移');
  assert(deepEqual(businessBeforeApply, {
    bill: { type: store.bills[0].type, amount: store.bills[0].amount, note: store.bills[0].note },
    report: { status: store.reports[0].status, reason: store.reports[0].reason },
    schedule: { title: store.schedules[0].title, repeatType: store.schedules[0].repeatType },
    completion: { scheduleId: store.schedule_completions[0].scheduleId, completedBy: store.schedule_completions[0].completedBy }
  }), 'migratePairKey：apply 不修改任何业务字段');

  const secondDryRun = await callAs(C, 'migratePairKey', { mode: 'dryRun' });
  const secondApplyResults = [];
  for (const collection of migrationCollections) {
    secondApplyResults.push(await callAs(C, 'migratePairKey', { mode: 'apply', confirm: 'MIGRATE', collection }));
  }
  assert(secondDryRun.success && secondDryRun.summary.bills.toMigrate === 0 &&
    secondApplyResults.every((item) => item.success && item.done && item.updated === 0),
  'migratePairKey：第二次 dryRun/apply 均幂等，不覆盖已有 pairKey');
  migrationCollections.forEach((name) => { store[name] = originalMigrationData[name]; });

  // ---------- 汇总 ----------
  console.log('\n================ 测试结果 ================');
  console.log('通过: ' + pass + ' 项，失败: ' + fail + ' 项');
  if (fail > 0) { process.exit(1); }
  console.log('云函数核心逻辑全部通过 🎉');
})().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
