// 云函数：deleteSchedule —— 删除当前绑定双方的一条日程
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function buildPairKey(memberIds) { return memberIds.slice().sort().join('|'); }
function pairAccessError(record, pair) {
  if (!record.pairKey) return { success: false, code: 'DATA_ISOLATION_ERROR', msg: '事项缺少数据隔离标识' };
  if (record.pairKey !== pair.pairKey) return { success: false, code: 'ACCESS_DENIED', msg: '无权删除此事项' };
  return null;
}
async function getCurrentPair(openid) {
  const users = db.collection('users');
  const res = await users.where({ openid }).get();
  if (res.data.length !== 1) return { error: { success: false, code: 'USER_NOT_FOUND', msg: '请先登录' } };
  const me = res.data[0];
  if (!me.partnerId) return { error: { success: false, code: 'NOT_BOUND', msg: '请先绑定伴侣' } };
  const partnerRes = await users.doc(me.partnerId).get().catch(() => null);
  if (!partnerRes || !partnerRes.data || partnerRes.data.partnerId !== me._id) {
    return { error: { success: false, code: 'BINDING_INVALID', msg: '绑定关系异常，请重新绑定' } };
  }
  const partner = partnerRes.data;
  const memberIds = [me._id, partner._id].sort();
  return { me, partner, memberIds, pairKey: buildPairKey(memberIds), userIds: memberIds };
}

exports.main = async (event = {}) => {
  try {
    const auth = await getCurrentPair(cloud.getWXContext().OPENID);
    if (auth.error) return auth.error;
    const id = typeof event.id === 'string' ? event.id.trim() : '';
    if (!id) return { success: false, code: 'INVALID_ID', msg: '事项参数不正确' };
    const ref = db.collection('schedules').doc(id);
    const res = await ref.get().catch(() => null);
    const schedule = res && res.data;
    if (!schedule) return { success: false, code: 'NOT_FOUND', msg: '事项不存在' };
    const accessError = pairAccessError(schedule, auth);
    if (accessError) return accessError;
    const recurring = ['daily', 'weekly', 'monthly'].includes(schedule.repeatType);
    await ref.remove();
    if (recurring) {
      try {
        const completions = db.collection('schedule_completions');
        // 规则已删除后，残留 completion 不再能被查询或操作；逐条清理失败仅记录日志。
        while (true) {
          const res = await completions.where({ pairKey: auth.pairKey, scheduleId: id }).limit(100).get();
          if (!res.data.length) break;
          await Promise.all(res.data.map((item) => completions.doc(item._id).remove()));
          if (res.data.length < 100) break;
        }
      } catch (cleanupError) {
        console.error('[deleteSchedule] completion cleanup failed:', cleanupError && (cleanupError.errMsg || cleanupError.message || cleanupError));
      }
    }
    return { success: true };
  } catch (err) {
    console.error('[deleteSchedule] failed:', err && (err.errMsg || err.message || err));
    return { success: false, code: 'DELETE_FAILED', msg: '删除失败，请重试' };
  }
};
