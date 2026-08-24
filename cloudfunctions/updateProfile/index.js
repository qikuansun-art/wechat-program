// 云函数：updateProfile —— 更新个人资料（头像/昵称）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const users = db.collection('users');

  try {
    const meRes = await users.where({ openid: OPENID }).get();
    if (meRes.data.length === 0) {
      return { success: false, msg: '请先登录' };
    }
    const me = meRes.data[0];

    const data = {};
    if (typeof event.nickName === 'string' && event.nickName.trim()) {
      const nick = event.nickName.trim().slice(0, 20);
      data.nickName = nick;
      // 若已绑定伴侣，同步更新对方看到的「伴侣昵称」
      if (me.partnerId) {
        await users.where({
          _id: me.partnerId,
          partnerId: me._id
        }).update({
          data: { partnerName: nick }
        });
      }

      // ========== 级联同步昵称到历史账单和报备记录 ==========
      // bills 集合：更新该用户创建的所有账单的 creatorName
      try {
        const billsCol = db.collection('bills');
        const billStats = await billsCol.where({ creatorId: me._id }).count();
        const totalBills = billStats.total;
        const batchSize = 100; // 云函数单次 where.update 最多 100 条
        for (let i = 0; i < totalBills; i += batchSize) {
          await billsCol.where({ creatorId: me._id })
            .limit(batchSize)
            .update({ data: { creatorName: nick } });
        }
        console.log('[updateProfile] 已同步 bills 昵称', totalBills, '条');
      } catch (e) {
        console.error('[updateProfile] 同步 bills 昵称失败（不影响主流程）', e);
      }

      // reports 集合：更新该用户作为发起人的 creatorName
      try {
        const reportsCol = db.collection('reports');
        const creatorStats = await reportsCol.where({ creatorId: me._id }).count();
        const totalCreator = creatorStats.total;
        for (let i = 0; i < totalCreator; i += batchSize) {
          await reportsCol.where({ creatorId: me._id })
            .limit(batchSize)
            .update({ data: { creatorName: nick } });
        }
        console.log('[updateProfile] 已同步 reports.creatorName', totalCreator, '条');
      } catch (e) {
        console.error('[updateProfile] 同步 reports.creatorName 失败（不影响主流程）', e);
      }

      // reports 集合：更新该用户作为审批人的 processedByName
      try {
        const reportsCol = db.collection('reports');
        const processorStats = await reportsCol.where({ partnerId: me._id }).count();
        const totalProcessor = processorStats.total;
        for (let i = 0; i < totalProcessor; i += batchSize) {
          await reportsCol.where({ partnerId: me._id })
            .limit(batchSize)
            .update({ data: { processedByName: nick } });
        }
        console.log('[updateProfile] 已同步 reports.processedByName', totalProcessor, '条');
      } catch (e) {
        console.error('[updateProfile] 同步 reports.processedByName 失败（不影响主流程）', e);
      }
    }
    if (typeof event.avatarUrl === 'string' && event.avatarUrl) {
      data.avatarUrl = event.avatarUrl;
    }
    if (Object.keys(data).length === 0) {
      return { success: false, msg: '没有需要更新的内容' };
    }

    await users.doc(me._id).update({ data });
    const after = await users.doc(me._id).get();
    return { success: true, userInfo: after.data };
  } catch (err) {
    console.error('[updateProfile] 失败', err);
    return { success: false, msg: '更新失败，请重试' };
  }
};
