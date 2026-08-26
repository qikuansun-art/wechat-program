// 云函数：toggleSchedule —— 完成或取消普通/循环待办、打卡
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
function isOccurrence(schedule, occurrenceDate) {
  if (!isValidDate(occurrenceDate)) return false;
  const repeatType = ['daily', 'weekly', 'monthly'].includes(schedule.repeatType) ? schedule.repeatType : 'none';
  if (repeatType === 'none') return occurrenceDate === schedule.date;
  if (!isValidDate(schedule.repeatStartDate) || !isValidDate(schedule.repeatEndDate) || occurrenceDate < schedule.repeatStartDate || occurrenceDate > schedule.repeatEndDate) return false;
  const [y, m, d] = occurrenceDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (repeatType === 'daily') return true;
  if (repeatType === 'weekly') return Array.isArray(schedule.repeatWeekdays) && schedule.repeatWeekdays.includes(date.getUTCDay() || 7);
  return Number(schedule.repeatDay) === date.getUTCDate();
}
function isDuplicateError(err) {
  const message = String(err && (err.errMsg || err.message || err));
  return /duplicate|duplicated|E11000|-502001|unique/i.test(message);
}
function buildPairKey(memberIds) { return memberIds.slice().sort().join('|'); }
function assertPairRecordAccess(record, pair) { return !record.pairKey || record.pairKey === pair.pairKey; }
async function getCurrentPair(openid) {
  const users = db.collection('users');
  const res = await users.where({ openid }).get();
  if (res.data.length !== 1) return { error: { success: false, code: 'USER_NOT_FOUND', msg: '请先登录' } };
  const me = res.data[0];
  if (!me.partnerId) return { error: { success: false, code: 'NOT_BOUND', msg: '请先绑定伴侣' } };
  const partnerRes = await users.doc(me.partnerId).get().catch(() => null);
  if (!partnerRes || !partnerRes.data || partnerRes.data.partnerId !== me._id) return { error: { success: false, code: 'BINDING_INVALID', msg: '绑定关系异常，请重新绑定' } };
  const partner = partnerRes.data;
  const memberIds = [me._id, partner._id].sort();
  return { me, partner, memberIds, pairKey: buildPairKey(memberIds), userIds: memberIds };
}
function recurringResult(schedule, occurrenceDate, completion) {
  return { success: true, schedule: Object.assign({}, schedule, {
    scheduleId: schedule._id, occurrenceDate, instanceKey: `${schedule._id}:${occurrenceDate}`, isRecurring: true,
    completed: !!completion, completedBy: completion ? completion.completedBy : '',
    completedByName: completion ? (completion.completedByName || '') : '', completedAt: completion ? completion.completedAt : null
  }) };
}

exports.main = async (event = {}) => {
  try {
    const auth = await getCurrentPair(cloud.getWXContext().OPENID);
    if (auth.error) return auth.error;
    const id = typeof event.id === 'string' ? event.id.trim() : '';
    if (!id) return { success: false, code: 'INVALID_ID', msg: '事项参数不正确' };
    if (typeof event.completed !== 'boolean') return { success: false, code: 'INVALID_COMPLETED', msg: '完成状态不正确' };
    const ref = db.collection('schedules').doc(id);
    const res = await ref.get().catch(() => null);
    const schedule = res && res.data;
    if (!schedule || !auth.userIds.includes(schedule.creatorId) || !assertPairRecordAccess(schedule, auth)) return { success: false, code: 'NOT_FOUND', msg: '事项不存在或无权访问' };
    if (!['schedule', 'todo', 'checkin'].includes(schedule.type)) return { success: false, code: 'INVALID_TYPE', msg: '事项类型异常' };
    const repeatType = ['daily', 'weekly', 'monthly'].includes(schedule.repeatType) ? schedule.repeatType : 'none';
    const recurring = repeatType !== 'none';
    const occurrenceDate = typeof event.occurrenceDate === 'string' && event.occurrenceDate.trim() ? event.occurrenceDate.trim() : (recurring ? '' : schedule.date);
    if (!isOccurrence(schedule, occurrenceDate)) return { success: false, code: 'INVALID_OCCURRENCE', msg: '该日期不是此事项的有效实例' };
    const now = db.serverDate();
    if (!recurring) {
      const update = event.completed ? {
        completed: true, completedBy: auth.me._id, completedByName: auth.me.nickName || '伴侣', completedAt: now,
        updatedAt: now, updatedBy: auth.me._id
      } : {
        completed: false, completedBy: '', completedByName: '', completedAt: null, updatedAt: now, updatedBy: auth.me._id
      };
      await ref.update({ data: update });
      return { success: true, schedule: Object.assign({}, schedule, update, { occurrenceDate, instanceKey: `${id}:${occurrenceDate}`, isRecurring: false }) };
    }
    const completions = db.collection('schedule_completions');
    const findCompletion = async () => {
      const found = await completions.where({ scheduleId: id, occurrenceDate }).get();
      return found.data[0] || null;
    };
    if (event.completed) {
      const existing = await findCompletion();
      if (existing) return recurringResult(schedule, occurrenceDate, existing);
      const completion = {
        scheduleId: id, occurrenceDate, completedBy: auth.me._id,
        completedByName: auth.me.nickName || '伴侣', completedAt: now, updatedAt: now
      };
      if (schedule.pairKey) completion.pairKey = schedule.pairKey;
      else console.warn('[PairMigration][SCHEDULE_COMPLETION_CANDIDATE]', { scheduleId: id.slice(-8) });
      try {
        const added = await completions.add({ data: completion });
        return recurringResult(schedule, occurrenceDate, Object.assign({ _id: added._id }, completion));
      } catch (err) {
        if (!isDuplicateError(err)) throw err;
        const winner = await findCompletion();
        if (!winner) throw err;
        return recurringResult(schedule, occurrenceDate, winner);
      }
    }
    const existing = await findCompletion();
    if (existing) await completions.doc(existing._id).remove().catch((err) => {
      const message = String(err && (err.errMsg || err.message || err));
      if (!/not found/i.test(message)) throw err;
    });
    return recurringResult(schedule, occurrenceDate, null);
  } catch (err) {
    console.error('[toggleSchedule] failed:', err && (err.errMsg || err.message || err));
    return { success: false, code: 'UPDATE_FAILED', msg: '操作失败，请重试' };
  }
};
