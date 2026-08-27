const crypto = require('crypto');
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const $ = _.aggregate;
const EXPENSE_CATEGORY_KEYS = new Set(['food', 'transport', 'shopping', 'fun', 'house', 'medical', 'gift', 'other']);

function money(value) { return Math.round((Number(value) || 0) * 100) / 100; }
function numberValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value && typeof value === 'object') {
    const wrapped = value.$numberDecimal !== undefined ? value.$numberDecimal
      : value.$numberDouble !== undefined ? value.$numberDouble
        : value.$numberInt !== undefined ? value.$numberInt
          : value.$numberLong;
    if (wrapped !== undefined) return Number(wrapped) || 0;
  }
  return Number(value) || 0;
}
function firstDefined(object, keys) {
  for (const key of keys) if (object && object[key] !== undefined) return object[key];
  return undefined;
}
function validMonth(value) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(value); }
function monthRange(yearMonth) {
  const [year, month] = yearMonth.split('-').map(Number);
  return { start: `${yearMonth}-01`, end: month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01` };
}
function pairInfo(me, partner) {
  const memberIds = [me._id, partner._id].sort();
  return { memberIds, pairKey: memberIds.join('|') };
}
function budgetId(pairKey, month) {
  return `budget_${crypto.createHash('sha256').update(`${pairKey}|${month}`).digest('hex')}`;
}
async function getBoundUsers(openid) {
  const users = db.collection('users');
  const meRes = await users.where({ openid }).get();
  if (meRes.data.length !== 1) return { error: { success: false, code: 'USER_NOT_FOUND', msg: '请先登录' } };
  const me = meRes.data[0];
  if (!me.partnerId) return { error: { success: false, code: 'NOT_BOUND', msg: '请先绑定伴侣' } };
  const partnerRes = await users.doc(me.partnerId).get().catch(() => null);
  const partner = partnerRes && partnerRes.data;
  if (!partner || partner.partnerId !== me._id) return { error: { success: false, code: 'BINDING_INVALID', msg: '绑定关系异常，请重新绑定' } };
  return { me, partner };
}
function buildBudget(record, expense, categoryExpense) {
  if (!record) return null;
  const totalBudget = money(record.totalBudget);
  const totalExpense = money(expense);
  const difference = money(totalBudget - totalExpense);
  const categoryBudgets = {};
  const categoryUsage = {};
  Object.keys(record.categoryBudgets || {}).forEach((key) => {
    if (!EXPENSE_CATEGORY_KEYS.has(key)) return;
    const budget = money(record.categoryBudgets[key]);
    const used = money(categoryExpense[key]);
    const remaining = money(budget - used);
    categoryBudgets[key] = budget;
    categoryUsage[key] = {
      budget, expense: used,
      availableAmount: remaining >= 0 ? remaining : 0,
      overspentAmount: remaining < 0 ? money(-remaining) : 0,
      status: remaining < 0 ? 'overspent' : 'available'
    };
  });
  return {
    month: record.month, totalBudget, categoryBudgets, totalExpense,
    availableAmount: difference >= 0 ? difference : 0,
    overspentAmount: difference < 0 ? money(-difference) : 0,
    status: difference < 0 ? 'overspent' : 'available', categoryUsage,
    updatedAt: record.updatedAt || null
  };
}

function buildStats(yearMonth, groups, memberIds, usersById, meId, partnerId) {
  let expense = 0, income = 0, count = 0;
  const categoryExpense = {};
  const categoryPeople = {};
  const peopleMap = {};
  memberIds.forEach((id) => {
    const user = usersById[id] || {};
    peopleMap[id] = { creatorId: id, creatorName: user.nickName || '伴侣', expense: 0, income: 0, count: 0 };
  });
  groups.forEach((group) => {
    const amount = group.totalAmount;
    const groupCount = group.count;
    const category = group.category || 'other';
    const creatorId = group.creatorId;
    count += groupCount;
    if (!peopleMap[creatorId]) peopleMap[creatorId] = { creatorId, creatorName: '伴侣', expense: 0, income: 0, count: 0 };
    peopleMap[creatorId].count += groupCount;
    if (group.type === 'income') {
      income += amount;
      peopleMap[creatorId].income += amount;
    } else {
      expense += amount;
      peopleMap[creatorId].expense += amount;
      categoryExpense[category] = (categoryExpense[category] || 0) + amount;
      if (!categoryPeople[category]) categoryPeople[category] = { mineExpense: 0, partnerExpense: 0 };
      if (creatorId === meId) categoryPeople[category].mineExpense += amount;
      else if (creatorId === partnerId) categoryPeople[category].partnerExpense += amount;
    }
  });
  expense = money(expense);
  income = money(income);
  const categoryStats = Object.keys(categoryExpense).map((category) => ({
    category,
    amount: money(categoryExpense[category]),
    totalExpense: money(categoryExpense[category]),
    mineExpense: money(categoryPeople[category] && categoryPeople[category].mineExpense),
    partnerExpense: money(categoryPeople[category] && categoryPeople[category].partnerExpense),
    percent: expense ? Math.round(categoryExpense[category] / expense * 100) : 0
  })).sort((a, b) => b.amount - a.amount);
  const peopleStats = Object.values(peopleMap).map((item) => ({
    creatorId: item.creatorId, creatorName: item.creatorName, expense: money(item.expense),
    income: money(item.income), count: item.count
  }));
  return { yearMonth, expense, income, balance: money(income - expense), count, categoryStats, peopleStats, categoryExpense };
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const yearMonth = String(event.yearMonth || '');
  if (!validMonth(yearMonth)) return { success: false, code: 'INVALID_MONTH', msg: '月份参数错误' };
  const type = event.type === undefined || event.type === '' ? 'all' : String(event.type);
  const person = event.person === undefined || event.person === '' ? 'all' : String(event.person);
  const category = event.category === undefined ? '' : String(event.category);
  const CATEGORY_KEYS = new Set(['food', 'transport', 'shopping', 'fun', 'house', 'medical', 'gift', 'other', 'salary', 'sidejob', 'redpacket', 'invest']);
  if (!['all', 'expense', 'income'].includes(type)) return { success: false, code: 'INVALID_TYPE', msg: '收支类型不合法' };
  if (!['all', 'mine', 'partner'].includes(person)) return { success: false, code: 'INVALID_PERSON', msg: '人员筛选不合法' };
  if (category && !CATEGORY_KEYS.has(category)) return { success: false, code: 'INVALID_CATEGORY', msg: '账单分类不合法' };
  try {
    const auth = await getBoundUsers(OPENID);
    if (auth.error) return auth.error;
    const range = monthRange(yearMonth);
    const memberIds = [auth.me._id, auth.partner._id];
    const pair = pairInfo(auth.me, auth.partner);
    const matchCondition = { pairKey: pair.pairKey, billDate: _.gte(range.start).and(_.lt(range.end)) };
    const aggregateRes = await db.collection('bills').aggregate()
      .match(matchCondition)
      .group({
        _id: { type: '$type', category: '$category', creatorId: '$creatorId' },
        totalAmount: $.sum('$amount'), count: $.sum(1)
      }).end();
    // CloudBase aggregate().end() 在真实环境返回 list；data 仅用于兼容旧 SDK/测试桩。
    const aggregateList = Array.isArray(aggregateRes.list)
      ? aggregateRes.list
      : (Array.isArray(aggregateRes.data) ? aggregateRes.data : []);
    const parsedGroups = aggregateList.map((group) => {
      const groupId = group && (group._id || group.id) || {};
      return {
        type: firstDefined(groupId, ['type']) !== undefined ? groupId.type : group.type,
        category: firstDefined(groupId, ['category']) !== undefined ? groupId.category : group.category,
        creatorId: firstDefined(groupId, ['creatorId']) !== undefined ? groupId.creatorId : group.creatorId,
        totalAmount: money(numberValue(firstDefined(group, ['totalAmount', 'amount', 'sum', 'total']))),
        count: Math.max(0, Math.trunc(numberValue(firstDefined(group, ['count', 'totalCount']))))
      };
    });
    const usersById = { [auth.me._id]: auth.me, [auth.partner._id]: auth.partner };
    const monthStats = buildStats(yearMonth, parsedGroups, memberIds, usersById, auth.me._id, auth.partner._id);
    const monthCategoryExpense = monthStats.categoryExpense;
    delete monthStats.categoryExpense;
    const filteredCreatorIds = person === 'mine' ? [auth.me._id] : person === 'partner' ? [auth.partner._id] : memberIds;
    const filteredGroups = parsedGroups.filter((group) =>
      filteredCreatorIds.includes(group.creatorId) &&
      (type === 'all' || group.type === type) &&
      (!category || group.category === category)
    );
    const filteredStats = buildStats(yearMonth, filteredGroups, filteredCreatorIds, usersById, auth.me._id, auth.partner._id);
    delete filteredStats.categoryExpense;
    const budgetRes = await db.collection('bill_budgets').doc(budgetId(pair.pairKey, yearMonth)).get().catch(() => null);
    const record = budgetRes && budgetRes.data && budgetRes.data.pairKey === pair.pairKey && budgetRes.data.month === yearMonth ? budgetRes.data : null;
    return {
      success: true,
      stats: monthStats,
      monthStats,
      filteredStats,
      budget: buildBudget(record, monthStats.expense, monthCategoryExpense)
    };
  } catch (err) {
    console.error('[getBillStats] 失败', err);
    return { success: false, code: 'STATS_FAILED', msg: '统计失败，请重试' };
  }
};
