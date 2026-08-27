// pages/bill/bill.js —— 账单页（Tab）：情侣共享账本
const util = require('../../utils/util');
const billCategories = require('../../utils/bill-categories');
const billBudgetRows = require('../../utils/bill-budget-rows');
const billSummary = require('../../utils/bill-summary');

// 金额格式化：千分位 + 两位小数
function formatMoney(n) {
  const num = Number(n) || 0;
  const fixed = num.toFixed(2);
  const parts = fixed.split('.');
  const intWithComma = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return intWithComma + '.' + parts[1];
}


Page({
  data: {
    loading: true,
    loadingMore: false,
    statsLoading: true,
    listError: false,
    statsError: false,
    notBound: false,
    activeBillSheet: 0,
    billSheetCurrent: 0,
    categoryBudgetRows: [],
    yearMonth: '',
    yearMonthText: '',
    monthSwiperCurrent: 1,
    monthSwiperDuration: 280,
    monthSlides: [],
    // 统计
    stats: {
      expense: 0, expenseText: '0.00',
      income: 0, incomeText: '0.00',
      balance: 0, balanceText: '0.00',
      count: 0, catList: []
    },
    // 筛选
    filterOn: false,
    filterType: 'all',     // all | expense | income
    filterPerson: 'all',   // all | mine | partner
    filterPersonText: '',
    filterCategory: '',
    filterCategoryText: '',
    filterCategoryOptions: [],
    // 数据
    filteredList: [],
    page: 0,
    hasMore: false,
    budget: null,
    summaryBudget: null,
    catIconMap: {},
    catNameMap: {},
    // 左滑操作
    swipedId: ''
  },

  onLoad() {
    this._billListRequestId = 0;
    this._billStatsRequestId = 0;
    this._billViewVersion = 0;
    this._loaded = false;
    this._billDataDirty = false;
    this._budgetDirty = false;
    this._billStats = null;
    this._loadingMore = false;
    this._paginationObserver = null;
    const catIconMap = {};
    const catNameMap = {};
    billCategories.EXPENSE_CATEGORIES.concat(billCategories.INCOME_CATEGORIES).forEach((c) => {
      catIconMap[c.key] = c.icon;
      catNameMap[c.key] = c.name;
    });
    this._expenseFilterCategories = billCategories.EXPENSE_CATEGORIES.map((item) => ({ key: item.key, name: item.name }));
    this._incomeFilterCategories = billCategories.INCOME_CATEGORIES.map((item) => ({ key: item.key, name: item.name }));
    this._allFilterCategories = Object.keys(catNameMap).map((key) => ({ key, name: catNameMap[key] }));
    this.setData({
      catIconMap,
      catNameMap,
      filterCategoryOptions: this.buildCategoryOptions('all')
    });

    const now = new Date();
    const yearMonth = util.monthOf(now);
    this.setData({
      yearMonth,
      yearMonthText: util.monthText(now),
      monthSlides: this.buildMonthSlides(yearMonth)
    });
  },

  onReady() {
    this._paginationObserver = this.createIntersectionObserver({ thresholds: [0, 1] });
    this._paginationObserver
      .relativeToViewport({ bottom: 100 })
      .observe('.pagination-sentinel', (res) => {
        if (res.intersectionRatio > 0) this.loadMore();
      });
  },

  onUnload() {
    if (this._paginationObserver) this._paginationObserver.disconnect();
    this._paginationObserver = null;
  },

  onShow() {
    if (!this.data.yearMonth) return;
    if (!this._loaded || this._billDataDirty) {
      this._billDataDirty = false;
      this.refreshView();
    } else if (this._budgetDirty) {
      this._budgetDirty = false;
      this.loadBillStats(this._billViewVersion);
    }
  },

  onReachBottom() { this.loadMore(); },

  onPullDownRefresh() {
    this.refreshView().finally(() => wx.stopPullDownRefresh());
  },

  async refreshView(options = {}) {
    const preserveData = !!options.preserveData;
    const version = ++this._billViewVersion;
    this._loaded = true;
    ++this._billListRequestId;
    ++this._billStatsRequestId;
    this._loadingMore = false;
    this._billStats = null;
    const resetPatch = {
      page: 0, hasMore: false, loading: true, loadingMore: false,
      statsLoading: true, listError: false, statsError: false, swipedId: ''
    };
    if (!preserveData) Object.assign(resetPatch, {
      filteredList: [], budget: null, summaryBudget: null, categoryBudgetRows: [],
      stats: { expense: 0, expenseText: '0.00', income: 0, incomeText: '0.00', balance: 0, balanceText: '0.00', count: 0, categoryStats: [], peopleStats: [] }
    });
    this.setData(resetPatch);
    await Promise.allSettled([
      this.loadBillFirstPage(version),
      this.loadBillStats(version)
    ]);
  },

  loadData() { return this.refreshView(); },

  loadBillFirstPage(version) {
    return this.loadBillPage(0, true, typeof version === 'number' ? version : this._billViewVersion);
  },

  onRetryList() { this.loadBillFirstPage(this._billViewVersion); },

  async loadBillPage(page, replace, version) {
    if (!replace && (this._loadingMore || this.data.loadingMore || !this.data.hasMore)) return;
    const requestId = ++this._billListRequestId;
    const yearMonth = this.data.yearMonth;
    const { filterType, filterPerson, filterCategory } = this.data;
    if (!replace) {
      this._loadingMore = true;
      this.setData({ loadingMore: true });
    }
    try {
      const res = await wx.cloud.callFunction({
        name: 'getBills',
        data: { yearMonth, page, pageSize: 50, type: filterType, person: filterPerson, category: filterCategory }
      });
      if (requestId !== this._billListRequestId || version !== this._billViewVersion) return;
      const result = res.result || {};
      if (result.success === false) {
        this.setData({ loading: false, loadingMore: false, notBound: result.code === 'NOT_BOUND' || result.code === 'BINDING_INVALID', listError: true });
        return;
      }
      const shown = (result.list || []).map((b) => this.formatBill(b));
      if (replace) {
        this.setData({ filteredList: shown, page, hasMore: !!result.hasMore, loading: false, loadingMore: false, listError: false, notBound: false });
      } else {
        const patch = { page, hasMore: !!result.hasMore, loadingMore: false };
        const startIndex = this.data.filteredList.length;
        shown.forEach((item, index) => { patch[`filteredList[${startIndex + index}]`] = item; });
        this.setData(patch);
      }
    } catch (err) {
      if (requestId !== this._billListRequestId || version !== this._billViewVersion) return;
      console.error('加载账单失败', err);
      this.setData({ loading: false, loadingMore: false, listError: true });
      util.toast(replace ? '账单列表加载失败' : '加载更多失败，请重试');
    } finally {
      if (!replace && requestId === this._billListRequestId) {
        this._loadingMore = false;
        if (this.data.loadingMore) this.setData({ loadingMore: false });
      }
    }
  },

  formatBill(b) {
    return {
      id: b.id,
      type: b.type,
      category: b.category,
      categoryName: billCategories.getCategoryName(b.category),
      matter: b.matter,
      note: b.note,
      amount: b.amount,
      amountText: formatMoney(b.amount),
      creatorName: b.creatorName,
      creatorId: b.creatorId,
      mine: b.mine,
      dateShort: (b.billDate || '').slice(5)
    };
  },

  async loadBillStats(version) {
    const requestId = ++this._billStatsRequestId;
    const { yearMonth, filterType, filterPerson, filterCategory } = this.data;
    this.setData({ statsLoading: true, statsError: false });
    try {
      const res = await wx.cloud.callFunction({
        name: 'getBillStats',
        data: { yearMonth, type: filterType, person: filterPerson, category: filterCategory }
      });
      if (requestId !== this._billStatsRequestId || version !== this._billViewVersion) return;
      const result = res.result || {};
      if (!result.success) throw new Error(result.msg || 'getBillStats failed');
      const raw = result.filteredStats || result.stats || {};
      const monthStats = result.monthStats || result.stats || {};
      this._billStats = monthStats;
      const stats = {
        expense: Number(raw.expense) || 0, expenseText: formatMoney(raw.expense),
        income: Number(raw.income) || 0, incomeText: formatMoney(raw.income),
        balance: Number(raw.balance) || 0, balanceText: formatMoney(raw.balance),
        count: Number(raw.count) || 0,
        categoryStats: raw.categoryStats || [], peopleStats: raw.peopleStats || []
      };
      const budget = this.formatBudget(result.budget);
      const summaryBudget = this.formatBudget(billSummary.buildSummaryBudget(result.budget, {
        type: filterType,
        category: filterCategory
      }, stats.expense));
      const categoryBudgetRows = billBudgetRows.buildCategoryBudgetRows(monthStats, result.budget);
      this.setData({ stats, budget, summaryBudget, categoryBudgetRows, statsLoading: false, statsError: false, notBound: false });
    } catch (err) {
      if (requestId !== this._billStatsRequestId || version !== this._billViewVersion) return;
      console.error('加载账单统计失败', err);
      this.setData({ statsLoading: false, statsError: true });
    }
  },

  formatBudget(budget) {
    if (!budget) return null;
    return Object.assign({}, budget, {
      totalBudgetText: formatMoney(budget.totalBudget), expenseText: formatMoney(budget.totalExpense),
      resultText: formatMoney(budget.status === 'overspent' ? budget.overspentAmount : budget.availableAmount),
      resultLabel: budget.status === 'overspent' ? '已超支' : '可用额度'
    });
  },

  onBillSheetTabTap(e) {
    const index = Number(e.currentTarget.dataset.index);
    if (index !== 0 && index !== 1) return;
    this.setData({ billSheetCurrent: index });
  },

  onBillSheetAnimationFinish(e) {
    const index = Number(e.detail.current);
    if (index !== 0 && index !== 1) return;
    this.setData({ activeBillSheet: index, billSheetCurrent: index });
  },

  buildMonthSlides(yearMonth) {
    return [-1, 0, 1].map((offset) => {
      const value = this.shiftYearMonth(yearMonth, offset);
      const [year, month] = value.split('-').map(Number);
      return { value, text: `${year}年${month}月` };
    });
  },

  shiftYearMonth(yearMonth, delta) {
    const [year, month] = yearMonth.split('-').map(Number);
    return util.monthOf(new Date(year, month - 1 + delta, 1));
  },

  onPreMonth() { this.requestMonthChange(-1); },
  onNextMonth() { this.requestMonthChange(1); },

  onMonthArrowTap(e) {
    this.requestMonthChange(Number(e.currentTarget.dataset.direction));
  },

  requestMonthChange(direction) {
    if (this._monthSwiperAnimating || (direction !== -1 && direction !== 1)) return;
    this._monthSwiperAnimating = true;
    this.setData({ monthSwiperDuration: 280, monthSwiperCurrent: direction < 0 ? 0 : 2 });
  },

  onMonthSwiperAnimationFinish(e) {
    const index = Number(e.detail.current);
    this._monthSwiperAnimating = false;
    if (index === 1) return;
    if (index !== 0 && index !== 2) return;
    this.changeMonth(index === 0 ? -1 : 1);
  },

  changeMonth(direction) {
    const yearMonth = this.shiftYearMonth(this.data.yearMonth, direction);
    const [year, month] = yearMonth.split('-').map(Number);
    this.setData({
      yearMonth,
      yearMonthText: `${year}年${month}月`,
      monthSlides: this.buildMonthSlides(yearMonth),
      monthSwiperCurrent: 1,
      monthSwiperDuration: 0
    }, () => this.setData({ monthSwiperDuration: 280 }));
    this.refreshView({ preserveData: true });
  },

  /** 筛选：收支类型 */
  onFilterType(e) {
    const type = e.currentTarget.dataset.type;
    if (type === this.data.filterType) return;
    const categories = this.getFilterCategories(type);
    const categoryValid = !this.data.filterCategory || categories.some((item) => item.key === this.data.filterCategory);
    this.setData({
      filterType: type,
      filterCategory: categoryValid ? this.data.filterCategory : '',
      filterCategoryText: categoryValid ? this.data.filterCategoryText : '',
      filterCategoryOptions: this.buildCategoryOptions(type),
      filterOn: type !== 'all' || this.data.filterPerson !== 'all' || (categoryValid && !!this.data.filterCategory)
    });
    this.reloadFilteredList();
  },

  /** 筛选：按人员 */
  onFilterPerson() {
    const userInfo = (getApp().globalData && getApp().globalData.userInfo) || {};
    const items = ['全部人员', userInfo.nickName || '我的', userInfo.partnerName || 'TA'];
    const values = ['all', 'mine', 'partner'];
    const that = this;
    wx.showActionSheet({
      itemList: items,
      success(res) {
        const idx = res.tapIndex;
        that.setData({ filterPerson: values[idx], filterPersonText: idx === 0 ? '' : items[idx], filterOn: idx !== 0 || that.data.filterType !== 'all' || !!that.data.filterCategory });
        that.reloadFilteredList();
      }
    });
  },

  onFilterCategoryChange(e) {
    const selected = this.data.filterCategoryOptions[Number(e.detail.value)] || this.data.filterCategoryOptions[0];
    this.setData({
      filterCategory: selected.key,
      filterCategoryText: selected.key ? selected.name : '',
      filterOn: !!selected.key || this.data.filterType !== 'all' || this.data.filterPerson !== 'all'
    });
    this.reloadFilteredList();
  },

  getFilterCategories(type) {
    if (type === 'expense') return this._expenseFilterCategories;
    if (type === 'income') return this._incomeFilterCategories;
    return this._allFilterCategories;
  },

  buildCategoryOptions(type) {
    return [{ key: '', name: '全部' }].concat(this.getFilterCategories(type));
  },

  reloadFilteredList() {
    ++this._billListRequestId;
    this._loadingMore = false;
    this.setData({ filteredList: [], page: 0, hasMore: false, loading: true, loadingMore: false, swipedId: '' });
    Promise.allSettled([
      this.loadBillFirstPage(this._billViewVersion),
      this.loadBillStats(this._billViewVersion)
    ]);
  },

  loadMore() {
    if (this.data.activeBillSheet !== 1) return;
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return;
    this.loadBillPage(this.data.page + 1, false, this._billViewVersion);
  },

  /** 清除筛选 */
  onClearFilter() {
    this.setData({ filterType: 'all', filterPerson: 'all', filterPersonText: '', filterCategory: '', filterCategoryText: '', filterOn: false });
    this.reloadFilteredList();
  },

  /** 记一笔 */
  onAdd() {
    this.openBillEditor('/pages/bill-edit/bill-edit');
  },

  openBillEditor(url) {
    wx.navigateTo({ url, success: (res) => res.eventChannel.on('billSaved', () => { this._billDataDirty = true; }) });
  },

  onEditBudget() {
    wx.navigateTo({
      url: `/pages/budget-edit/budget-edit?month=${this.data.yearMonth}`,
      success: (res) => {
        res.eventChannel.on('budgetSaved', () => { this._budgetDirty = true; });
        res.eventChannel.emit('budgetData', { budget: this.data.budget });
      }
    });
  },

  // ====== 左滑操作 ======

  /** 触摸开始：记录起点 */
  onSwipeStart(e) {
    this._swipeInfo = {
      startX: e.touches[0].pageX,
      startY: e.touches[0].pageY,
      id: e.currentTarget.dataset.id,
      mine: e.currentTarget.dataset.mine
    };
  },

  /** 触摸移动：计算偏移量 */
  onSwipeMove(e) {
    if (!this._swipeInfo) return;
    const dx = e.touches[0].pageX - this._swipeInfo.startX;
    const dy = e.touches[0].pageY - this._swipeInfo.startY;
    // 纵向滑动为主时不处理横向
    if (Math.abs(dy) > Math.abs(dx)) return;
    // 限制滑动范围
    const offset = Math.max(-280, Math.min(0, dx));
    this._swipeInfo.offsetX = offset;
  },

  /** 触摸结束：判断是否打开/关闭 */
  onSwipeEnd() {
    if (!this._swipeInfo) return;
    const info = this._swipeInfo;
    this._swipeInfo = null;
    const offsetX = info.offsetX || 0;
    const id = info.id;

    if (offsetX < -60) {
      // 左滑超过阈值 → 打开
      this.setData({ swipedId: id });
    } else {
      // 回弹关闭
      if (this.data.swipedId === id) {
        this.setData({ swipedId: '' });
      }
    }
  },

  /** 点击编辑按钮 */
  onSwipeEdit(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ swipedId: '' });
    this.openBillEditor(`/pages/bill-edit/bill-edit?id=${id}`);
  },

  /** 点击删除按钮 */
  onSwipeDelete(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ swipedId: '' });
    this.confirmDeleteBill(id);
  },

  /** 确认删除账单 */
  confirmDeleteBill(id) {
    wx.showModal({
      title: '删除这笔账？',
      content: '确定要删除这条账单吗？此操作不可撤销',
      confirmText: '删除',
      confirmColor: '#FF6B81',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '删除中...', mask: true });
        try {
          const delRes = await wx.cloud.callFunction({ name: 'deleteBill', data: { id } });
          wx.hideLoading();
          const result = delRes.result || {};
          if (result.success) {
            util.toast('删除成功');
            this.refreshView();
          } else {
            util.toast(result.msg || '删除失败');
          }
        } catch (err) {
          wx.hideLoading();
          console.error('删除失败', err);
          util.toast('删除失败，请重试');
        }
      }
    });
  },

  /** 下载导入模板 */
  onDownloadTemplate() {
    const fs = wx.getFileSystemManager();
    const tmpPath = wx.env.USER_DATA_PATH + '/template.xls';
    // HTML 表格格式 .xls（Excel/WPS 均可打开编辑）
    // 包含全部支持的分类示例，方便用户参照填写
    const rows = [
      '<tr><th>日期</th><th>类型</th><th>分类</th><th>金额</th><th>事项</th><th>备注</th></tr>',
      '<tr><td>2026-08-01</td><td>支出</td><td>餐饮</td><td>35.50</td><td>早餐</td><td>楼下包子铺</td></tr>',
      '<tr><td>2026-08-02</td><td>支出</td><td>交通</td><td>12.00</td><td>地铁</td><td>通勤</td></tr>',
      '<tr><td>2026-08-03</td><td>支出</td><td>购物</td><td>128.00</td><td>日用品</td><td>超市采购</td></tr>',
      '<tr><td>2026-08-04</td><td>支出</td><td>娱乐</td><td>45.00</td><td>电影票</td><td>></td></tr>',
      '<tr><td>2026-08-05</td><td>支出</td><td>居住</td><td>2800.00</td><td>房租</td><td>8月房租</td></tr>',
      '<tr><td>2026-08-06</td><td>支出</td><td>医疗</td><td>68.00</td><td>买药</td><td>感冒药</td></tr>',
      '<tr><td>2026-08-07</td><td>支出</td><td>人情</td><td>200.00</td><td>朋友生日</td><td>生日礼物</td></tr>',
      '<tr><td>2026-08-08</td><td>收入</td><td>工资</td><td>8000.00</td><td>8月工资</td><td>></td></tr>',
      '<tr><td>2026-08-09</td><td>收入</td><td>红包</td><td>88.88</td><td>微信红包</td><td>></td></tr>',
      '<tr><td>2026-08-10</td><td>收入</td><td>理财</td><td>150.00</td><td>基金收益</td><td>></td></tr>'
    ].join('');
    const xls = '<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
      'xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">' +
      '<head><meta charset="UTF-8"></head><body><table border="1">' + rows + '</table></body></html>';

    try {
      fs.writeFileSync(tmpPath, xls, 'utf8');
    } catch (err) {
      console.error('[模板] writeFileSync 失败:', err);
      wx.showModal({ title: '模板生成失败', content: String(err.errMsg || err), showCancel: false });
      return;
    }

    // 直接通过聊天发送（shareFileMessage 不支持 .csv 格式，用 .xls）
    wx.shareFileMessage({
      filePath: tmpPath,
      fileName: '账单导入模板.xls',
      success: () => {
        wx.showModal({
          title: '模板已发送',
          content: '请在电脑端用 Excel/WPS 打开模板，填写数据后点击「另存为」，格式选择「CSV (逗号分隔)(*.csv)」保存，再将该 CSV 文件发到微信聊天中，在本页面点击「导入」选择该文件即可。\n\n支持的分类：餐饮/交通/购物/娱乐/居住/医疗/人情/工资/兼职/红包/理财/其他',
          showCancel: false,
          confirmText: '我知道了'
        });
      },
      fail: (err) => {
        console.error('[模板] shareFileMessage 失败:', err);
        wx.showModal({
          title: '模板发送失败',
          content: String(err.errMsg || JSON.stringify(err)),
          showCancel: false
        });
      }
    });
  },

  /** 导出真实 CSV，并通过聊天发送。 */
  onExport() {
    const that = this;
    wx.showLoading({ title: '生成中...', mask: true });
    const [y, m] = this.data.yearMonth.split('-').map(Number);
    const months = [];
    for (let d = -2; d <= 0; d++) {
      const dt = new Date(y, m - 1 + d, 1);
      months.push(util.monthOf(dt));
    }
    Promise.all(months.map((ym) => this.fetchAllBillsForExport(ym))).then((monthLists) => {
      wx.hideLoading();
      const all = [].concat.apply([], monthLists);
      all.sort((a, b) => (a.billDate < b.billDate ? 1 : -1));
      const csvCell = (value) => `"${String(value === undefined || value === null ? '' : value).replace(/"/g, '""')}"`;
      const rows = [['日期', '类型', '分类', '金额', '事项', '备注', '记录人']];
      all.forEach((b) => rows.push([
        b.billDate, b.type === 'income' ? '收入' : '支出', billCategories.getCategoryName(b.category),
        b.amount, b.matter, b.note, b.creatorName
      ]));
      const csv = '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
      const fs = wx.getFileSystemManager();
      const fileName = `账单_${months[0]}至${months[months.length - 1]}.csv`;
      const tmpPath = `${wx.env.USER_DATA_PATH}/${fileName}`;
      let fileSize = 0;
      try {
        fs.writeFileSync(tmpPath, csv, 'utf8');
        const stat = fs.statSync(tmpPath);
        if (!stat || !stat.size) throw new Error('导出文件为空');
        fileSize = stat.size;
      } catch (err) {
        console.error('[BillExport][FILE_WRITE_FAILED]', err);
        util.toast('文件生成失败，请重试');
        return;
      }
      console.log('[BillExport][FILE_READY]', { filePath: tmpPath, fileName, fileSize });
      wx.showModal({
        title: '文件已生成',
        content: '点击“发送文件”选择微信聊天',
        confirmText: '发送文件',
        success: (res) => {
          if (res.confirm) that.shareExportFile({ filePath: tmpPath, fileName, fileSize });
        }
      });
    }).catch((err) => {
      wx.hideLoading();
      console.error('[BillExport][DATA_FETCH_FAILED]', err);
      util.toast('导出失败，请重试');
    });
  },

  /** 必须由用户确认点击直接触发，避免 shareFileMessage 丢失 TAP 手势。 */
  shareExportFile(file) {
    wx.shareFileMessage({
      filePath: file.filePath,
      fileName: file.fileName,
      success: () => {
        util.toast('导出已发送到聊天，可从中保存');
      },
      fail: (err) => {
        console.error('[BillExport][SHARE_FAILED]', {
          errMsg: err && err.errMsg,
          errCode: err && err.errCode
        });
        wx.openDocument({
          filePath: file.filePath,
          showMenu: true,
          fail: (openErr) => {
            console.error('[BillExport][OPEN_DOCUMENT_FAILED]', {
              errMsg: openErr && openErr.errMsg,
              errCode: openErr && openErr.errCode
            });
            wx.showModal({ title: '文件已生成', content: '文件已生成，但无法打开，请重试', showCancel: false });
          }
        });
      }
    });
  },

  /** 导出专用：局部分页获取完整月份，不写入页面 data。 */
  async fetchAllBillsForExport(yearMonth) {
    const all = [];
    let page = 0;
    let hasMore = true;
    while (hasMore) {
      const res = await wx.cloud.callFunction({
        name: 'getBills',
        data: { yearMonth, page, pageSize: 50, type: 'all', person: 'all', category: '' }
      });
      const result = (res && res.result) || {};
      if (!result.success) throw new Error(result.msg || '导出账单加载失败');
      all.push.apply(all, result.list || []);
      hasMore = !!result.hasMore;
      page += 1;
    }
    return all;
  },

  /** 导入 CSV */
  onImport() {
    const that = this;
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['csv', 'xls'],
      success(res) {
        const file = res.tempFiles[0];
        if (!file) return;
        const name = (file.name || '').toLowerCase();
        if (name.endsWith('.xls') || name.endsWith('.xlsx')) {
          wx.showModal({
            title: '需要 CSV 格式',
            content: '请在 Excel 中打开文件后，点击「另存为」，格式选择「CSV (逗号分隔)(*.csv)」，再导入该 CSV 文件。',
            showCancel: false,
            confirmText: '我知道了'
          });
          return;
        }
        that.parseAndImportCSV(file.path);
      },
      fail(err) {
        if (err.errMsg && err.errMsg.includes('cancel')) return;
        util.toast('选择文件失败');
      }
    });
  },

  /** 读取文件为 Base64 */
  _readFileBase64(fs, filePath) {
    return fs.readFileSync(filePath, 'base64');
  },

  /** 解析并导入 CSV（服务端解析，解决 GBK 编码问题） */
  async parseAndImportCSV(filePath) {
    wx.showLoading({ title: '读取文件...', mask: true });
    try {
      const fs = wx.getFileSystemManager();
      const fileBase64 = this._readFileBase64(fs, filePath);

      if (!fileBase64 || fileBase64.length === 0) {
        wx.hideLoading();
        util.toast('文件为空');
        return;
      }
      if (fileBase64.length > 1500000) {
        wx.hideLoading();
        util.toast('文件过大，请精简到 500 条以内');
        return;
      }

      wx.showLoading({ title: '解析导入中...', mask: true });
      const res = await wx.cloud.callFunction({
        name: 'csvImport',
        data: { fileBase64: fileBase64 }
      });
      wx.hideLoading();

      const result = (res && res.result) || {};
      if (result.success) {
        const msg = '成功导入 ' + result.count + ' 条' +
          (result.fail > 0 ? '，' + result.fail + ' 条失败' : '') +
          (result.skipped > 0 ? '，' + result.skipped + ' 行跳过' : '');
        util.toast(msg);
        this.refreshView();
      } else {
        // 显示详细错误信息（含 debug 信息）
        let content = result.msg || '导入失败';
        if (result.debug) {
          content += '\n\n--- 调试信息 ---';
          if (result.debug.headerCols) content += '\n表头: ' + result.debug.headerCols.join(' | ');
          if (result.debug.colIndex) content += '\n列映射: ' + JSON.stringify(result.debug.colIndex);
          content += '\n标准模式: ' + (result.debug.isStandard ? '是' : '否');
        }
        if (result.errors && result.errors.length > 0) {
          content += '\n\n错误明细:\n' + result.errors.join('\n');
        }
        wx.showModal({
          title: '导入失败',
          content: content,
          showCancel: false,
          confirmText: '我知道了'
        });
      }
    } catch (err) {
      wx.hideLoading();
      console.error('导入失败', err);
      wx.showModal({
        title: '导入失败',
        content: '错误：' + String(err.errMsg || err.message || err) +
          '\n\n请确认使用「📄 模板」下载标准格式，用 Excel 编辑后「另存为 CSV」再导入。',
        showCancel: false,
        confirmText: '我知道了'
      });
    }
  }
});
