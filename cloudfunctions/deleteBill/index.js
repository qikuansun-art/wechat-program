// 云函数：deleteBill —— 删除账单
// 只能删除自己记的账（共享账本里也不能删对方的记录）
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
  const users = db.collection('users');
  const bills = db.collection('bills');

  const billId = String(event.id || '');
  if (!billId) {
    return { success: false, msg: '参数错误' };
  }

  try {
    // 1. 当前用户
    const meRes = await users.where({ openid: OPENID }).get();
    if (meRes.data.length === 0) {
      return { success: false, msg: '请先登录' };
    }
    const me = meRes.data[0];

    // 2. 找到账单并校验归属
    const billRes = await bills.doc(billId).get().catch(() => null);
    if (!billRes || !billRes.data) {
      return { success: false, msg: '账单不存在' };
    }
    const bill = billRes.data;
    const pair = bill.pairKey ? await getCurrentPair(OPENID) : null;
    if (!assertPairRecordAccess(bill, pair)) return { success: false, msg: '无权删除此账单' };
    if (bill.creatorId !== me._id) {
      return { success: false, msg: '只能删除自己记的账哦' };
    }

    // 3. 删除
    await bills.doc(billId).remove();
    return { success: true };
  } catch (err) {
    console.error('[deleteBill] 失败', err);
    return { success: false, msg: '删除失败，请重试' };
  }
};
