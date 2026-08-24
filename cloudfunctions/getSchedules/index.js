// 云函数：getSchedules —— 查询当前绑定双方的单月日程
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const MAX_RESULTS = 500;

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
    const year = Number(event.year);
    const month = Number(event.month);
    if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
      return { success: false, code: 'INVALID_MONTH', msg: '年月参数不正确' };
    }
    const monthText = String(month).padStart(2, '0');
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const startDate = `${year}-${monthText}-01`;
    const endDate = `${year}-${monthText}-${String(lastDay).padStart(2, '0')}`;
    const res = await db.collection('schedules').where({
      creatorId: _.in(auth.userIds),
      date: _.gte(startDate).and(_.lte(endDate))
    }).orderBy('date', 'asc').orderBy('startTime', 'asc').orderBy('createdAt', 'asc').limit(MAX_RESULTS + 1).get();
    if (res.data.length > MAX_RESULTS) {
      return { success: false, code: 'TOO_MANY_RESULTS', msg: `当月事项超过 ${MAX_RESULTS} 条，请减少后再查看` };
    }
    return { success: true, list: res.data };
  } catch (err) {
    console.error('[getSchedules] failed:', err && (err.errMsg || err.message || err));
    return { success: false, code: 'QUERY_FAILED', msg: '查询失败，请重试' };
  }
};
