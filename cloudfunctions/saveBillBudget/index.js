const crypto = require('crypto');
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const MAX_AMOUNT = 99999999;
const EXPENSE_CATEGORY_KEYS = new Set(['food', 'transport', 'shopping', 'fun', 'house', 'medical', 'gift', 'other']);

class BusinessError extends Error {
  constructor(message, code) { super(message); this.name = 'BusinessError'; this.code = code; }
}
function validMonth(value) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(value); }
function validAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_AMOUNT &&
    Math.abs(value * 100 - Math.round(value * 100)) < 1e-8;
}
function money(value) { return Math.round(value * 100) / 100; }
function pairInfo(me, partner) {
  const memberIds = [me._id, partner._id].sort();
  return { memberIds, pairKey: memberIds.join('|') };
}
function budgetId(pairKey, month) {
  return `budget_${crypto.createHash('sha256').update(`${pairKey}|${month}`).digest('hex')}`;
}
function cleanCategoryBudgets(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new BusinessError('分类预算格式不正确', 'INVALID_CATEGORY_BUDGETS');
  const result = {};
  Object.keys(input).forEach((key) => {
    if (!EXPENSE_CATEGORY_KEYS.has(key)) throw new BusinessError('包含不允许的预算分类', 'INVALID_BUDGET_CATEGORY');
    if (!validAmount(input[key])) throw new BusinessError('分类预算金额不正确', 'INVALID_CATEGORY_AMOUNT');
    result[key] = money(input[key]);
  });
  return result;
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  const month = String(event.month || '');
  if (!validMonth(month)) return { success: false, code: 'INVALID_MONTH', msg: '月份参数错误' };
  if (!validAmount(event.totalBudget)) return { success: false, code: 'INVALID_TOTAL_BUDGET', msg: '月总预算金额不正确' };
  let categoryBudgets;
  try { categoryBudgets = cleanCategoryBudgets(event.categoryBudgets === undefined ? {} : event.categoryBudgets); }
  catch (err) { return { success: false, code: err.code, msg: err.message }; }

  try {
    const users = db.collection('users');
    const meRes = await users.where({ openid: OPENID }).get();
    if (meRes.data.length !== 1) return { success: false, code: 'USER_NOT_FOUND', msg: '请先登录' };
    const initialMe = meRes.data[0];
    if (!initialMe.partnerId) return { success: false, code: 'NOT_BOUND', msg: '请先绑定伴侣' };
    let committedBudget = null;
    await db.runTransaction(async (transaction) => {
      const meRef = transaction.collection('users').doc(initialMe._id);
      const meResInTx = await meRef.get();
      const me = meResInTx && meResInTx.data;
      if (!me || me.openid !== OPENID || !me.partnerId) throw new BusinessError('绑定关系已变化，请刷新后重试', 'BINDING_INVALID');
      const partnerRef = transaction.collection('users').doc(me.partnerId);
      const partnerRes = await partnerRef.get().catch(() => null);
      const partner = partnerRes && partnerRes.data;
      if (!partner || partner.partnerId !== me._id) throw new BusinessError('绑定关系异常，请重新绑定', 'BINDING_INVALID');
      const pair = pairInfo(me, partner);
      const documentId = budgetId(pair.pairKey, month);
      const budgetRef = transaction.collection('bill_budgets').doc(documentId);
      const existingRes = await budgetRef.get().catch(() => null);
      const existing = existingRes && existingRes.data;
      const now = db.serverDate();
      const record = {
        pairKey: pair.pairKey, memberIds: pair.memberIds, month,
        totalBudget: money(event.totalBudget), categoryBudgets,
        createdAt: existing && existing.createdAt ? existing.createdAt : now,
        updatedAt: now, updatedBy: me._id
      };
      if (existing) await budgetRef.update({ data: record });
      else await budgetRef.set({ data: record });
      committedBudget = Object.assign({ _id: documentId }, record);
      return committedBudget;
    });
    return { success: true, budget: committedBudget };
  } catch (err) {
    if (err && err.name === 'BusinessError') return { success: false, code: err.code, msg: err.message };
    console.error('[saveBillBudget] 失败', err);
    return { success: false, code: 'SAVE_FAILED', msg: '预算保存状态未确认，请刷新后查看' };
  }
};
