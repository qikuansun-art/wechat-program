// 云函数：addBill —— 记一笔账
// 情侣共享账本：绑定后双方都可记账，账单记录 creatorId + partnerId 便于双方查询
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 允许的记账分类（与前端 pages/bill-edit 保持一致）
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
    if (!me.partnerId) {
      return { success: false, msg: '请先绑定伴侣再记账（共享账本）' };
    }

    // 2. 写入账单
    const categoryName = CATEGORIES[category] || '其他';
    const addRes = await bills.add({
      data: {
        openid: OPENID,                  // 记账人 openid
        creatorId: me._id,               // 记账人用户 _id
        creatorName: me.nickName || '伴侣',
        partnerId: me.partnerId,         // 对方 _id（共享账本查询用）
        type,                            // expense | income
        category,                        // 分类 key
        categoryName,                    // 分类名（冗余展示）
        amount: Math.round(amount * 100) / 100, // 保留两位小数
        matter,
        note,
        billDate,                        // 'YYYY-MM-DD' 账单归属日期
        createdAt: db.serverDate()
      }
    });

    return { success: true, id: addRes._id };
  } catch (err) {
    console.error('[addBill] 失败', err);
    return { success: false, msg: '记账失败，请重试' };
  }
};
