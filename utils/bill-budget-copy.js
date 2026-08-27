const billCategories = require('./bill-categories');

const VALID_CATEGORY_KEYS = new Set(
  billCategories.EXPENSE_CATEGORIES.map((item) => item.key)
);

function previousMonth(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!match) return '';
  const date = new Date(Number(match[1]), Number(match[2]) - 2, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function buildCopiedForm(budget) {
  if (!budget) return null;
  const categoryBudgets = {};
  Object.keys(budget.categoryBudgets || {}).forEach((key) => {
    if (!VALID_CATEGORY_KEYS.has(key)) return;
    categoryBudgets[key] = String(budget.categoryBudgets[key]);
  });
  return { totalBudget: String(budget.totalBudget), categoryBudgets };
}

module.exports = { previousMonth, buildCopiedForm };
