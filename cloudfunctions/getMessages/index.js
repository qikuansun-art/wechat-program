// 云函数：getMessages —— 消息中心
// 聚合两类消息：
//   1. todo   —— 伴侣发来的、等我审批的报备（type=todo）
//   2. result —— 我发起的、伴侣已处理的报备（type=result）
// 统一按时间倒序返回，前端按 type 分组展示
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const PAGE_SIZE = 50;

async function getCurrentPair(openid) {
  const users = db.collection('users');
  const meRes = await users.where({ openid }).get();
  if (meRes.data.length !== 1) return { error: { success: false, code: 'USER_NOT_FOUND', msg: '请先登录', list: [] } };
  const me = meRes.data[0];
  if (!me.partnerId) return { error: { success: false, code: 'NOT_BOUND', msg: '请先绑定伴侣', list: [] } };
  const partnerRes = await users.doc(me.partnerId).get().catch(() => null);
  const partner = partnerRes && partnerRes.data;
  if (!partner || partner.partnerId !== me._id) return { error: { success: false, code: 'BINDING_INVALID', msg: '绑定关系异常', list: [] } };
  return { me, partner, pairKey: [me._id, partner._id].sort().join('|') };
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();

  try {
    const auth = await getCurrentPair(OPENID);
    if (auth.error) return auth.error;
    const me = auth.me;
    const reports = db.collection('reports');

    // 1. 待我审批：我是审批人 且 状态为 pending
    const todoRes = await reports
      .where({ pairKey: auth.pairKey, partnerId: me._id, status: 'pending' })
      .orderBy('createdAt', 'desc')
      .limit(PAGE_SIZE)
      .get();

    // 2. 我的结果：我是发起人 且 已处理（approved/rejected）
    const resultRes = await reports
      .where({
        pairKey: auth.pairKey,
        creatorId: me._id,
        status: _.in(['approved', 'rejected'])
      })
      .orderBy('processedAt', 'desc')
      .limit(PAGE_SIZE)
      .get();

    // 组装消息（todo 优先展示：先按 type 排序，同 type 内按时间倒序）
    const todoList = todoRes.data.map((r) => ({
      type: 'todo',
      reportId: r._id,
      creatorName: r.creatorName,
      location: r.location,
      returnTime: r.returnTime,
      reason: r.reason,
      images: r.images,
      status: r.status,
      createdAt: r.createdAt
    }));
    const resultList = resultRes.data.map((r) => ({
      type: 'result',
      reportId: r._id,
      creatorName: r.creatorName,
      location: r.location,
      returnTime: r.returnTime,
      reason: r.reason,
      status: r.status,
      rejectReason: r.rejectReason,
      processedAt: r.processedAt,
      processedByName: r.processedByName,
      createdAt: r.createdAt
    }));

    return { success: true, list: todoList.concat(resultList) };
  } catch (err) {
    console.error('[getMessages] 失败', err);
    return { success: false, msg: '加载失败', list: [] };
  }
};
