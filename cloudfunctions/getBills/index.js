// 云函数：getBills —— 查询账单（情侣共享账本）
// 参数：yearMonth 'YYYY-MM'（必填），type 可选（expense | income | '' 全部）
// 返回：该月双方记的所有账单，按 billDate 倒序
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

/** 清洗乱码字符 */
function sanitize(str) {
  if (!str) return '';
  return String(str)
    .replace(/\uFFFD/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/^\?+$/, '')
    .trim();
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  const users = db.collection('users');
  const bills = db.collection('bills');

  const yearMonth = String(event.yearMonth || '');
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
    return { success: false, msg: '参数错误' };
  }

  try {
    // 1. 当前用户 + 绑定关系
    const meRes = await users.where({ openid: OPENID }).get();
    if (meRes.data.length === 0) {
      return { success: false, msg: '请先登录' };
    }
    const me = meRes.data[0];
    const userIds = [me._id];
    if (me.partnerId) userIds.push(me.partnerId);

    // 2. 构建查询：该月 + 双方 + 可选类型
    const where = {
      creatorId: _.in(userIds),
      billDate: db.RegExp({ regexp: `^${yearMonth}`, options: '' })
    };
    if (event.type === 'expense' || event.type === 'income') {
      where.type = event.type;
    }

    const res = await bills.where(where).orderBy('billDate', 'desc').orderBy('createdAt', 'desc').limit(500).get();

    // 3. 补充分组友好字段（前端按 billDate 分组）
    const list = res.data.map((item) => ({
      id: item._id,
      type: item.type,
      category: item.category,
      categoryName: item.categoryName,
      amount: item.amount,
      matter: sanitize(item.matter) || '',
      note: sanitize(item.note),
      billDate: item.billDate,
      creatorName: item.creatorName,
      creatorId: item.creatorId,
      mine: item.creatorId === me._id,   // 是否自己记的账（可删除）
      createdAt: item.createdAt
    }));

    return { success: true, list };
  } catch (err) {
    console.error('[getBills] 失败', err);
    return { success: false, msg: '查询失败，请重试' };
  }
};
