// 云函数：createReport —— 发起报备
// 仅已绑定伴侣的用户可发起；报备发送给伴侣（审批人）
// 创建成功后，尝试给审批方推送「新报备」订阅消息（对方授权过才收得到，失败不影响主流程）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function parseCloudFileID(fileID) {
  const isString = typeof fileID === 'string';
  const hasCloudPrefix = isString && fileID.startsWith('cloud://');
  const rest = hasCloudPrefix ? fileID.slice('cloud://'.length) : '';
  const slashIndex = rest.indexOf('/');
  const envSegment = slashIndex > 0 ? rest.slice(0, slashIndex) : '';
  const filePath = slashIndex >= 0 ? rest.slice(slashIndex + 1) : '';
  if (!hasCloudPrefix || slashIndex <= 0 || slashIndex === rest.length - 1) return null;
  return { fileEnv: envSegment, filePath };
}

function validateReportImages(images, openid) {
  for (const fileID of images) {
    const parsed = parseCloudFileID(fileID);
    if (!parsed) return { success: false, code: 'INVALID_FILE_ID', msg: '图片文件标识不合法' };
    const { filePath } = parsed;
    if (!filePath.startsWith(`report-images/${openid}/`)) {
      return { success: false, code: 'FILE_OWNER_MISMATCH', msg: '只能提交当前用户上传的报备图片' };
    }
  }
  return null;
}

function buildPairKey(memberIds) { return memberIds.slice().sort().join('|'); }
async function getCurrentPair(openid) {
  const users = db.collection('users');
  const meRes = await users.where({ openid }).get();
  if (meRes.data.length !== 1) return { error: { success: false, code: 'USER_NOT_FOUND', msg: '请先登录' } };
  const me = meRes.data[0];
  if (!me.partnerId) return { error: { success: false, code: 'NOT_BOUND', msg: '请先绑定伴侣再发起报备' } };
  const partnerRes = await users.doc(me.partnerId).get().catch(() => null);
  const partner = partnerRes && partnerRes.data;
  if (!partner || partner.partnerId !== me._id) return { error: { success: false, code: 'BINDING_INVALID', msg: '绑定关系异常，请重新绑定' } };
  const memberIds = [me._id, partner._id].sort();
  return { me, partner, memberIds, pairKey: buildPairKey(memberIds) };
}

const TEMPLATE_NEW_REPORT = '9Olki2zL-v7V_Nse9V0MNTWq2d8nlTIo6aW1YV1Gmvg';
const NOTIFY_PAGE = 'pages/message/message';
const MINIPROGRAM_STATE = 'formal';

/** 简单格式化时间：Date / serverDate / 时间戳 → 'YYYY-MM-DD HH:mm' */
function formatTime(value) {
  if (!value) return '';
  const d = (value && value.$date) ? new Date(value.$date) : new Date(value);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 最佳努力修正本地估算状态；该状态不参与发送授权。 */
async function markSubscriptionEstimateConsumed(openid) {
  try {
    const subs = db.collection('subscriptions');
    const res = await subs.where({ openid, tmplId: TEMPLATE_NEW_REPORT }).get();
    if (res.data.length > 0) {
      await subs.doc(res.data[0]._id).update({
        data: { count: 0, updatedAt: db.serverDate() }
      });
    }
  } catch (err) {
    console.warn('[createReport] 修正订阅估算状态失败（忽略）:', err.errCode || err.errMsg || err.message || '未知错误');
  }
}

/** 给审批方推送「新报备」订阅消息。所有参数均由服务端真实业务数据生成。 */
async function notifyPartner(partnerOpenid, reportData) {
  try {
    const sendRes = await cloud.openapi.subscribeMessage.send({
      touser: partnerOpenid,
      templateId: TEMPLATE_NEW_REPORT,
      page: NOTIFY_PAGE,
      miniprogramState: MINIPROGRAM_STATE,
      lang: 'zh_CN',
      // ⚠️ 字段编号需与你申请的模板关键词一一对应。
      data: {
        thing2: { value: `${reportData.creatorName || '伴侣'}要去${reportData.location}`.slice(0, 20) },
        thing25: { value: (reportData.reason || '发起报备').slice(0, 20) },
        time26: { value: formatTime(reportData.createdAt) }
      }
    });
    console.log('[createReport] 通知审批方成功, receiver:', partnerOpenid.slice(-6) + '...',
      'msgid:', sendRes.msgid || '');
    await markSubscriptionEstimateConsumed(partnerOpenid);
    return { success: true };
  } catch (err) {
    console.warn('[createReport] 通知审批方失败（不影响报备）: receiver:', partnerOpenid.slice(-6) + '...',
      'errCode:', err.errCode || '', 'errMsg:', err.errMsg || err.message || '未知错误');
    if (Number(err.errCode || err.errcode) === 43101) {
      await markSubscriptionEstimateConsumed(partnerOpenid);
    }
    return { success: false };
  }
}

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const OPENID = wxContext.OPENID;
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
  const imageError = validateReportImages(images, OPENID);
  if (imageError) return imageError;

  try {
    const pair = await getCurrentPair(OPENID);
    if (pair.error) return pair.error;
    const me = pair.me;

    const report = {
      openid: OPENID,                  // 发起人 openid
      creatorId: me._id,               // 发起人用户文档 _id
      creatorName: me.nickName || '伴侣',
      creatorAvatar: me.avatarUrl || '',
      partnerId: pair.partner._id,     // 审批人用户文档 _id
      pairKey: pair.pairKey,
      memberIds: pair.memberIds,
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

    // 查真实审批方并推送。接收人、页面和内容均不接受客户端指定。
    try {
      await notifyPartner(pair.partner.openid, Object.assign({}, report, { _id: addRes._id, createdAt: new Date() }));
    } catch (notifyErr) {
      console.error('[createReport] 查询审批方失败（忽略）', notifyErr);
    }

    return { success: true, id: addRes._id };
  } catch (err) {
    console.error('[createReport] 失败', err);
    return { success: false, msg: '提交失败，请重试' };
  }
};
