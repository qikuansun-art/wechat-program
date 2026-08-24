// utils/bill-categories.js —— 记账分类定义
// 注意：key 必须与云函数 addBill 里的 CATEGORIES 保持一致
const EXPENSE_CATEGORIES = [
  { key: 'food', name: '餐饮', icon: '🍜' },
  { key: 'transport', name: '交通', icon: '🚗' },
  { key: 'shopping', name: '购物', icon: '🛍️' },
  { key: 'fun', name: '娱乐', icon: '🎮' },
  { key: 'house', name: '居住', icon: '🏠' },
  { key: 'medical', name: '医疗', icon: '💊' },
  { key: 'gift', name: '人情', icon: '🎁' },
  { key: 'other', name: '其他', icon: '📦' }
];

const INCOME_CATEGORIES = [
  { key: 'salary', name: '工资', icon: '💰' },
  { key: 'sidejob', name: '兼职', icon: '💼' },
  { key: 'redpacket', name: '红包', icon: '🧧' },
  { key: 'invest', name: '理财', icon: '📈' },
  { key: 'other', name: '其他', icon: '📦' }
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
