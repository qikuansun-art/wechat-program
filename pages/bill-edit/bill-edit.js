// pages/bill-edit/bill-edit.js —— 记一笔
const util = require('../../utils/util');
const billCategories = require('../../utils/bill-categories');

Page({
  data: {
    type: 'expense',           // expense | income
    amount: '',
    categories: billCategories.EXPENSE_CATEGORIES,
    selectedCategory: '',      // 选中的分类 key
    matter: '',                // 事项
    note: '',
    date: '',
    creatorName: '',           // 记录人（当前用户昵称）
    saving: false,
    // 编辑模式
    editMode: false,
    editId: '',
    // 邀请码区域
    bound: false,
    inviteCode: ''
  },

  onLoad(options) {
    // 获取当前用户昵称
    const app = getApp();
    const userInfo = app.globalData.userInfo;
    const creatorName = (userInfo && userInfo.nickName) || '我';
    const bound = !!(userInfo && userInfo.partnerId);

    const first = this.data.categories[0];
    this.setData({
      date: util.today(),
      selectedCategory: first.key,
      creatorName,
      bound
    });

    // 编辑模式：回填数据
    if (options && options.id) {
      this.setData({ editMode: true, editId: options.id });
      this.loadBillForEdit(options.id);
    } else if (!bound) {
      // 未绑定时加载邀请码
      this.loadInviteCode();
    }
  },

  /** 编辑模式：加载账单详情并回填 */
  async loadBillForEdit(billId) {
    wx.showLoading({ title: '加载中...', mask: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'getBillById',
        data: { id: billId }
      });
      wx.hideLoading();
      const result = res.result || {};
      if (!result.success || !result.bill) {
        util.toast(result.msg || '账单不存在');
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      const bill = result.bill;
      // 根据类型切换分类列表
      const categories = bill.type === 'income' ? billCategories.INCOME_CATEGORIES : billCategories.EXPENSE_CATEGORIES;
      this.setData({
        type: bill.type,
        categories,
        amount: String(bill.amount),
        selectedCategory: bill.category,
        matter: bill.matter || '',
        note: bill.note || '',
        date: bill.billDate
      });
    } catch (err) {
      wx.hideLoading();
      console.error('加载账单失败', err);
      util.toast('加载失败，请重试');
      setTimeout(() => wx.navigateBack(), 800);
    }
  },

  /** 获取我的邀请码 */
  async loadInviteCode() {
    try {
      const res = await wx.cloud.callFunction({ name: 'getMyInviteCode' });
      const result = res.result || {};
      if (result.success && result.bindCode) {
        this.setData({ inviteCode: result.bindCode });
      }
    } catch (err) {
      console.error('获取邀请码失败', err);
    }
  },

  /** 复制邀请码 */
  onCopyInviteCode() {
    if (!this.data.inviteCode) return;
    wx.setClipboardData({
      data: this.data.inviteCode,
      success() { util.toast('已复制'); }
    });
  },

  /** 切换支出/收入 */
  onTypeChange(e) {
    const type = e.currentTarget.dataset.type;
    if (type === this.data.type) return;
    const categories = type === 'income' ? billCategories.INCOME_CATEGORIES : billCategories.EXPENSE_CATEGORIES;
    this.setData({
      type,
      categories,
      selectedCategory: categories[0].key
    });
  },

  /** 金额输入 */
  onAmountInput(e) {
    let value = e.detail.value;
    value = value.replace(/[^\d.]/g, '');
    const dotIndex = value.indexOf('.');
    if (dotIndex >= 0) {
      value = value.slice(0, dotIndex + 1) + value.slice(dotIndex + 1).replace(/\./g, '').slice(0, 2);
      value = value.slice(0, dotIndex + 1).slice(0, 9) + value.slice(dotIndex + 1);
    } else {
      value = value.slice(0, 8);
    }
    this.setData({ amount: value });
  },

  /** 事项输入 */
  onMatterInput(e) {
    this.setData({ matter: e.detail.value });
  },

  /** 选择分类 */
  onCategoryTap(e) {
    this.setData({ selectedCategory: e.currentTarget.dataset.key });
  },

  /** 选择日期 */
  onDateChange(e) {
    this.setData({ date: e.detail.value });
  },

  /** 备注输入 */
  onNoteInput(e) {
    this.setData({ note: e.detail.value });
  },

  /** 保存（新建 / 编辑） */
  async onSave() {
    const { type, amount, matter, selectedCategory, note, date, saving, editMode, editId } = this.data;
    if (saving) return;

    const amountNum = parseFloat(amount);
    if (!amount || isNaN(amountNum) || amountNum <= 0) {
      util.toast('请输入金额');
      return;
    }
    if (!selectedCategory) {
      util.toast('请选择分类');
      return;
    }

    this.setData({ saving: true });
    wx.showLoading({ title: '保存中...', mask: true });

    try {
      let res;
      if (editMode) {
        // 编辑模式：调用 updateBill
        res = await wx.cloud.callFunction({
          name: 'updateBill',
          data: {
            id: editId,
            type,
            category: selectedCategory,
            amount: amountNum,
            matter: matter.trim(),
            note: note.trim(),
            billDate: date
          }
        });
      } else {
        // 新建模式：调用 addBill
        res = await wx.cloud.callFunction({
          name: 'addBill',
          data: {
            type,
            category: selectedCategory,
            amount: amountNum,
            matter: matter.trim(),
            note: note.trim(),
            billDate: date
          }
        });
      }
      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        util.toast(editMode ? '已更新' : '记好了 ❤');
        setTimeout(() => wx.navigateBack(), 600);
      } else {
        util.toast(result.msg || '保存失败，请重试');
      }
    } catch (err) {
      wx.hideLoading();
      console.error('保存账单失败', err);
      util.toast('保存失败，请检查网络');
    } finally {
      this.setData({ saving: false });
    }
  }
});