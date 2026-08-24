// 云函数：saveSchedule —— 新建或编辑情侣日程
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const TYPES = new Set(['schedule', 'todo', 'checkin']);
const TITLE_MAX = 60;
const NOTE_MAX = 500;

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidTime(value) {
  return value === '' || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validateInput(event) {
  const value = {
    type: typeof event.type === 'string' ? event.type.trim() : '',
    title: typeof event.title === 'string' ? event.title.trim() : '',
    date: typeof event.date === 'string' ? event.date.trim() : '',
    startTime: typeof event.startTime === 'string' ? event.startTime.trim() : '',
    endTime: typeof event.endTime === 'string' ? event.endTime.trim() : '',
    note: typeof event.note === 'string' ? event.note.trim() : ''
  };
  if (!TYPES.has(value.type)) return { error: { success: false, code: 'INVALID_TYPE', msg: '事项类型不正确' } };
  if (!value.title || value.title.length > TITLE_MAX) return { error: { success: false, code: 'INVALID_TITLE', msg: `标题必填且不能超过 ${TITLE_MAX} 个字符` } };
  if (!isValidDate(value.date)) return { error: { success: false, code: 'INVALID_DATE', msg: '日期不正确' } };
  if (!isValidTime(value.startTime) || !isValidTime(value.endTime)) return { error: { success: false, code: 'INVALID_TIME', msg: '时间格式不正确' } };
  if (value.startTime && value.endTime && value.endTime < value.startTime) return { error: { success: false, code: 'INVALID_TIME_RANGE', msg: '结束时间不能早于开始时间' } };
  if (value.note.length > NOTE_MAX) return { error: { success: false, code: 'NOTE_TOO_LONG', msg: `备注不能超过 ${NOTE_MAX} 个字符` } };
  return { value };
}

async function getBoundUser(openid) {
  const users = db.collection('users');
  const res = await users.where({ openid }).get();
  if (res.data.length !== 1) return { error: { success: false, code: 'USER_NOT_FOUND', msg: '请先登录' } };
  const me = res.data[0];
  if (!me.partnerId) return { error: { success: false, code: 'NOT_BOUND', msg: '请先绑定伴侣' } };
  const partnerRes = await users.doc(me.partnerId).get().catch(() => null);
  if (!partnerRes || !partnerRes.data || partnerRes.data.partnerId !== me._id) {
    return { error: { success: false, code: 'BINDING_INVALID', msg: '绑定关系异常，请重新绑定' } };
  }
  return { me, userIds: [me._id, me.partnerId] };
}

exports.main = async (event = {}) => {
  try {
    const auth = await getBoundUser(cloud.getWXContext().OPENID);
    if (auth.error) return auth.error;
    const checked = validateInput(event);
    if (checked.error) return checked.error;
    const id = typeof event.id === 'string' ? event.id.trim() : '';
    const schedules = db.collection('schedules');
    const now = db.serverDate();

    if (!id) {
      const schedule = Object.assign({}, checked.value, {
        creatorId: auth.me._id,
        creatorName: auth.me.nickName || '伴侣',
        completed: false,
        completedBy: '',
        completedByName: '',
        completedAt: null,
        createdAt: now,
        updatedAt: now,
        updatedBy: auth.me._id
      });
      const result = await schedules.add({ data: schedule });
      return { success: true, id: result._id, schedule: Object.assign({ _id: result._id }, schedule) };
    }

    const existingRes = await schedules.doc(id).get().catch(() => null);
    const existing = existingRes && existingRes.data;
    if (!existing || !auth.userIds.includes(existing.creatorId)) {
      return { success: false, code: 'NOT_FOUND', msg: '事项不存在或无权访问' };
    }
    const update = Object.assign({}, checked.value, { updatedAt: now, updatedBy: auth.me._id });
    if (checked.value.type === 'schedule' && existing.type !== 'schedule') {
      Object.assign(update, { completed: false, completedBy: '', completedByName: '', completedAt: null });
    }
    await schedules.doc(id).update({ data: update });
    return { success: true, id, schedule: Object.assign({}, existing, update) };
  } catch (err) {
    console.error('[saveSchedule] failed:', err && (err.errMsg || err.message || err));
    return { success: false, code: 'SAVE_FAILED', msg: '保存失败，请重试' };
  }
};
