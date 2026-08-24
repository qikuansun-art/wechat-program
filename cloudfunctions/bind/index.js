// 云函数：bind —— 绑定伴侣
// 传入对方邀请码，双方互相关联（双方都必须已登录且未绑定）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const code = String(event.code || '').toUpperCase().trim();
  const users = db.collection('users');

  if (!/^[A-Z0-9]{4,10}$/.test(code)) {
    return { success: false, msg: '邀请码格式不正确' };
  }

  try {
    // 1. 当前用户
    const meRes = await users.where({ openid: OPENID }).get();
    if (meRes.data.length === 0) {
      return { success: false, msg: '请先登录' };
    }
    const me = meRes.data[0];
    if (me.partnerId) {
      return { success: false, msg: '你已绑定伴侣，请先解绑' };
    }

    // 2. 对方
    const partnerRes = await users.where({ bindCode: code }).get();
    if (partnerRes.data.length === 0) {
      return { success: false, msg: '邀请码无效，请核对后重试' };
    }
    const partner = partnerRes.data[0];
    if (partner.openid === OPENID) {
      return { success: false, msg: '不能绑定自己哦' };
    }
    if (partner.partnerId) {
      return { success: false, msg: '对方已绑定伴侣' };
    }

    // 3. 双向绑定
    await users.doc(me._id).update({
      data: {
        partnerId: partner._id,
        partnerName: partner.nickName || '伴侣',
        bindTime: db.serverDate()
      }
    });
    await users.doc(partner._id).update({
      data: {
        partnerId: me._id,
        partnerName: me.nickName || '伴侣',
        bindTime: db.serverDate()
      }
    });

    return {
      success: true,
      partner: {
        id: partner._id,
        nickName: partner.nickName || '伴侣',
        avatarUrl: partner.avatarUrl || ''
      }
    };
  } catch (err) {
    console.error('[bind] 失败', err);
    return { success: false, msg: '绑定失败，请重试' };
  }
};
