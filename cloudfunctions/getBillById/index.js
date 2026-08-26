// 云函数：getBillById —— 查询单条账单详情
// 用于编辑模式回填数据
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
  const billId = String(event.id || '');
  if (!billId) {
    return { success: false, msg: '参数错误' };
  }

  try {
    const users = db.collection('users');
    const meRes = await users.where({ openid: OPENID }).get();
    if (meRes.data.length === 0) {
      return { success: false, msg: '请先登录' };
    }
    const me = meRes.data[0];

    const billRes = await db.collection('bills').doc(billId).get().catch(() => null);
    if (!billRes || !billRes.data) {
      return { success: false, msg: '账单不存在' };
    }
    const bill = billRes.data;
    const pair = bill.pairKey ? await getCurrentPair(OPENID) : null;
    if (!assertPairRecordAccess(bill, pair)) return { success: false, msg: '无权查看此账单' };

    // 只能查看自己或伴侣的账单
    if (bill.creatorId !== me._id && bill.partnerId !== me._id) {
      return { success: false, msg: '无权查看此账单' };
    }

    // 返回完整字段供前端回填
    return {
      success: true,
      bill: {
        _id: bill._id,
        type: bill.type,
        category: bill.category,
        categoryName: bill.categoryName,
        amount: bill.amount,
        matter: bill.matter || '',
        note: bill.note || '',
        billDate: bill.billDate,
        creatorId: bill.creatorId,
        creatorName: bill.creatorName
      }
    };
  } catch (err) {
    console.error('[getBillById] 失败', err);
    return { success: false, msg: '查询失败，请重试' };
  }
};
