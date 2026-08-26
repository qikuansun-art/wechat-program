// 云函数：getReportDetail —— 报备详情
// 仅发起人或审批人可查看；返回我的角色（creator/approver）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function buildPairKey(memberIds) { return memberIds.slice().sort().join('|'); }
async function getCurrentPair(openid) {
  const users = db.collection('users');
  const meRes = await users.where({ openid }).get();
  if (meRes.data.length !== 1) return { error: true };
  const me = meRes.data[0];
  if (!me.partnerId) return { error: true };
  const partnerRes = await users.doc(me.partnerId).get().catch(() => null);
  const partner = partnerRes && partnerRes.data;
  if (!partner || partner.partnerId !== me._id) return { error: true };
  const memberIds = [me._id, partner._id].sort();
  return { me, partner, memberIds, pairKey: buildPairKey(memberIds) };
}
function pairAccessError(record, pair) {
  if (!record.pairKey) return { success: false, code: 'DATA_ISOLATION_ERROR', msg: '报备缺少数据隔离标识' };
  if (record.pairKey !== pair.pairKey) return { success: false, code: 'ACCESS_DENIED', msg: '无权查看此报备' };
  return null;
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const reportId = String(event.reportId || '');
  if (!reportId) return { success: false, msg: '参数错误' };

  try {
    const users = db.collection('users');
    const meRes = await users.where({ openid: OPENID }).get();
    if (meRes.data.length === 0) {
      return { success: false, msg: '请先登录' };
    }
    const me = meRes.data[0];

    const reportRes = await db.collection('reports').doc(reportId).get().catch(() => null);
    if (!reportRes || !reportRes.data) {
      return { success: false, msg: '报备不存在' };
    }
    const report = reportRes.data;
    const pair = await getCurrentPair(OPENID);
    if (pair.error) return { success: false, code: 'ACCESS_DENIED', msg: '当前情侣关系无效' };
    const accessError = pairAccessError(report, pair);
    if (accessError) return accessError;

    // 权限：我发起的 或 我审批的
    let myRole = '';
    if (report.openid === OPENID) {
      myRole = 'creator';
    } else if (report.partnerId === me._id) {
      myRole = 'approver';
    }
    if (!myRole) {
      return { success: false, msg: '无权查看此报备' };
    }

    const images = Array.isArray(report.images) ? report.images.slice() : [];
    let imageUrls = [];
    let imageLoadFailed = false;
    if (images.length > 0) {
      try {
        const tempResult = await cloud.getTempFileURL({ fileList: images });
        const files = Array.isArray(tempResult.fileList) ? tempResult.fileList : [];
        imageUrls = files
          .filter((file) => file && file.status === 0 && file.tempFileURL)
          .map((file) => file.tempFileURL);
        imageLoadFailed = imageUrls.length !== images.length;
      } catch (imageErr) {
        imageLoadFailed = true;
        console.error('[getReportDetail][IMAGE_URL_FAILED]', imageErr && (imageErr.errMsg || imageErr.message || imageErr));
      }
    }
    const reportForClient = Object.assign({}, report, { imageUrls, imageLoadFailed });
    delete reportForClient.images;
    return { success: true, report: reportForClient, myRole };
  } catch (err) {
    console.error('[getReportDetail] 失败', err);
    return { success: false, msg: '加载失败，请重试' };
  }
};
