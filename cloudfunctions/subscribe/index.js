// 云函数：subscribe —— 记录用户订阅授权
// 前端 wx.requestSubscribeMessage 授权成功后调用一次，额度 +1
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 与 sendNotify / utils/config.js 保持一致
const TEMPLATES = {
  new_report: '9Olki2zL-v7V_Nse9V0MNTWq2d8nlTIo6aW1YV1Gmvg',
  approve_result: 'nrteb3ujtZBTIHtyABGP0FGP3Dy19PxRelc0IFFnaB8'
};

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const type = event.type; // 'new_report' | 'approve_result'
  const tmplId = TEMPLATES[type];

  if (!tmplId || tmplId.indexOf('请替换') >= 0) {
    return { success: false, msg: '未配置订阅消息模板 ID' };
  }

  try {
    const subs = db.collection('subscriptions');
    const exist = await subs.where({ openid: OPENID, tmplId }).get();

    if (exist.data.length > 0) {
      // 已有记录：额度 +1
      await subs.doc(exist.data[0]._id).update({
        data: { count: _.inc(1), updatedAt: db.serverDate() }
      });
    } else {
      // 首次授权：新建记录
      await subs.add({
        data: {
          openid: OPENID,
          tmplId,
          type,
          count: 1,
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      });
    }
    return { success: true };
  } catch (err) {
    console.error('[subscribe] 记录失败', err);
    return { success: false, msg: '记录授权失败' };
  }
};
