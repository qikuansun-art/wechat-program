// 云函数：unbind —— 解绑伴侣
// 双方关系同时解除，历史报备记录保留
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
    if (!me.partnerId) {
      return { success: false, msg: '你尚未绑定伴侣' };
    }

    // 解除双方绑定
    await users.doc(me._id).update({
      data: { partnerId: '', partnerName: '', bindTime: null }
    });
    // 对方可能已解绑或换绑，仅当对方还指向我时才清除
    await users.where({
      _id: me.partnerId,
      partnerId: me._id
    }).update({
      data: { partnerId: '', partnerName: '', bindTime: null }
    });

    return { success: true };
  } catch (err) {
    console.error('[unbind] 失败', err);
    return { success: false, msg: '解绑失败，请重试' };
  }
};
