// 云函数：getReports —— 报备记录列表
// 返回报备记录，按时间倒序，支持角色筛选、状态筛选与分页
// role: '' | 'creator' | 'approver'
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const role = String(event.role || '');        // '' | creator | approver
  const status = String(event.status || '');    // '' | pending | approved | rejected
  const page = Math.max(0, parseInt(event.page, 10) || 0);
  const pageSize = Math.min(50, Math.max(1, parseInt(event.pageSize || event.limit, 10) || 20));

  console.log('[getReports] OPENID:', OPENID, 'role:', role, 'status:', status, 'page:', page);

  try {
    const users = db.collection('users');
    const meRes = await users.where({ openid: OPENID }).get();
    if (meRes.data.length === 0) {
      console.error('[getReports] 用户不存在, OPENID:', OPENID);
      return { success: false, msg: '请先登录', list: [], hasMore: false };
    }
    const me = meRes.data[0];
    console.log('[getReports] me._id:', me._id, 'me.partnerId:', me.partnerId);

    // 根据 role 严格构建查询条件（数据隔离核心）
    let where;
    if (role === 'creator') {
      // 「我发起的」：仅查询当前用户作为发起人创建的报备
      where = { openid: OPENID };
    } else if (role === 'approver') {
      // 「我审批的」：仅查询当前用户作为审批人（partnerId 指向 me._id）的报备
      where = { partnerId: me._id };
    } else {
      // 未指定角色时，返回与当前用户相关的所有报备
      where = _.or([
        { openid: OPENID },
        { partnerId: me._id }
      ]);
    }

    console.log('[getReports] where:', JSON.stringify(where));

    // 组装查询
    let query = db.collection('reports').where(where);
    if (status && ['pending', 'approved', 'rejected'].includes(status)) {
      query = query.where({ status });
    }
    const res = await query
      .orderBy('createdAt', 'desc')
      .skip(page * pageSize)
      .limit(pageSize)
      .get();

    console.log('[getReports] 返回', res.data.length, '条记录');

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
