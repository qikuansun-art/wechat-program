const billCategories = require('./bill-categories');

const EXPENSE_CATEGORY_KEYS = new Set(
  billCategories.EXPENSE_CATEGORIES.map((item) => item.key)
);

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function buildSummaryBudget(budget, filters, filteredExpense) {
  if (!budget) return null;
  const category = filters && filters.category || '';
  const type = filters && filters.type || 'all';
  if (!category || type === 'income' || !EXPENSE_CATEGORY_KEYS.has(category)) return budget;

  const categoryBudgets = budget.categoryBudgets || {};
  if (!Object.prototype.hasOwnProperty.call(categoryBudgets, category)) return null;

  const totalBudget = money(categoryBudgets[category]);
  const totalExpense = money(filteredExpense);
  const difference = money(totalBudget - totalExpense);
  return {
    totalBudget,
    totalExpense,
    availableAmount: difference >= 0 ? difference : 0,
    overspentAmount: difference < 0 ? money(-difference) : 0,
    status: difference < 0 ? 'overspent' : 'available'
  };
}

module.exports = { buildSummaryBudget };
