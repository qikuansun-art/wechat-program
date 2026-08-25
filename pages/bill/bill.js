// pages/bill/bill.js —— 账单页（Tab）：情侣共享账本
const util = require('../../utils/util');
const billCategories = require('../../utils/bill-categories');

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
    notBound: false,
    yearMonth: '',
    yearMonthText: '',
    // 统计
    stats: {
      expense: 0, expenseText: '0.00',
      income: 0, incomeText: '0.00',
      balance: 0, balanceText: '0.00',
      count: 0, catList: []
    },
    // 维度
    dim: 'month',          // month | category | person
    dimList: [],           // 统计明细
    // 筛选
    filterOn: false,
    filterType: 'all',     // all | expense | income
    filterPerson: '',      // '' = 全部 | creatorId
    filterPersonText: '',
    // 数据
    filteredList: [],      // 筛选后
    catIconMap: {},
    catNameMap: {},
    // 左滑操作
    swipedId: ''
  },

  onLoad() {
    this._allBills = [];
    this._billRequestId = 0;
    const catIconMap = {};
    const catNameMap = {};
    billCategories.EXPENSE_CATEGORIES.concat(billCategories.INCOME_CATEGORIES).forEach((c) => {
      catIconMap[c.key] = c.icon;
      catNameMap[c.key] = c.name;
    });
    this.setData({ catIconMap, catNameMap });

    const now = new Date();
    this.setData({
      yearMonth: util.monthOf(now),
      yearMonthText: util.monthText(now)
    });
  },

  onShow() {
    if (this.data.yearMonth) this.loadData();
  },

  /** 加载当月账单 */
  async loadData() {
    const requestId = ++this._billRequestId;
    const yearMonth = this.data.yearMonth;
    this.setData({ loading: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'getBills',
        data: { yearMonth }
      });
      if (requestId !== this._billRequestId) return;
      const result = res.result || {};
      if (result.success === false) {
        this._allBills = [];
        this.setData({ loading: false, notBound: true, filteredList: [], dimList: [] });
        return;
      }
      const bills = result.list || [];
      this._allBills = bills;
      this.applyFilterAndStats({ notBound: false, loading: false });
    } catch (err) {
      if (requestId !== this._billRequestId) return;
      console.error('加载账单失败', err);
      this.setData({ loading: false });
      util.toast('加载失败，请重试');
    }
  },

  /** 应用筛选 + 统计 */
  applyFilterAndStats(extraData) {
    const allBills = this._allBills || [];
    const { filterType, filterPerson } = this.data;

    // 1. 筛选
    let list = allBills.slice();
    if (filterType !== 'all') {
      list = list.filter((b) => b.type === filterType);
    }
    if (filterPerson) {
      list = list.filter((b) => b.creatorId === filterPerson);
    }

    // 2. 展示用字段
    const shown = list.map((b) => ({
      id: b.id,
      type: b.type,
      category: b.category,
      categoryName: b.categoryName,
      matter: b.matter,
      note: b.note,
      amount: b.amount,
      amountText: formatMoney(b.amount),
      creatorName: b.creatorName,
      creatorId: b.creatorId,
      mine: b.mine,
      dateShort: (b.billDate || '').slice(5)
    }));

    // 3. 统计（基于当月全部数据，与筛选无关？）
    // 用户需求「月/分类/人员统计」——这里统计按当前筛选范围计算更合理
    let expense = 0, income = 0;
    list.forEach((b) => {
      if (b.type === 'income') income += Number(b.amount) || 0;
      else expense += Number(b.amount) || 0;
    });
    const balance = income - expense;

    // 分类统计
    const catMap = {};
    list.filter((b) => b.type === 'expense').forEach((b) => {
      if (!catMap[b.category]) catMap[b.category] = 0;
      catMap[b.category] += Number(b.amount) || 0;
    });
    const catTotal = Object.keys(catMap).reduce((s, k) => s + catMap[k], 0);
    const catList = Object.keys(catMap).map((k) => ({
      category: k,
      name: this.data.catNameMap[k] || '其他',
      amount: catMap[k],
      amountText: formatMoney(catMap[k]),
      percent: catTotal > 0 ? Math.round((catMap[k] / catTotal) * 100) : 0
    })).sort((a, b) => b.amount - a.amount);

    // 人员统计（双方）
    const personMap = {};
    list.forEach((b) => {
      if (!personMap[b.creatorId]) {
        personMap[b.creatorId] = { name: b.creatorName, expense: 0, income: 0, count: 0 };
      }
      if (b.type === 'income') personMap[b.creatorId].income += Number(b.amount) || 0;
      else personMap[b.creatorId].expense += Number(b.amount) || 0;
      personMap[b.creatorId].count++;
    });
    const personTotal = Object.keys(personMap).reduce((s, k) => s + personMap[k].expense, 0);
    const personList = Object.keys(personMap).map((k) => ({
      key: k,
      name: personMap[k].name,
      amountText: formatMoney(personMap[k].expense),
      percent: personTotal > 0 ? Math.round((personMap[k].expense / personTotal) * 100) : 0,
      sub: `支出 ${formatMoney(personMap[k].expense)} · 收入 +${formatMoney(personMap[k].income)} · ${personMap[k].count}笔`
    }));

    // 按维度渲染统计
    const dim = this.data.dim;
    let dimList = [];
    if (dim === 'category') {
      dimList = catList.map((c) => ({
        key: c.category,
        name: this.data.catIconMap[c.category] + ' ' + c.name,
        amountText: c.amountText,
        percent: c.percent
      }));
    } else if (dim === 'person') {
      dimList = personList;
    }

    const filterOn = filterType !== 'all' || !!filterPerson;

    this.setData(Object.assign({
      filteredList: shown,
      dimList,
      filterOn,
      stats: {
        expense, expenseText: formatMoney(expense),
        income, incomeText: formatMoney(income),
        balance, balanceText: formatMoney(balance),
        count: list.length,
        catList
      }
    }, extraData || {}));
  },

  /** 切换维度 */
  onDimChange(e) {
    const dim = e.currentTarget.dataset.dim;
    if (dim === this.data.dim) return;
    this.setData({ dim });
    this.applyFilterAndStats();
  },

  /** 上一个月 */
  onPreMonth() { this.shiftMonth(-1); },
  onNextMonth() { this.shiftMonth(1); },

  shiftMonth(delta) {
    const [y, m] = this.data.yearMonth.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    this.setData({
      yearMonth: util.monthOf(d),
      yearMonthText: util.monthText(d)
    });
    this.loadData();
  },

  /** 筛选：收支类型 */
  onFilterType(e) {
    const type = e.currentTarget.dataset.type;
    this.setData({ filterType: type });
    this.applyFilterAndStats();
  },

  /** 筛选：按人员 */
  onFilterPerson() {
    // 从当月数据中取人员列表
    const persons = {};
    (this._allBills || []).forEach((b) => {
      persons[b.creatorId] = b.creatorName;
    });
    const keys = Object.keys(persons);
    const items = keys.map((k) => persons[k]);
    const that = this;
    wx.showActionSheet({
      itemList: ['全部人员'].concat(items),
      success(res) {
        const idx = res.tapIndex;
        if (idx === 0) {
          that.setData({ filterPerson: '', filterPersonText: '' });
        } else {
          that.setData({ filterPerson: keys[idx - 1], filterPersonText: persons[keys[idx - 1]] });
        }
        that.applyFilterAndStats();
      }
    });
  },

  /** 清除筛选 */
  onClearFilter() {
    this.setData({ filterType: 'all', filterPerson: '', filterPersonText: '' });
    this.applyFilterAndStats();
  },

  /** 记一笔 */
  onAdd() {
    wx.navigateTo({ url: '/pages/bill-edit/bill-edit' });
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
    wx.navigateTo({ url: `/pages/bill-edit/bill-edit?id=${id}` });
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
            this.loadData();
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

  /** 导出 XLS */
  onExport() {
    const that = this;
    wx.showLoading({ title: '生成中...', mask: true });
    const [y, m] = this.data.yearMonth.split('-').map(Number);
    const months = [];
    for (let d = -2; d <= 0; d++) {
      const dt = new Date(y, m - 1 + d, 1);
      months.push(util.monthOf(dt));
    }
    Promise.all(months.map((ym) =>
      wx.cloud.callFunction({ name: 'getBills', data: { yearMonth: ym } })
    )).then((resArr) => {
      wx.hideLoading();
      let all = [];
      resArr.forEach((r) => {
        all = all.concat((r.result && r.result.list) || []);
      });
      all.sort((a, b) => (a.billDate < b.billDate ? 1 : -1));
      // HTML 转义
      const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // 生成 HTML 表格
      let rows = '<tr><th>日期</th><th>类型</th><th>分类</th><th>金额</th><th>事项</th><th>备注</th><th>记录人</th></tr>';
      all.forEach((b) => {
        const t = b.type === 'income' ? '收入' : '支出';
        rows += `<tr><td>${esc(b.billDate)}</td><td>${esc(t)}</td><td>${esc(b.categoryName)}</td><td>${b.amount}</td><td>${esc(b.matter)}</td><td>${esc(b.note)}</td><td>${esc(b.creatorName)}</td></tr>`;
      });
      const xls = '<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
        'xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">' +
        '<head><meta charset="UTF-8"></head><body><table border="1">' + rows + '</table></body></html>';
      const fs = wx.getFileSystemManager();
      const tmpPath = `${wx.env.USER_DATA_PATH}/export_tmp.xls`;
      try {
        fs.writeFileSync(tmpPath, xls, 'utf8');
      } catch (err) {
        console.error('写入导出文件失败', err);
        util.toast('导出失败，请重试');
        return;
      }
      // 直接通过聊天发送（不使用 saveFile / openDocument）
      wx.shareFileMessage({
        filePath: tmpPath,
        fileName: `账单导出_${that.data.yearMonth}.xls`,
        success: () => {
          util.toast('导出已发送到聊天，可从中保存');
        },
        fail: (err) => {
          console.error('[导出] shareFileMessage 失败:', err);
          wx.showModal({
            title: '导出发送失败',
            content: String(err.errMsg || JSON.stringify(err)),
            showCancel: false
          });
        }
      });
    }).catch((err) => {
      wx.hideLoading();
      console.error('导出失败', err);
      util.toast('导出失败');
    });
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
      console.log('[CSV导入] 云函数返回:', result);

      if (result.success) {
        const msg = '成功导入 ' + result.count + ' 条' +
          (result.fail > 0 ? '，' + result.fail + ' 条失败' : '') +
          (result.skipped > 0 ? '，' + result.skipped + ' 行跳过' : '');
        util.toast(msg);
        this.loadData();
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
