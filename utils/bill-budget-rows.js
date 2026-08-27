const billCategories = require('./bill-categories');

function money(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function formatMoneyCompact(value) {
  const amount = money(value);
  const fixed = amount.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  const parts = fixed.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

function buildCategoryBudgetRows(monthStats, budget) {
  const statsMap = {};
  ((monthStats && monthStats.categoryStats) || []).forEach((item) => {
    statsMap[item.category] = item;
  });
  const categoryBudgets = budget && budget.categoryBudgets || {};
  return billCategories.EXPENSE_CATEGORIES.map((category, order) => {
    const stats = statsMap[category.key] || {};
    const mineExpense = money(stats.mineExpense);
    const partnerExpense = money(stats.partnerExpense);
    const totalExpense = money(mineExpense + partnerExpense);
    const hasBudget = Object.prototype.hasOwnProperty.call(categoryBudgets, category.key);
    const categoryBudget = hasBudget ? money(categoryBudgets[category.key]) : null;
    let status = 'unset';
    let remainingAmount = 0;
    let overspentAmount = 0;
    let mineWidth = 0;
    let partnerWidth = 0;
    if (!hasBudget) {
      if (totalExpense > 0) {
        mineWidth = mineExpense / totalExpense * 100;
        partnerWidth = partnerExpense / totalExpense * 100;
      }
    } else if (categoryBudget === 0) {
      if (totalExpense > 0) {
        status = 'overspent';
        overspentAmount = totalExpense;
        mineWidth = mineExpense / totalExpense * 100;
        partnerWidth = partnerExpense / totalExpense * 100;
      } else status = 'normal';
    } else if (totalExpense > categoryBudget) {
      status = 'overspent';
      overspentAmount = money(totalExpense - categoryBudget);
      mineWidth = mineExpense / totalExpense * 100;
      partnerWidth = partnerExpense / totalExpense * 100;
    } else {
      status = totalExpense === categoryBudget ? 'full' : 'normal';
      remainingAmount = money(categoryBudget - totalExpense);
      mineWidth = mineExpense / categoryBudget * 100;
      partnerWidth = partnerExpense / categoryBudget * 100;
    }
    return {
      key: category.key,
      category: category.key,
      categoryName: category.name,
      name: category.name,
      icon: category.icon,
      order,
      budget: categoryBudget,
      budgetText: hasBudget ? `¥${formatMoneyCompact(categoryBudget)}` : '--',
      mineExpense,
      partnerExpense,
      totalExpense,
      mineText: `¥${formatMoneyCompact(mineExpense)}`,
      partnerText: `¥${formatMoneyCompact(partnerExpense)}`,
      mineWidth: Math.max(0, Math.min(100, mineWidth)).toFixed(2),
      partnerWidth: Math.max(0, Math.min(100, partnerWidth)).toFixed(2),
      remainingAmount,
      remainingText: remainingAmount > 0 ? `剩余 ¥${formatMoneyCompact(remainingAmount)}` : '',
      overspentAmount,
      overText: overspentAmount > 0 ? `超支 ¥${formatMoneyCompact(overspentAmount)}` : '',
      resultText: !hasBudget
        ? '--'
        : overspentAmount > 0
          ? `超支 ¥${formatMoneyCompact(overspentAmount)}`
          : `¥${formatMoneyCompact(remainingAmount)}`,
      status
    };
  });
}

module.exports = { formatMoneyCompact, buildCategoryBudgetRows };
