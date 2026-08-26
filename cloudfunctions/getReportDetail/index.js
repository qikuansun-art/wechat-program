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
function assertPairRecordAccess(record, pair) { return !record.pairKey || (!!pair && !pair.error && record.pairKey === pair.pairKey); }

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
    const pair = report.pairKey ? await getCurrentPair(OPENID) : null;
    if (!assertPairRecordAccess(report, pair)) return { success: false, msg: '无权查看此报备' };

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

    return { success: true, report, myRole };
  } catch (err) {
    console.error('[getReportDetail] 失败', err);
    return { success: false, msg: '加载失败，请重试' };
  }
};
