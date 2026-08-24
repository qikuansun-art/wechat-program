// scripts/test_cloudfunctions.js —— 云函数逻辑测试（本地模拟云环境）
// 原理：用假的 wx-server-sdk（内存数据库）替换真 SDK，直接 require 云函数源码执行，
//       模拟用户 A / B / 陌生人 C 走完整业务流程，验证核心逻辑正确性。
const path = require('path');
const Module = require('module');

// ============================================================
// 1. 内存数据库 + mock wx-server-sdk
// ============================================================
const store = { users: [], reports: [], bills: [], subscriptions: [] };
let autoId = 0;
const nextId = () => 'id-' + (++autoId);
let currentOpenid = '';
let transactionTail = Promise.resolve();
let transactionFailAfterWrites = null;

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
  return Object.keys(query).every((key) => {
    const cond = query[key];
    if (cond && cond.__in) return cond.__in.indexOf(doc[key]) >= 0;
    if (cond && cond.__regex) return new RegExp(cond.__regex).test(String(doc[key]));
    return deepEqual(doc[key], cond);
  });
}

function makeCollection(name) {
  const coll = {
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
    const chained = {
      orderBy(field, dir) { sorts.push({ field, dir }); return chained; },
      limit(n) { limited = n; return chained; },
      async get() {
        const base = origWhere2(query);
        const res = await base.get();
        let data = res.data.slice();
        sorts.forEach(({ field, dir }) => {
          data.sort((x, y) =>
            dir === 'desc' ? String(y[field]).localeCompare(String(x[field])) : String(x[field]).localeCompare(String(y[field])));
        });
        return { data: data.slice(0, limited) };
      }
    };
    return chained;
  };
  return coll;
}

// 记录云函数间调用（sendNotify）
const notifyCalls = [];

const mockCloud = {
  DYNAMIC_CURRENT_ENV: Symbol('env'),
  init() {},
  getWXContext() { return { OPENID: currentOpenid }; },
  database() {
    const database = {
      collection: makeCollection,
      serverDate() { return new Date('2026-08-19T10:00:00+08:00'); },
      command: {
        in(arr) { return { __in: arr }; },
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
          return { result, errMsg: 'runTransaction:ok' };
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
    notifyCalls.push({ name, data });
    return { result: { success: true } };
  },
  openapi: { subscribeMessage: { send: async () => ({ msgid: 'mock' }) } }
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

  // ---------- 登录 ----------
  console.log('\n== 登录 ==');
  const loginA1 = await callAs(A, 'login');
  assert(loginA1.success && loginA1.userInfo.bindCode, 'A 首次登录：注册成功并生成邀请码');
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

  // ---------- 发起报备 ----------
  console.log('\n== 发起报备 ==');
  const noLoc = await callAs(A, 'createReport', { reason: 'x', returnTime: '今晚10点' });
  assert(!noLoc.success, '缺外出地点：被拒绝');
  const reportRes = await callAs(A, 'createReport', {
    location: '万达影城', companions: '闺蜜', returnTime: '22:00', reason: '看电影'
  });
  assert(reportRes.success, 'A 发起报备：成功');
  const report = store.reports.find((r) => r._id === reportRes.id);
  assert(report && report.status === 'pending' && report.partnerId === usersB._id, '报备落库：待审批 + 审批人指向 B');
  assert(notifyCalls.some((n) => n.name === 'sendNotify' && n.data.type === 'new_report'), '新报备：触发给 B 的订阅消息');

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
  assert(notifyCalls.some((n) => n.data.type === 'approve_result' && n.data.toOpenid === A), '审批结果：触发给 A 的订阅消息');
  const again = await callAs(B, 'approveReport', { reportId: reportRes.id, action: 'approve' });
  assert(!again.success && again.msg.indexOf('已被处理') >= 0, '同一报备重复审批：返回明确业务结果');

  const concurrentReport = await callAs(A, 'createReport', {
    location: '并发测试', returnTime: '21:00', reason: '验证原子审批'
  });
  const notifyBeforeConcurrentApprove = notifyCalls.filter((n) => n.data.type === 'approve_result').length;
  const concurrentApprove = await Promise.all([
    callAs(B, 'approveReport', { reportId: concurrentReport.id, action: 'approve' }),
    callAs(B, 'approveReport', { reportId: concurrentReport.id, action: 'reject', reason: '并发驳回' })
  ]);
  const notifyAfterConcurrentApprove = notifyCalls.filter((n) => n.data.type === 'approve_result').length;
  assert(concurrentApprove.filter((r) => r.success).length === 1, '两个并发审批请求：只有一个成功');
  assert(concurrentApprove.filter((r) => !r.success && r.msg.indexOf('已被处理') >= 0).length === 1,
    '并发审批失败方：返回已处理的业务结果');
  assert(notifyAfterConcurrentApprove - notifyBeforeConcurrentApprove === 1,
    '并发审批：只有真正更新状态的请求发送通知');

  // 再走一条批准流程
  const r2 = await callAs(B, 'createReport', { location: '公司团建', returnTime: '20:00', reason: '聚餐' });
  const approveOk = await callAs(A, 'approveReport', { reportId: r2.id, action: 'approve' });
  const report2 = store.reports.find((x) => x._id === r2.id);
  assert(approveOk.success && report2.status === 'approved', 'B 发报备、A 批准：反向流程成功');

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

  // ---------- 汇总 ----------
  console.log('\n================ 测试结果 ================');
  console.log('通过: ' + pass + ' 项，失败: ' + fail + ' 项');
  if (fail > 0) { process.exit(1); }
  console.log('云函数核心逻辑全部通过 🎉');
})().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
