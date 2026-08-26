'use strict';

// ONE-TIME MIGRATION TOOL.
// Delete this cloud function (or permanently disable apply) after migration verification
// and the production read paths have switched to mandatory pairKey queries.
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const PAGE_SIZE = 100;
const BATCH_SIZE = 10;
const COLLECTIONS = ['bills', 'reports', 'schedules', 'schedule_completions'];

function buildPairKey(memberIds) { return memberIds.slice().sort().join('|'); }
function sameMembers(value, memberIds) {
  return Array.isArray(value) && value.length === 2 && buildPairKey(value.map(String)) === buildPairKey(memberIds);
}
function withoutTenantFields(record) {
  const copy = Object.assign({}, record);
  delete copy.pairKey;
  delete copy.memberIds;
  return JSON.stringify(copy);
}
async function getCurrentPair(openid) {
  if (typeof openid !== 'string' || !openid.trim()) {
    return { error: { success: false, code: 'NO_OPENID', msg: '当前调用环境没有用户 OPENID，请从小程序登录态调用' } };
  }
  const users = db.collection('users');
  const meRes = await users.where({ openid: openid.trim() }).limit(2).get();
  if (!meRes.data || meRes.data.length === 0) return { error: { success: false, code: 'USER_NOT_FOUND', msg: '当前 OPENID 对应的用户不存在' } };
  if (meRes.data.length !== 1) return { error: { success: false, code: 'USER_CONFLICT', msg: '当前 OPENID 对应多条用户记录' } };
  const me = meRes.data[0];
  if (!me || typeof me._id !== 'string' || !me._id) return { error: { success: false, code: 'USER_INVALID', msg: '当前用户记录缺少有效 _id' } };
  if (typeof me.partnerId !== 'string' || !me.partnerId) return { error: { success: false, code: 'NOT_BOUND', msg: '当前用户未绑定伴侣' } };
  const partnerRes = await users.where({ _id: me.partnerId }).limit(2).get();
  if (!partnerRes.data || partnerRes.data.length === 0) return { error: { success: false, code: 'PARTNER_NOT_FOUND', msg: '绑定的伴侣用户不存在' } };
  if (partnerRes.data.length !== 1) return { error: { success: false, code: 'PARTNER_CONFLICT', msg: '伴侣 ID 对应多条用户记录' } };
  const partner = partnerRes.data[0];
  if (!partner || typeof partner._id !== 'string' || !partner._id || partner.partnerId !== me._id) {
    return { error: { success: false, code: 'BINDING_INVALID', msg: '双方不是有效的双向绑定关系' } };
  }
  const memberIds = [me._id, partner._id].sort();
  return { me, partner, memberIds, pairKey: buildPairKey(memberIds) };
}
async function readCollection(name) {
  const list = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const result = await db.collection(name).where({}).orderBy('_id', 'asc').skip(offset).limit(PAGE_SIZE).get();
    const page = result.data || [];
    list.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return list;
}
function emptyPlan() {
  return {
    bills: [], reports: [], schedules: [], schedule_completions: []
  };
}
function addError(errors, collection, record, code, message) {
  errors.push({ collection, _id: record && record._id || '', code, message });
}
function validateExisting(collection, record, pair, errors, requireMembers) {
  if (record.pairKey !== pair.pairKey) {
    addError(errors, collection, record, 'PAIRKEY_CONFLICT', '已有 pairKey 与当前历史情侣不一致');
    return false;
  }
  if (requireMembers && !sameMembers(record.memberIds, pair.memberIds)) {
    addError(errors, collection, record, 'MEMBERIDS_CONFLICT', '已有 memberIds 与当前历史情侣不一致');
    return false;
  }
  return true;
}
function buildScan(data, pair) {
  const plan = emptyPlan();
  const already = emptyPlan();
  const errors = [];
  const schedulesById = new Map();
  const fingerprints = {};
  COLLECTIONS.forEach((name) => {
    fingerprints[name] = new Map((data[name] || []).map((item) => [item._id, withoutTenantFields(item)]));
  });

  ['bills', 'reports'].forEach((name) => (data[name] || []).forEach((record) => {
    if (record.pairKey) {
      if (validateExisting(name, record, pair, errors, true)) already[name].push(record._id);
    } else if (!record.creatorId || !record.partnerId || buildPairKey([String(record.creatorId), String(record.partnerId)]) !== pair.pairKey) {
      addError(errors, name, record, 'PARTICIPANTS_MISMATCH', 'creatorId + partnerId 不属于当前历史情侣');
    } else plan[name].push({ _id: record._id, set: { pairKey: pair.pairKey, memberIds: pair.memberIds } });
  }));

  (data.schedules || []).forEach((record) => {
    let finalPairKey = record.pairKey || '';
    if (record.pairKey) {
      if (validateExisting('schedules', record, pair, errors, true)) already.schedules.push(record._id);
    } else if (!pair.memberIds.includes(String(record.creatorId))) {
      addError(errors, 'schedules', record, 'UNKNOWN_CREATOR', 'creatorId 不属于当前历史情侣');
    } else {
      finalPairKey = pair.pairKey;
      plan.schedules.push({ _id: record._id, set: { pairKey: pair.pairKey, memberIds: pair.memberIds } });
    }
    schedulesById.set(record._id, finalPairKey);
  });

  (data.schedule_completions || []).forEach((record) => {
    if (record.pairKey) {
      if (validateExisting('schedule_completions', record, pair, errors, false)) already.schedule_completions.push(record._id);
      return;
    }
    const parentPairKey = schedulesById.get(record.scheduleId);
    if (!parentPairKey) addError(errors, 'schedule_completions', record, 'PARENT_NOT_FOUND', '父 schedule 不存在或无法确认归属');
    else if (parentPairKey !== pair.pairKey) addError(errors, 'schedule_completions', record, 'PARENT_PAIRKEY_CONFLICT', '父 schedule 不属于当前历史情侣');
    else plan.schedule_completions.push({ _id: record._id, set: { pairKey: pair.pairKey } });
  });

  const summary = {};
  COLLECTIONS.forEach((name) => {
    const key = name === 'schedule_completions' ? 'scheduleCompletions' : name;
    summary[key] = {
      total: (data[name] || []).length,
      alreadyMigrated: already[name].length,
      toMigrate: plan[name].length,
      errors: errors.filter((item) => item.collection === name).length
    };
  });
  return { plan, already, errors, summary, fingerprints };
}
async function scan(pair) {
  const data = {};
  for (const name of COLLECTIONS) data[name] = await readCollection(name);
  return Object.assign({ data }, buildScan(data, pair));
}
async function scanTarget(pair, collection) {
  const data = {};
  COLLECTIONS.forEach((name) => { data[name] = []; });
  data[collection] = await readCollection(collection);
  if (collection === 'schedule_completions') data.schedules = await readCollection('schedules');
  return Object.assign({ data }, buildScan(data, pair));
}
function validateForWrite(collection, record, pair) {
  if (record.pairKey) {
    if (!validateExisting(collection, record, pair, [], collection !== 'schedule_completions')) throw new Error('记录在迁移期间出现租户字段冲突');
    return null;
  }
  if (collection === 'bills' || collection === 'reports') {
    if (!record.creatorId || !record.partnerId || buildPairKey([String(record.creatorId), String(record.partnerId)]) !== pair.pairKey) throw new Error('记录参与者在迁移期间发生变化');
    return { pairKey: pair.pairKey, memberIds: pair.memberIds };
  }
  if (collection === 'schedules') {
    if (!pair.memberIds.includes(String(record.creatorId))) throw new Error('schedule 创建者在迁移期间发生变化');
    return { pairKey: pair.pairKey, memberIds: pair.memberIds };
  }
  return { pairKey: pair.pairKey };
}
async function updateOne(collection, item, pair) {
  const transactionResult = await db.runTransaction(async (transaction) => {
    const ref = transaction.collection(collection).doc(item._id);
    const result = await ref.get();
    if (!result || !result.data) throw new Error('待迁移记录已不存在');
    const set = validateForWrite(collection, result.data, pair);
    if (set) await ref.update({ data: set });
    return { updated: !!set };
  });
  return transactionResult && transactionResult.result
    ? transactionResult.result
    : transactionResult;
}
async function applyBatch(plan, collection, pair) {
  const batch = plan[collection].slice(0, BATCH_SIZE);
  const results = await Promise.all(batch.map((item) => updateOne(collection, item, pair)));
  return results.filter((item) => item && item.updated).length;
}
function verify(before, after, updated) {
  const errors = after.errors.slice();
  COLLECTIONS.forEach((name) => {
    const key = name === 'schedule_completions' ? 'scheduleCompletions' : name;
    if (after.summary[key].total !== before.summary[key].total) addError(errors, name, null, 'COUNT_CHANGED', '迁移前后记录总数不一致');
    if (after.summary[key].toMigrate !== 0) addError(errors, name, null, 'MIGRATION_REMAINS', '迁移后仍有未补齐记录');
    if (updated[key] !== before.summary[key].toMigrate) addError(errors, name, null, 'UPDATED_COUNT_MISMATCH', '计划数量与实际更新数量不一致');
    const beforePrints = before.fingerprints[name];
    const afterPrints = after.fingerprints[name];
    beforePrints.forEach((fingerprint, id) => {
      if (afterPrints.get(id) !== fingerprint) addError(errors, name, { _id: id }, 'BUSINESS_FIELD_CHANGED', '迁移修改了租户字段之外的业务字段');
    });
  });
  return { verified: errors.length === 0, errors };
}

