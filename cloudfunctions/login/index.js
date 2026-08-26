// 云函数：login —— 登录/注册
// 首次进入自动创建用户记录并生成专属邀请码；再次进入返回已有用户信息
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/** 生成 6 位邀请码（去掉了易混淆的 0/O、1/I） */
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
    // 1. 查找已有用户
    const exist = await users.where({ openid: OPENID }).get();
    if (exist.data.length > 0) {
      const user = exist.data[0];
      const updateData = { lastLoginAt: db.serverDate() };
      // 为老用户补充缺失的邀请码
      if (!user.bindCode) {
        let bindCode = '';
        for (let i = 0; i < 5; i++) {
          bindCode = generateBindCode();
          const dup = await users.where({ bindCode }).get();
          if (dup.data.length === 0) break;
        }
        updateData.bindCode = bindCode;
        user.bindCode = bindCode;
      }
      await users.doc(user._id).update({ data: updateData });
      return { success: true, openid: OPENID, userInfo: user };
    }

    // 2. 新用户：创建记录 + 唯一邀请码（尝试最多 5 次防撞码）
    let bindCode = '';
    for (let i = 0; i < 5; i++) {
      bindCode = generateBindCode();
      const dup = await users.where({ bindCode }).get();
      if (dup.data.length === 0) break;
    }

    const userInfo = {
      openid: OPENID,
      nickName: '未设置昵称',
      avatarUrl: '',
      bindCode,
      partnerId: '',        // 伴侣的用户文档 _id，空=未绑定
      partnerName: '',
      bindTime: null,
      createdAt: db.serverDate(),
      lastLoginAt: db.serverDate()
    };
    const addRes = await users.add({ data: userInfo });
    return {
      success: true,
      openid: OPENID,
      userInfo: Object.assign({ _id: addRes._id }, userInfo)
    };
  } catch (err) {
    console.error('[login] 失败', err);
    return { success: false, msg: '登录失败' };
  }
};
