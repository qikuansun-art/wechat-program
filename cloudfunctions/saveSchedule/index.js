// 云函数：saveSchedule —— 新建或编辑情侣日程（V2）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const TYPES = new Set(['schedule', 'todo', 'checkin']);
const REPEAT_TYPES = new Set(['none', 'daily', 'weekly', 'monthly']);
const OWNER_TYPES = new Set(['personal', 'couple']);
const TITLE_MAX = 60;
const NOTE_MAX = 500;

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function isValidTime(value) { return value === '' || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }

function validateInput(event, auth) {
  const value = {
    type: text(event.type), title: text(event.title), startTime: text(event.startTime),
    endTime: text(event.endTime), note: text(event.note), ownerType: text(event.ownerType) || 'couple',
    ownerId: null, repeatType: text(event.repeatType) || 'none', date: null,
    repeatStartDate: null, repeatEndDate: null, repeatWeekdays: [], repeatDay: null
  };
  if (!TYPES.has(value.type)) return { error: { success: false, code: 'INVALID_TYPE', msg: '事项类型不正确' } };
  if (!value.title || value.title.length > TITLE_MAX) return { error: { success: false, code: 'INVALID_TITLE', msg: `标题必填且不能超过 ${TITLE_MAX} 个字符` } };
  if (!isValidTime(value.startTime) || !isValidTime(value.endTime)) return { error: { success: false, code: 'INVALID_TIME', msg: '时间格式不正确' } };
  if (value.startTime && value.endTime && value.endTime < value.startTime) return { error: { success: false, code: 'INVALID_TIME_RANGE', msg: '结束时间不能早于开始时间' } };
  if (value.note.length > NOTE_MAX) return { error: { success: false, code: 'NOTE_TOO_LONG', msg: `备注不能超过 ${NOTE_MAX} 个字符` } };
  if (!OWNER_TYPES.has(value.ownerType)) return { error: { success: false, code: 'INVALID_OWNER_TYPE', msg: '日程归属不正确' } };
  if (value.ownerType === 'personal') {
    const ownerId = text(event.ownerId);
    if (!auth.userIds.includes(ownerId)) return { error: { success: false, code: 'INVALID_OWNER_ID', msg: '个人日程归属不正确' } };
    value.ownerId = ownerId;
  }
  if (!REPEAT_TYPES.has(value.repeatType)) return { error: { success: false, code: 'INVALID_REPEAT_TYPE', msg: '重复类型不正确' } };
  if (value.repeatType === 'none') {
    value.date = text(event.date);
    if (!isValidDate(value.date)) return { error: { success: false, code: 'INVALID_DATE', msg: '日期不正确' } };
    return { value };
  }
  value.repeatStartDate = text(event.repeatStartDate);
  value.repeatEndDate = text(event.repeatEndDate);
  if (!isValidDate(value.repeatStartDate) || !isValidDate(value.repeatEndDate) || value.repeatStartDate > value.repeatEndDate) {
    return { error: { success: false, code: 'INVALID_REPEAT_RANGE', msg: '重复日期范围不正确' } };
  }
  if (value.repeatType === 'weekly') {
    if (!Array.isArray(event.repeatWeekdays)) return { error: { success: false, code: 'INVALID_REPEAT_WEEKDAYS', msg: '请选择重复星期' } };
    value.repeatWeekdays = Array.from(new Set(event.repeatWeekdays.map(Number))).sort((a, b) => a - b);
    if (!value.repeatWeekdays.length || value.repeatWeekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
      return { error: { success: false, code: 'INVALID_REPEAT_WEEKDAYS', msg: '重复星期不正确' } };
    }
  }
  if (value.repeatType === 'monthly') {
    value.repeatDay = Number(event.repeatDay);
    if (!Number.isInteger(value.repeatDay) || value.repeatDay < 1 || value.repeatDay > 31) return { error: { success: false, code: 'INVALID_REPEAT_DAY', msg: '每月重复日期不正确' } };
  }
  return { value };
}

function buildPairKey(memberIds) { return memberIds.slice().sort().join('|'); }
function pairAccessError(record, pair) {
  if (!record.pairKey) return { success: false, code: 'DATA_ISOLATION_ERROR', msg: '事项缺少数据隔离标识' };
  if (record.pairKey !== pair.pairKey) return { success: false, code: 'ACCESS_DENIED', msg: '无权编辑此事项' };
  return null;
}
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

exports.main = async (event = {}) => {
  try {
    const auth = await getCurrentPair(cloud.getWXContext().OPENID);
    if (auth.error) return auth.error;
    const checked = validateInput(event, auth);
    if (checked.error) return checked.error;
    const id = text(event.id);
    const schedules = db.collection('schedules');
    const now = db.serverDate();
    if (!id) {
      const schedule = Object.assign({}, checked.value, {
        creatorId: auth.me._id, creatorName: auth.me.nickName || '伴侣', completed: false,
        completedBy: '', completedByName: '', completedAt: null,
        pairKey: auth.pairKey, memberIds: auth.memberIds,
        createdAt: now, updatedAt: now, updatedBy: auth.me._id
      });
      const result = await schedules.add({ data: schedule });
      return { success: true, id: result._id, schedule: Object.assign({ _id: result._id }, schedule) };
    }
    const existingRes = await schedules.doc(id).get().catch(() => null);
    const existing = existingRes && existingRes.data;
    if (!existing) return { success: false, code: 'NOT_FOUND', msg: '事项不存在' };
    const accessError = pairAccessError(existing, auth);
    if (accessError) return accessError;
    const previousRepeatType = existing.repeatType || 'none';
    const update = Object.assign({}, checked.value, { updatedAt: now, updatedBy: auth.me._id });
    if (previousRepeatType !== checked.value.repeatType || (checked.value.type === 'schedule' && existing.type !== 'schedule')) {
      Object.assign(update, { completed: false, completedBy: '', completedByName: '', completedAt: null });
    }
    await schedules.doc(id).update({ data: update });
    return { success: true, id, schedule: Object.assign({}, existing, update) };
  } catch (err) {
    console.error('[saveSchedule] failed:', err && (err.errMsg || err.message || err));
    return { success: false, code: 'SAVE_FAILED', msg: '保存失败，请重试' };
  }
};
