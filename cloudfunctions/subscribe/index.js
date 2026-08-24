// 云函数：subscribe —— 记录客户端最近一次报告的订阅接受状态
// 注意：客户端回报不可作为微信真实授权凭证，count 仅为非可信 UX/观测提示。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

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
      // 固定为 1，防止客户端重复调用无限制造垃圾计数。
      // 该值不参与任何通知发送授权判断。
      await subs.doc(exist.data[0]._id).update({
        data: { type, count: 1, updatedAt: db.serverDate() }
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
    return { success: true, count: 1 };
  } catch (err) {
    console.error('[subscribe] 记录失败', err);
    return { success: false, msg: '记录授权失败' };
  }
};
