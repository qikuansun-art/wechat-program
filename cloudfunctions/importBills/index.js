// 云函数：importBills —— 批量导入账单（CSV 导入用）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const CATEGORIES = {
  food: '餐饮', transport: '交通', shopping: '购物',
  fun: '娱乐', house: '居住', medical: '医疗',
  gift: '人情', other: '其他',
  salary: '工资', sidejob: '兼职',
  redpacket: '红包', invest: '理财'
};

/** 清洗乱码字符：去除 U+FFFD、连续问号等乱码残留 */
function sanitize(str) {
  if (!str) return '';
  return String(str)
    .replace(/\uFFFD/g, '')          // Unicode 替换字符（编码错误标志）
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // 控制字符
    .replace(/^\?+$/, '')             // 全是问号 → 清空
    .trim();
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const { bills } = event; // [{ type, category, amount, note, billDate }]

  if (!Array.isArray(bills) || bills.length === 0) {
    return { success: false, msg: '没有可导入的账单' };
  }
  if (bills.length > 100) {
    return { success: false, msg: '单次最多导入 100 条' };
  }

  const users = db.collection('users');
  const billsCol = db.collection('bills');

  try {
    const meRes = await users.where({ openid: OPENID }).get();
    if (meRes.data.length === 0) return { success: false, msg: '请先登录' };
    const me = meRes.data[0];
    if (!me.partnerId) return { success: false, msg: '请先绑定伴侣再导入' };

    let success = 0;
    let fail = 0;

    for (const b of bills) {
      const type = b.type === 'income' ? 'income' : 'expense';
      const category = CATEGORIES[b.category] ? b.category : 'other';
      const amount = Math.round(Number(b.amount) * 100) / 100;
      const matter = sanitize(String(b.matter || '').slice(0, 30));
      const note = sanitize(String(b.note || '').slice(0, 50));
      const billDate = String(b.billDate || '');

      if (!amount || isNaN(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(billDate)) {
        fail++;
        continue;
      }

      await billsCol.add({
        data: {
          openid: OPENID,
          creatorId: me._id,
          creatorName: me.nickName || '伴侣',
          partnerId: me.partnerId,
          type, category,
          categoryName: CATEGORIES[category] || '其他',
          amount, matter, note, billDate,
          createdAt: db.serverDate()
        }
      });
      success++;
    }

    return { success: true, count: success, fail };
  } catch (err) {
    console.error('[importBills] 失败', err);
    return { success: false, msg: '导入失败，请重试' };
  }
};