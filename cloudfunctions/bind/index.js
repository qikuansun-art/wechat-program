// 云函数：bind —— 绑定伴侣
// 传入对方邀请码，双方互相关联（双方都必须已登录且未绑定）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

class BusinessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BusinessError';
  }
}

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

    // 3. 在事务内重新读取双方并完成双向绑定。
    // 事务冲突时云数据库会自动重试，防止多人同时抢绑同一个用户。
    const txRes = await db.runTransaction(async (transaction) => {
      const meRef = transaction.collection('users').doc(me._id);
      const partnerRef = transaction.collection('users').doc(partner._id);
      const [freshMeRes, freshPartnerRes] = await Promise.all([
        meRef.get(),
        partnerRef.get()
      ]);
      const freshMe = freshMeRes && freshMeRes.data;
      const freshPartner = freshPartnerRes && freshPartnerRes.data;

      if (!freshMe || freshMe.openid !== OPENID) {
        throw new BusinessError('当前用户状态异常，请重新登录');
      }
      if (!freshPartner || freshPartner.bindCode !== code) {
        throw new BusinessError('邀请码已失效，请重新获取');
      }
      if (freshMe._id === freshPartner._id || freshPartner.openid === OPENID) {
        throw new BusinessError('不能绑定自己哦');
      }
      if (freshMe.partnerId) {
        throw new BusinessError('你已绑定伴侣，请先解绑');
      }
      if (freshPartner.partnerId) {
        throw new BusinessError('对方已绑定伴侣');
      }

      await meRef.update({
        data: {
          partnerId: freshPartner._id,
          partnerName: freshPartner.nickName || '伴侣',
          bindTime: db.serverDate()
        }
      });
      await partnerRef.update({
        data: {
          partnerId: freshMe._id,
          partnerName: freshMe.nickName || '伴侣',
          bindTime: db.serverDate()
        }
      });

      return { partner: freshPartner };
    });

    const boundPartner = txRes.result.partner;

    return {
      success: true,
      partner: {
        id: boundPartner._id,
        nickName: boundPartner.nickName || '伴侣',
        avatarUrl: boundPartner.avatarUrl || ''
      }
    };
  } catch (err) {
    if (err && err.name === 'BusinessError') {
      return { success: false, msg: err.message };
    }
    console.error('[bind] 失败', err);
    return { success: false, msg: '绑定失败，请重试' };
  }
};
