// utils/bill-categories.js —— 记账分类定义
// 注意：key 必须与云函数 addBill 里的 CATEGORIES 保持一致
const EXPENSE_CATEGORIES = [
  { key: 'food', name: '餐饮', icon: '🍜', type: 'expense' },
  { key: 'transport', name: '交通', icon: '🚗', type: 'expense' },
  { key: 'shopping', name: '购物', icon: '🛍️', type: 'expense' },
  { key: 'fun', name: '娱乐', icon: '🎮', type: 'expense' },
  { key: 'house', name: '居住', icon: '🏠', type: 'expense' },
  { key: 'medical', name: '医疗', icon: '💊', type: 'expense' },
  { key: 'gift', name: '人情', icon: '🎁', type: 'expense' },
  { key: 'other', name: '其他', icon: '📦', type: 'expense' }
];

const INCOME_CATEGORIES = [
  { key: 'salary', name: '工资', icon: '💰', type: 'income' },
  { key: 'sidejob', name: '兼职', icon: '💼', type: 'income' },
  { key: 'redpacket', name: '红包', icon: '🧧', type: 'income' },
  { key: 'invest', name: '理财', icon: '📈', type: 'income' },
  { key: 'other', name: '其他', icon: '📦', type: 'income' }
];

const ALL = EXPENSE_CATEGORIES.concat(INCOME_CATEGORIES);

function getCategoryIcon(key) {
  const found = ALL.find((c) => c.key === key);
  return found ? found.icon : '📦';
}

function getCategoryName(key) {
  const found = ALL.find((c) => c.key === key);
  return found ? found.name : '其他';
}

module.exports = {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  getCategoryIcon,
  getCategoryName
};
