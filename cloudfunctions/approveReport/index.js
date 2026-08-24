// 云函数：approveReport —— 审批报备
// 仅该报备的审批人（伴侣）可操作；批准或驳回（驳回必须填理由）
// 审批完成后，尝试给发起方推送「审批结果」订阅消息（对方授权过才收得到，失败不影响主流程）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

class BusinessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BusinessError';
  }
}

/** 简单格式化时间：Date / serverDate / 时间戳 → 'YYYY-MM-DD HH:mm' */
function formatTime(value) {
  if (!value) return '';
  const d = (value && value.$date) ? new Date(value.$date) : new Date(value);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 给发起方推送「审批结果」订阅消息（静默失败，但记录详细日志便于排查） */
async function notifyCreator(creatorOpenid, reportData, approveAction, approveReason) {
  try {
    // 审批结果文案：已批准 / 已驳回（附理由）
    const resultText = approveAction === 'approve'
      ? '已批准'
      : `已驳回：${(approveReason || '').slice(0, 12)}`;
    const res = await cloud.callFunction({
      name: 'sendNotify',
      data: {
        type: 'approve_result',
        toOpenid: creatorOpenid,
        page: 'pages/record/record',
        // ⚠️ 字段编号需与你申请的模板关键词一一对应
        data: {
          thing13: { value: (reportData.reason || '报备审批').slice(0, 20) },
          time2: { value: formatTime(reportData.createdAt) },
          phrase3: { value: resultText.slice(0, 20) },
          thing17: { value: (approveAction === 'reject' ? (approveReason || '无') : '无').slice(0, 20) },
          thing18: { value: '查看详情了解更多' }
        }
      }
    });
    const result = (res && res.result) || {};
    if (!result.success) {
      console.warn('[approveReport] 通知发起方未成功:', result.msg || '未知原因',
        'creatorOpenid:', creatorOpenid, 'count:', result.count);
    } else {
      console.log('[approveReport] 通知发起方成功, msgid:', result.msgid);
    }
  } catch (err) {
    console.error('[approveReport] 通知发起方异常:', err.errMsg || err.message || err,
      'creatorOpenid:', creatorOpenid);
  }
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const reportId = String(event.reportId || '');
  const action = event.action; // 'approve' | 'reject'
  const reason = String(event.reason || '').trim();

  if (!reportId) return { success: false, msg: '参数错误' };
  if (action !== 'approve' && action !== 'reject') {
    return { success: false, msg: '非法操作' };
  }
  if (action === 'reject' && !reason) {
    return { success: false, msg: '请填写驳回理由' };
  }

  try {
    const users = db.collection('users');

    const meRes = await users.where({ openid: OPENID }).get();
    if (meRes.data.length === 0) {
      return { success: false, msg: '请先登录' };
    }
    const me = meRes.data[0];

    // 在事务中重新读取并更新报备。并发事务发生写冲突时，云数据库会重试；
    // 重试后的请求会读到非 pending 状态，因此最多只有一个请求能够成功。
    const txRes = await db.runTransaction(async (transaction) => {
      const reportRef = transaction.collection('reports').doc(reportId);
      let reportRes;
      try {
        reportRes = await reportRef.get();
      } catch (err) {
        throw new BusinessError('报备不存在');
      }
      if (!reportRes || !reportRes.data) {
        throw new BusinessError('报备不存在');
      }
      const report = reportRes.data;

      if (report.partnerId !== me._id) {
        throw new BusinessError('无权操作此报备');
      }
      if (report.status !== 'pending') {
        throw new BusinessError('该报备已被处理，请刷新后查看最新结果');
      }

      const updateData = {
        status: action === 'approve' ? 'approved' : 'rejected',
        processedAt: db.serverDate(),
        processedByName: me.nickName || '伴侣'
      };
      if (action === 'reject') {
        updateData.rejectReason = reason.slice(0, 100);
      }
      await reportRef.update({ data: updateData });
      return { report };
    });

    const report = txRes.result.report;

    // 事务成功提交后才通知发起方，失败或重复请求不会发送通知。
    await notifyCreator(report.openid, report, action, reason);

    return { success: true };
  } catch (err) {
    if (err && err.name === 'BusinessError') {
      return { success: false, msg: err.message };
    }
    console.error('[approveReport] 失败', err);
    return { success: false, msg: '操作失败，请重试' };
  }
};
