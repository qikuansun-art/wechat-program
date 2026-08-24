// 云函数：approveReport —— 审批报备
// 仅该报备的审批人（伴侣）可操作；批准或驳回（驳回必须填理由）
// 审批完成后，尝试给发起方推送「审批结果」订阅消息（对方授权过才收得到，失败不影响主流程）
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
    const reports = db.collection('reports');

    const meRes = await users.where({ openid: OPENID }).get();
    if (meRes.data.length === 0) {
      return { success: false, msg: '请先登录' };
    }
    const me = meRes.data[0];

    // 读取报备
    const reportRes = await reports.doc(reportId).get().catch(() => null);
    if (!reportRes || !reportRes.data) {
      return { success: false, msg: '报备不存在' };
    }
    const report = reportRes.data;

    // 权限校验：只有审批人（partnerId 指向我）能审批
    if (report.partnerId !== me._id) {
      return { success: false, msg: '无权操作此报备' };
    }
    // 状态校验：不能重复审批
    if (report.status !== 'pending') {
      return { success: false, msg: '该报备已处理，请勿重复操作' };
    }

    if (action === 'approve') {
      await reports.doc(reportId).update({
        data: {
          status: 'approved',
          processedAt: db.serverDate(),
          processedByName: me.nickName || '伴侣'
        }
      });
    } else {
      await reports.doc(reportId).update({
        data: {
          status: 'rejected',
          rejectReason: reason.slice(0, 100),
          processedAt: db.serverDate(),
          processedByName: me.nickName || '伴侣'
        }
      });
    }

    // 通知发起方（report.openid 即发起方 openid）
    await notifyCreator(report.openid, report, action, reason);

    return { success: true };
  } catch (err) {
    console.error('[approveReport] 失败', err);
    return { success: false, msg: '操作失败，请重试' };
  }
};
