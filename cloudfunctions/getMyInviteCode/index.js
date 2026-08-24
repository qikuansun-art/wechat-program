// 云函数：getMyInviteCode —— 获取/生成我的邀请码
// 专门解决老用户缺失 bindCode 的问题，独立于 login 缓存
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function generateBindCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const users = db.collection('users');

  try {
    const meRes = await users.where({ openid: OPENID }).get();
    if (meRes.data.length === 0) {
      return { success: false, msg: '请先登录' };
    }
    const me = meRes.data[0];

    // 已有邀请码，直接返回
    if (me.bindCode) {
      return { success: true, bindCode: me.bindCode };
    }

    // 没有邀请码，生成并保存
    let bindCode = '';
    for (let i = 0; i < 5; i++) {
      bindCode = generateBindCode();
      const dup = await users.where({ bindCode }).get();
      if (dup.data.length === 0) break;
    }

    await users.doc(me._id).update({ data: { bindCode } });
    return { success: true, bindCode };
  } catch (err) {
    console.error('[getMyInviteCode] 失败', err);
    return { success: false, msg: '获取邀请码失败' };
  }
};