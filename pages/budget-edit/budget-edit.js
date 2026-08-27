const util = require('../../utils/util');
const billCategories = require('../../utils/bill-categories');
const budgetCopy = require('../../utils/bill-budget-copy');

function normalizeMoneyInput(value) {
  let next = String(value || '').replace(/[^\d.]/g, '');
  const dot = next.indexOf('.');
  if (dot >= 0) next = next.slice(0, dot + 1) + next.slice(dot + 1).replace(/\./g, '').slice(0, 2);
  return dot >= 0 ? next.slice(0, 9) : next.slice(0, 8);
}

function validMoney(value, required) {
  if (value === '') return !required;
  return /^\d+(\.\d{1,2})?$/.test(value) && Number(value) >= 0;
}

function sameBudget(actual, target) {
  if (!actual || Math.round(Number(actual.totalBudget) * 100) !== Math.round(target.totalBudget * 100)) return false;
  const actualCategories = actual.categoryBudgets || {};
  const actualKeys = Object.keys(actualCategories).sort();
  const targetKeys = Object.keys(target.categoryBudgets).sort();
  return actualKeys.length === targetKeys.length && targetKeys.every((key, index) =>
    key === actualKeys[index] && Math.round(Number(actualCategories[key]) * 100) === Math.round(target.categoryBudgets[key] * 100));
}

Page({
  data: { month: '', monthText: '', totalBudget: '', categories: [], saving: false, copyingPrevious: false },

  onLoad(options) {
    const month = /^\d{4}-\d{2}$/.test(options.month || '') ? options.month : util.monthOf(new Date());
    const categories = billCategories.EXPENSE_CATEGORIES.map((item) => Object.assign({}, item, { amount: '' }));
    this.setData({ month, monthText: `${Number(month.slice(0, 4))}年${Number(month.slice(5))}月预算`, categories });
    const channel = this.getOpenerEventChannel && this.getOpenerEventChannel();
    if (channel && channel.on) channel.on('budgetData', ({ budget }) => this.fillBudget(budget));
  },

  fillBudget(budget) {
    const copied = budgetCopy.buildCopiedForm(budget);
    if (!copied) return;
    const values = copied.categoryBudgets;
    this.setData({
      totalBudget: copied.totalBudget,
      categories: this.data.categories.map((item) => Object.assign({}, item, {
        amount: Object.prototype.hasOwnProperty.call(values, item.key) ? String(values[item.key]) : ''
      }))
    });
  },

  previousMonth() {
    return budgetCopy.previousMonth(this.data.month);
  },

  monthLabel(month) {
    return `${Number(month.slice(0, 4))}年${Number(month.slice(5))}月`;
  },

  hasFormContent() {
    return this.data.totalBudget !== '' || this.data.categories.some((item) => item.amount !== '');
  },

  confirmUsePrevious(previousMonth) {
    const hasContent = this.hasFormContent();
    const content = hasContent
      ? `将用 ${this.monthLabel(previousMonth)} 的总预算和分类预算覆盖当前页面已填写的预算内容，但不会立即保存。`
      : `将把 ${this.monthLabel(previousMonth)} 的总预算和分类预算填入当前月份，之后仍可继续修改。`;
    return new Promise((resolve) => {
      wx.showModal({
        title: '使用上个月预算？',
        content,
        cancelText: '取消',
        confirmText: '使用',
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false)
      });
    });
  },

  async onUsePreviousBudget() {
    if (this.data.copyingPrevious || this.data.saving) return;
    const previousMonth = this.previousMonth();
    this.setData({ copyingPrevious: true });
    wx.showLoading({ title: '读取中...', mask: true });
    let previousBudget = null;
    try {
      const res = await wx.cloud.callFunction({ name: 'getBillStats', data: { yearMonth: previousMonth } });
      const result = res && res.result || {};
      if (!result.success) throw new Error(result.msg || 'getBillStats failed');
      previousBudget = result.budget || null;
    } catch (err) {
      console.error('[BudgetCopyPrevious] load failed', err);
      wx.hideLoading();
      this.setData({ copyingPrevious: false });
      util.toast('上个月预算读取失败');
      return;
    }
    wx.hideLoading();
    if (!previousBudget) {
      this.setData({ copyingPrevious: false });
      util.toast('上个月没有设置预算');
      return;
    }
    const confirmed = await this.confirmUsePrevious(previousMonth);
    if (confirmed) this.fillBudget(previousBudget);
    this.setData({ copyingPrevious: false });
  },

  onTotalInput(e) {
    const value = normalizeMoneyInput(e.detail.value);
    this.setData({ totalBudget: value });
    return value;
  },

  onCategoryInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const value = normalizeMoneyInput(e.detail.value);
    this.setData({ [`categories[${index}].amount`]: value });
    return value;
  },

  buildPayload() {
    if (!validMoney(this.data.totalBudget, true)) throw new Error('请输入正确的月总预算（最多两位小数）');
    const categoryBudgets = {};
    this.data.categories.forEach((item) => {
      if (!validMoney(item.amount, false)) throw new Error(`${item.name}预算格式不正确`);
      if (item.amount !== '') categoryBudgets[item.key] = Number(item.amount);
    });
    return { month: this.data.month, totalBudget: Number(this.data.totalBudget), categoryBudgets };
  },

  async reconcile(payload) {
    try {
      const res = await wx.cloud.callFunction({ name: 'getBillStats', data: { yearMonth: payload.month } });
      const result = (res && res.result) || {};
      return !!result.success && sameBudget(result.budget, payload);
    } catch (err) {
      return false;
    }
  },

  finishSuccess() {
    const channel = this.getOpenerEventChannel && this.getOpenerEventChannel();
    if (channel && channel.emit) channel.emit('budgetSaved');
    util.toast('预算已保存');
    setTimeout(() => wx.navigateBack(), 500);
  },

  async onSave() {
    if (this.data.saving) return;
    let payload;
    try { payload = this.buildPayload(); } catch (err) { util.toast(err.message); return; }
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中...', mask: true });
    let confirmed = false;
    try {
      const res = await wx.cloud.callFunction({ name: 'saveBillBudget', data: payload });
      confirmed = !!(res.result && res.result.success);
      if (!confirmed) confirmed = await this.reconcile(payload);
    } catch (err) {
      confirmed = await this.reconcile(payload);
    }
    wx.hideLoading();
    this.setData({ saving: false });
    if (confirmed) this.finishSuccess();
    else util.toast('保存状态未确认，请稍后查看');
  }
});
