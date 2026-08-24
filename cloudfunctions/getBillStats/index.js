// 云函数：getBillStats —— 月度收支统计（情侣共享账本）
// 参数：yearMonth 'YYYY-MM'
// 返回：当月支出总额、收入总额、结余、支出分类占比 Top、总笔数
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

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

    // 2. 取当月全部账单（数据量小，云函数内 JS 汇总）
    const res = await bills.where({
      creatorId: _.in(userIds),
      billDate: db.RegExp({ regexp: `^${yearMonth}`, options: '' })
    }).limit(1000).get();

    // 3. 汇总
    let expense = 0;
    let income = 0;
    const catMap = {};      // 支出分类占比
    const list = res.data;

    list.forEach((b) => {
      const amount = Number(b.amount) || 0;
      if (b.type === 'income') {
        income += amount;
      } else {
        expense += amount;
        const key = b.category || 'other';
        catMap[key] = (catMap[key] || 0) + amount;
      }
    });

    // 分类占比排序（降序），带百分比
    const catTotal = Object.keys(catMap).reduce((s, k) => s + catMap[k], 0) || 1;
    const catList = Object.keys(catMap)
      .map((key) => ({
        category: key,
        amount: Math.round(catMap[key] * 100) / 100,
        percent: Math.round((catMap[key] / catTotal) * 100)
      }))
      .sort((a, b) => b.amount - a.amount);

    return {
      success: true,
      stats: {
        yearMonth,
        expense: Math.round(expense * 100) / 100,
        income: Math.round(income * 100) / 100,
        balance: Math.round((income - expense) * 100) / 100,
        count: list.length,
        catList
      }
    };
  } catch (err) {
    console.error('[getBillStats] 失败', err);
    return { success: false, msg: '统计失败，请重试' };
  }
};
