// 云函数：createReport —— 发起报备
// 仅已绑定伴侣的用户可发起；报备发送给伴侣（审批人）
// 创建成功后，尝试给审批方推送「新报备」订阅消息（对方授权过才收得到，失败不影响主流程）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/** 简单格式化时间：Date / serverDate / 时间戳 → 'YYYY-MM-DD HH:mm' */
function formatTime(value) {
  if (!value) return '';
  const d = (value && value.$date) ? new Date(value.$date) : new Date(value);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 给审批方推送「新报备」订阅消息（静默失败，但记录详细日志便于排查） */
async function notifyPartner(partnerOpenid, reportData) {
  try {
    const res = await cloud.callFunction({
      name: 'sendNotify',
      data: {
        type: 'new_report',
        toOpenid: partnerOpenid,
        page: 'pages/message/message',
        // ⚠️ 字段编号需与你申请的模板关键词一一对应（thing/time/name 为常见类型）
        data: {
          thing2: { value: (reportData.reason || '发起报备').slice(0, 20) },
          thing25: { value: (reportData.reason || '').slice(0, 20) },
          time26: { value: formatTime(reportData.createdAt) }
        }
      }
    });
    const result = (res && res.result) || {};
    if (!result.success) {
      // 记录详细原因：额度不足 / 模板未配置 / 其他
      console.warn('[createReport] 通知审批方未成功:', result.msg || '未知原因',
        'partnerOpenid:', partnerOpenid, 'count:', result.count);
    } else {
      console.log('[createReport] 通知审批方成功, msgid:', result.msgid);
    }
  } catch (err) {
    console.error('[createReport] 通知审批方异常:', err.errMsg || err.message || err,
      'partnerOpenid:', partnerOpenid);
  }
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const users = db.collection('users');
  const reports = db.collection('reports');

  const location = String(event.location || '').trim();
  const companions = String(event.companions || '').trim();
  const startTime = String(event.startTime || '').trim();
  const returnTime = String(event.returnTime || '').trim();
  const reason = String(event.reason || '').trim();
  const images = Array.isArray(event.images) ? event.images.slice(0, 3) : [];

  // 校验
  if (!location) return { success: false, msg: '请填写外出地点' };
  if (!returnTime) return { success: false, msg: '请选择预计归来时间' };
  if (!reason) return { success: false, msg: '请填写事由说明' };

  try {
    const meRes = await users.where({ openid: OPENID }).get();
    if (meRes.data.length === 0) {
      return { success: false, msg: '请先登录' };
    }
    const me = meRes.data[0];
    if (!me.partnerId) {
      return { success: false, msg: '请先绑定伴侣再发起报备' };
    }

    const report = {
      openid: OPENID,                  // 发起人 openid
      creatorId: me._id,               // 发起人用户文档 _id
      creatorName: me.nickName || '伴侣',
      creatorAvatar: me.avatarUrl || '',
      partnerId: me.partnerId,         // 审批人用户文档 _id
      location,
      companions,
      startTime,                       // 预计开始时间（可选）
      returnTime,
      reason,
      images,
      status: 'pending',               // pending | approved | rejected
      rejectReason: '',
      createdAt: db.serverDate(),
      processedAt: null,
      processedByName: ''
    };

    const addRes = await reports.add({ data: report });

    // 查审批方 openid，推送订阅消息（异步等待，失败不影响返回）
    try {
      const partnerRes = await users.doc(me.partnerId).get();
      if (partnerRes.data) {
        await notifyPartner(partnerRes.data.openid, Object.assign({}, report, { _id: addRes._id, createdAt: new Date() }));
      }
    } catch (notifyErr) {
      console.error('[createReport] 查询审批方失败（忽略）', notifyErr);
    }

    return { success: true, id: addRes._id };
  } catch (err) {
    console.error('[createReport] 失败', err);
    return { success: false, msg: '提交失败，请重试' };
  }
};
