// 云函数：getScheduleDetail —— 查询并规范化一条日程
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

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
function normalize(schedule, me) {
  const ownerType = schedule.ownerType === 'personal' ? 'personal' : 'couple';
  const ownerId = ownerType === 'personal' ? (schedule.ownerId || null) : null;
  const repeatType = ['daily', 'weekly', 'monthly'].includes(schedule.repeatType) ? schedule.repeatType : 'none';
  return Object.assign({}, schedule, {
    ownerType, ownerId, ownerLabel: ownerType === 'couple' ? '双人' : (ownerId === me._id ? '我的' : 'TA'),
    repeatType, date: repeatType === 'none' ? (schedule.date || null) : null,
    repeatStartDate: repeatType === 'none' ? null : (schedule.repeatStartDate || null),
    repeatEndDate: repeatType === 'none' ? null : (schedule.repeatEndDate || null),
    repeatWeekdays: repeatType === 'weekly' && Array.isArray(schedule.repeatWeekdays) ? schedule.repeatWeekdays : [],
    repeatDay: repeatType === 'monthly' ? (schedule.repeatDay || null) : null
  });
}
exports.main = async (event = {}) => {
  try {
    const auth = await getCurrentPair(cloud.getWXContext().OPENID);
    if (auth.error) return auth.error;
    const id = typeof event.id === 'string' ? event.id.trim() : '';
    if (!id) return { success: false, code: 'INVALID_ID', msg: '事项参数不正确' };
    const res = await db.collection('schedules').doc(id).get().catch(() => null);
    const schedule = res && res.data;
    if (!schedule || !auth.userIds.includes(schedule.creatorId) || !assertPairRecordAccess(schedule, auth)) return { success: false, code: 'NOT_FOUND', msg: '事项不存在或无权访问' };
    return { success: true, schedule: normalize(schedule, auth.me) };
  } catch (err) {
    console.error('[getScheduleDetail] failed:', err && (err.errMsg || err.message || err));
    return { success: false, code: 'QUERY_FAILED', msg: '查询失败，请重试' };
  }
};