exports.main = async (event = {}) => {
  const mode = event.mode === 'apply' ? 'apply' : 'dryRun';
  if (mode === 'apply' && event.confirm !== 'MIGRATE') {
    return { success: false, code: 'CONFIRM_REQUIRED', msg: 'apply 必须明确确认 MIGRATE' };
  }
  if (mode === 'apply' && !COLLECTIONS.includes(event.collection)) {
    return { success: false, mode, code: 'APPLY_COLLECTION_REQUIRED', msg: 'apply 必须指定允许的 collection' };
  }
  try {
    const context = cloud.getWXContext() || {};
    const pair = await getCurrentPair(context.OPENID);
    if (pair.error) return pair.error;
    if (mode === 'dryRun') {
      const before = await scan(pair);
      return { success: true, mode, pairKey: pair.pairKey, memberIds: pair.memberIds, summary: before.summary, errors: before.errors };
    }
    const target = await scanTarget(pair, event.collection);
    if (target.errors.length) {
      return { success: false, mode, code: 'MIGRATION_BLOCKED', collection: event.collection, pairKey: pair.pairKey, summary: target.summary, errors: target.errors };
    }
    const summaryKey = event.collection === 'schedule_completions' ? 'scheduleCompletions' : event.collection;
    const beforeSummary = target.summary[summaryKey];
    const updated = await applyBatch(target.plan, event.collection, pair);
    const remaining = Math.max(0, beforeSummary.toMigrate - updated);
    return {
      success: true,
      mode,
      collection: event.collection,
      pairKey: pair.pairKey,
      batchLimit: BATCH_SIZE,
      updated,
      remaining,
      done: remaining === 0,
      before: beforeSummary,
      errors: []
    };
  } catch (error) {
    console.error('[migratePairKey] failed:', error && (error.errMsg || error.message || error));
    return { success: false, mode, code: 'MIGRATION_FAILED', msg: '迁移执行失败，请查看云函数日志' };
  }
};

module.exports.buildScan = buildScan;
module.exports.verify = verify;
