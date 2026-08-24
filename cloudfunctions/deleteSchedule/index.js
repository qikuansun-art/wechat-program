// 云函数：deleteSchedule —— 删除当前绑定双方的一条日程
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

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
    const id = typeof event.id === 'string' ? event.id.trim() : '';
    if (!id) return { success: false, code: 'INVALID_ID', msg: '事项参数不正确' };
    const ref = db.collection('schedules').doc(id);
    const res = await ref.get().catch(() => null);
    const schedule = res && res.data;
    if (!schedule || !auth.userIds.includes(schedule.creatorId)) {
      return { success: false, code: 'NOT_FOUND', msg: '事项不存在或无权访问' };
    }
    await ref.remove();
    return { success: true };
  } catch (err) {
    console.error('[deleteSchedule] failed:', err && (err.errMsg || err.message || err));
    return { success: false, code: 'DELETE_FAILED', msg: '删除失败，请重试' };
  }
};
