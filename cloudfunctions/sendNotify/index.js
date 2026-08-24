// 云函数：sendNotify —— 发送订阅消息
// 由 createReport / approveReport 通过云函数间调用触发，负责：
// 1. 检查接收方的订阅额度（一次性订阅：用户授权几次就能发几条）
// 2. 通过微信订阅消息 API 下发
// 3. 发送成功后扣减额度
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// ============================================================
// ⚠️ 模板 ID 配置：请在微信公众平台申请后替换（与 utils/config.js 保持一致）
//   - new_report：报备提醒，发给「审批方」（伴侣）
//   - approve_result：审批结果通知，发给「发起方」
// ============================================================
const TEMPLATES = {
  new_report: '9Olki2zL-v7V_Nse9V0MNTWq2d8nlTIo6aW1YV1Gmvg',
  approve_result: 'nrteb3ujtZBTIHtyABGP0FGP3Dy19PxRelc0IFFnaB8'
};

// 发送的小程序版本：
//   developer = 开发版（调试用）| trial = 体验版 | formal = 正式版
// 上线前请改为 'formal'
const MINIPROGRAM_STATE = 'developer';

exports.main = async (event, context) => {
  const { type, toOpenid, data, page } = event;

  const tmplId = TEMPLATES[type];
  console.log('[sendNotify] 收到请求: type=' + type + ', toOpenid=' + (toOpenid || '').slice(-6) + '..., tmplId=' + (tmplId || '未配置').slice(-6) + '...');

  if (!tmplId || tmplId.indexOf('请替换') >= 0) {
    return { success: false, msg: '未配置订阅消息模板 ID' };
  }
  if (!toOpenid) {
    return { success: false, msg: '缺少接收人 openid' };
  }

  try {
    // 1. 检查订阅额度：subscriptions 集合按 openid+tmplId 记录剩余次数
    const subRes = await db.collection('subscriptions')
      .where({ openid: toOpenid, tmplId })
      .get();
    if (subRes.data.length === 0 || subRes.data[0].count <= 0) {
      // 详细记录额度不足的原因，便于排查
      const count = subRes.data.length > 0 ? subRes.data[0].count : '无记录';
      console.warn('[sendNotify] 接收方订阅额度不足: toOpenid=' + toOpenid.slice(-6) +
        '..., type=' + type + ', count=' + count);
      return { success: false, msg: '接收方订阅额度不足', count };
    }

    // 2. 发送订阅消息
    const sendRes = await cloud.openapi.subscribeMessage.send({
      touser: toOpenid,
      templateId: tmplId,
      page: page || 'pages/index/index',
      miniprogramState: MINIPROGRAM_STATE,
      lang: 'zh_CN',
      data
    });

    // 3. 扣减额度（发送失败会抛异常，不会走到这里）
    await db.collection('subscriptions').doc(subRes.data[0]._id).update({
      data: { count: _.inc(-1), updatedAt: db.serverDate() }
    });

    console.log('[sendNotify] 发送成功: type=' + type + ', msgid=' + (sendRes.msgid || ''));
    return { success: true, msgid: sendRes.msgid || '' };
  } catch (err) {
    console.error('[sendNotify] 发送失败: type=' + type + ', toOpenid=' + (toOpenid || '').slice(-6) +
      '..., errCode=' + (err.errCode || '') + ', errMsg=' + (err.errMsg || err.message || err));
    return { success: false, msg: '发送失败', errMsg: err.errMsg || err.message };
  }
};
