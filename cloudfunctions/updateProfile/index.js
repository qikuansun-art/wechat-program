// 云函数：updateProfile —— 更新个人资料；历史业务昵称保持创建时快照
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const users = db.collection('users');
  try {
    const meRes = await users.where({ openid: OPENID }).get();
    if (meRes.data.length !== 1) return { success: false, code: 'USER_NOT_FOUND', msg: '请先登录' };
    const me = meRes.data[0];
    const data = {};
    if (typeof event.nickName === 'string' && event.nickName.trim()) {
      const nick = event.nickName.trim().slice(0, 20);
      data.nickName = nick;
      // partnerName 是当前绑定关系的用户资料缓存；不修改历史 bills/reports 快照。
      if (me.partnerId) {
        const partnerRes = await users.doc(me.partnerId).get().catch(() => null);
        const partner = partnerRes && partnerRes.data;
        if (partner && partner.partnerId === me._id) await users.doc(partner._id).update({ data: { partnerName: nick } });
      }
    }
    // Phase 4A 不改变现有头像模型，仅停止头像更新触发历史业务级联。
    if (typeof event.avatarUrl === 'string' && event.avatarUrl) data.avatarUrl = event.avatarUrl;
    if (Object.keys(data).length === 0) return { success: false, msg: '没有需要更新的内容' };
    await users.doc(me._id).update({ data });
    const after = await users.doc(me._id).get();
    return { success: true, userInfo: after.data };
  } catch (err) {
    console.error('[updateProfile] failed', err);
    return { success: false, msg: '更新失败，请重试' };
  }
};
