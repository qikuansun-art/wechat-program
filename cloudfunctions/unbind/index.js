// 云函数：unbind —— 解绑伴侣
// 双方关系同时解除，历史报备记录保留
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

class BusinessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BusinessError';
  }
}

const CLEAR_BINDING = { partnerId: '', partnerName: '', bindTime: null };

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const users = db.collection('users');

  try {
    const meRes = await users.where({ openid: OPENID }).get();
    if (meRes.data.length === 0) {
      return { success: false, msg: '请先登录' };
    }
    const me = meRes.data[0];

    const txRes = await db.runTransaction(async (transaction) => {
      const meRef = transaction.collection('users').doc(me._id);
      const freshMeRes = await meRef.get();
      const freshMe = freshMeRes && freshMeRes.data;
      if (!freshMe || freshMe.openid !== OPENID) {
        throw new BusinessError('当前用户状态异常，请重新登录');
      }
      if (!freshMe.partnerId) {
        throw new BusinessError('你尚未绑定伴侣');
      }

      const partnerId = freshMe.partnerId;
      const partnerRef = transaction.collection('users').doc(partnerId);
      let partner = null;
      try {
        const partnerRes = await partnerRef.get();
        partner = partnerRes && partnerRes.data;
      } catch (err) {
        // 对方记录缺失时只清理自己的悬空关系，不触碰其他用户。
      }

      await meRef.update({ data: CLEAR_BINDING });

      if (partner && partner.partnerId === freshMe._id) {
        await partnerRef.update({ data: CLEAR_BINDING });
        return { repaired: false };
      }

      // 对方不存在或已指向其他人：仅修复当前用户，避免误解绑无关关系。
      return { repaired: true };
    });

    if (txRes.result.repaired) {
      return { success: true, repaired: true, msg: '绑定关系异常，已安全清理当前账号的绑定状态' };
    }
    return { success: true };
  } catch (err) {
    if (err && err.name === 'BusinessError') {
      return { success: false, msg: err.message };
    }
    console.error('[unbind] 失败', err);
    return { success: false, msg: '解绑失败，请重试' };
  }
};
