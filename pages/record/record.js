// pages/record/record.js —— 记录：历史列表（双主标签 + 二级状态筛选）
const util = require('../../utils/util');

/** 主标签：角色维度 */
const ROLE_TABS = [
  { key: 'creator', label: '我发起的' },
  { key: 'approver', label: '我审批的' }
];

/** 二级筛选：状态维度 */
const STATUS_FILTERS = [
  { key: '', label: '全部' },
  { key: 'pending', label: '待审批' },
  { key: 'approved', label: '已批准' },
  { key: 'rejected', label: '已驳回' }
];

Page({
  data: {
    roleTabs: ROLE_TABS,
    activeRole: 'creator',
    statusFilters: STATUS_FILTERS,
    activeStatus: '',
    loading: true,
    list: [],
    page: 0,
    hasMore: true,
    loadingMore: false
  },

  onShow() {
    this.refresh();
  },

  /** 切换主标签（角色） */
  onRoleTap(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.activeRole) return;
    this.setData({ activeRole: key, activeStatus: '' });
    this.refresh();
  },

  /** 切换二级筛选（状态） */
  onStatusTap(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.activeStatus) return;
    this.setData({ activeStatus: key });
    this.refresh();
  },

  /** 刷新（第一页） */
  async refresh() {
    this.setData({ loading: true, page: 0, hasMore: true, list: [] });
    await this.fetchPage(0);
    this.setData({ loading: false });
  },

  /** 加载更多 */
  async loadMore() {
    if (this.data.loadingMore || !this.data.hasMore || this.data.loading) return;
    const nextPage = this.data.page + 1;
    await this.fetchPage(nextPage);
  },

  /** 请求一页数据 */
  async fetchPage(page) {
    const app = getApp();
    await app.ensureLogin();
    // 在异步调用前快照当前角色与用户信息，防止切换标签时竞态
    const role = this.data.activeRole;
    const myOpenid = app.globalData.openid;
    const myId = app.globalData.userInfo && app.globalData.userInfo._id;
    try {
      const res = await wx.cloud.callFunction({
        name: 'getReports',
        data: {
          role,
          status: this.data.activeStatus,
          page,
          pageSize: 20
        }
      });
      const result = res.result || {};
      const isCreator = role === 'creator';
      // 客户端安全过滤：确保数据隔离，防止服务端返回交叉数据
      let rawList = result.list || [];
      if (role === 'creator' && myOpenid) {
        rawList = rawList.filter(item => item.openid === myOpenid);
      } else if (role === 'approver' && myId) {
        rawList = rawList.filter(item => item.partnerId === myId);
      }
      const newItems = rawList.map((item) => {
        return Object.assign({}, item, {
          isCreator,
          createdAtText: util.prettyTime(item.createdAt),
          statusText: util.statusText(item.status),
          statusClass: util.statusClass(item.status)
        });
      });
      this.setData({
        list: page === 0 ? newItems : this.data.list.concat(newItems),
        page,
        hasMore: !!(result.hasMore)
      });
    } catch (err) {
      console.error('加载记录失败', err);
    }
  },

  /** 点击记录 → 详情 */
  onTapItem(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  /** 复用现有报备表单 */
  onCreateReport() {
    wx.navigateTo({ url: '/pages/apply/apply' });
  },

  /** 下拉刷新 */
  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  /** 触底加载 */
  onReachBottom() {
    this.loadMore();
  }
});
