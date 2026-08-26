// 云函数：getReports —— 报备记录列表
// 返回报备记录，按时间倒序，支持角色筛选、状态筛选与分页
// role: '' | 'creator' | 'approver'
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

async function getCurrentPair(openid) {
  const users = db.collection('users');
  const meRes = await users.where({ openid }).get();
  if (meRes.data.length !== 1) return { error: { success: false, code: 'USER_NOT_FOUND', msg: '请先登录', list: [], hasMore: false } };
  const me = meRes.data[0];
  if (!me.partnerId) return { error: { success: false, code: 'NOT_BOUND', msg: '请先绑定伴侣', list: [], hasMore: false } };
  const partnerRes = await users.doc(me.partnerId).get().catch(() => null);
  const partner = partnerRes && partnerRes.data;
  if (!partner || partner.partnerId !== me._id) return { error: { success: false, code: 'BINDING_INVALID', msg: '绑定关系异常', list: [], hasMore: false } };
  const memberIds = [me._id, partner._id].sort();
  return { me, partner, pairKey: memberIds.join('|') };
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const role = String(event.role || '');        // '' | creator | approver
  const status = String(event.status || '');    // '' | pending | approved | rejected
  const page = Math.max(0, parseInt(event.page, 10) || 0);
  const pageSize = Math.min(50, Math.max(1, parseInt(event.pageSize || event.limit, 10) || 20));

  try {
    const auth = await getCurrentPair(OPENID);
    if (auth.error) return auth.error;
    const me = auth.me;

    // 根据 role 严格构建查询条件（数据隔离核心）
    const statusFilter = status && ['pending', 'approved', 'rejected'].includes(status) ? { status } : {};
    let where;
    if (role === 'creator') {
      // 「我发起的」：仅查询当前用户作为发起人创建的报备
      where = Object.assign({ pairKey: auth.pairKey, creatorId: me._id }, statusFilter);
    } else if (role === 'approver') {
      // 「我审批的」：仅查询当前用户作为审批人（partnerId 指向 me._id）的报备
      where = Object.assign({ pairKey: auth.pairKey, partnerId: me._id }, statusFilter);
    } else {
      // 未指定角色时，返回与当前用户相关的所有报备
      where = _.or([
        Object.assign({ pairKey: auth.pairKey, creatorId: me._id }, statusFilter),
        Object.assign({ pairKey: auth.pairKey, partnerId: me._id }, statusFilter)
      ]);
    }

    // 组装查询
    const res = await db.collection('reports').where(where)
      .orderBy('createdAt', 'desc')
      .skip(page * pageSize)
      .limit(pageSize)
      .get();

    return {
      success: true,
      list: res.data,
      hasMore: res.data.length === pageSize,
      page
    };
  } catch (err) {
    console.error('[getReports] 失败', err);
    return { success: false, msg: '加载失败', list: [], hasMore: false };
  }
};
