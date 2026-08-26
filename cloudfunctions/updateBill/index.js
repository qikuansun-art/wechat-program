// 云函数：updateBill —— 更新账单
// 只能修改自己创建的账单（归属权校验）
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
  if (!record.pairKey) return { success: false, code: 'DATA_ISOLATION_ERROR', msg: '账单缺少数据隔离标识' };
  if (record.pairKey !== pair.pairKey) return { success: false, code: 'ACCESS_DENIED', msg: '无权修改此账单' };
  return null;
}

// 允许的记账分类（与 addBill 保持一致）
const CATEGORIES = {
  food: '餐饮',
  transport: '交通',
  shopping: '购物',
  fun: '娱乐',
  house: '居住',
  medical: '医疗',
  gift: '人情',
  other: '其他',
  salary: '工资',
  sidejob: '兼职',
  redpacket: '红包',
  invest: '理财'
};

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const users = db.collection('users');
  const bills = db.collection('bills');

  const billId = String(event.id || '');
  if (!billId) {
    return { success: false, msg: '参数错误' };
  }

  const type = event.type === 'income' ? 'income' : 'expense';
  const category = String(event.category || 'other');
  const amount = Number(event.amount);
  const matter = String(event.matter || '').trim().slice(0, 30);
  const note = String(event.note || '').trim().slice(0, 50);
  const billDate = String(event.billDate || '');

  // 校验
  if (!amount || isNaN(amount) || amount <= 0) {
    return { success: false, msg: '请输入正确的金额' };
  }
  if (amount > 99999999) {
    return { success: false, msg: '金额过大，请检查' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(billDate)) {
    return { success: false, msg: '请选择记账日期' };
  }

  try {
    // 1. 当前用户
    const meRes = await users.where({ openid: OPENID }).get();
    if (meRes.data.length === 0) {
      return { success: false, msg: '请先登录' };
    }
    const me = meRes.data[0];

    // 2. 查询原账单并校验归属
    const billRes = await bills.doc(billId).get().catch(() => null);
    if (!billRes || !billRes.data) {
      return { success: false, msg: '账单不存在' };
    }
    const bill = billRes.data;
    const pair = await getCurrentPair(OPENID);
    if (pair.error) return { success: false, code: 'ACCESS_DENIED', msg: '当前情侣关系无效' };
    const accessError = pairAccessError(bill, pair);
    if (accessError) return accessError;
    if (bill.creatorId !== me._id) {
      return { success: false, msg: '只能修改自己记的账哦' };
    }

    // 3. 更新
    const categoryName = CATEGORIES[category] || '其他';
    await bills.doc(billId).update({
      data: {
        type,
        category,
        categoryName,
        amount: Math.round(amount * 100) / 100,
        matter,
        note,
        billDate,
        updatedAt: db.serverDate()
      }
    });

    console.log('[updateBill] 成功，billId:', billId);
    return { success: true };
  } catch (err) {
    console.error('[updateBill] 失败', err);
    return { success: false, msg: '更新失败，请重试' };
  }
};
