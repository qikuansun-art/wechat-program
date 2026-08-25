// pages/index/index.js —— 首页：滚动 Banner + 功能模块
const util = require('../../utils/util');
const config = require('../../utils/config');

Page({
  data: {
    // 用户与绑定状态
    userInfo: null,
    partnerName: '',
    bound: false,
    loading: true,

    // 轮播图
    banners: [],          // 原始 fileID 数组（用于管理操作：删除/排序/预览）
    bannerUrls: [],       // 受控云函数生成的临时 URL 数组
    bannerLoadFailed: false,

    // 今日安排（首页最多展示 5 条）
    todaySchedules: [],
    todayScheduleTotal: 0,
    todayScheduleHasMore: false,
    todayScheduleLoading: false,
    todayScheduleError: false,

    // 最近报备
    latestReports: [],

    // 待审批列表
    pendingReports: [],
    pendingLoading: false,
    pendingError: false,

    // Banner 当前页
    bannerCurrent: 0,

    // Banner 管理弹层
    showBannerManage: false,
    manageBanners: [],     // 管理弹层 fileID 数组
    manageBannerUrls: [],  // 管理弹层临时 URL 数组
    uploading: false
  },

  onLoad() {
    this._isFirstLoad = true;
    this.init();
  },

  onShow() {
    if (this._loaded) this.init();
  },

  onUnload() {
    this._loaded = false;
  },

  async init() {
    const requestId = (this._initRequestId || 0) + 1;
    this._initRequestId = requestId;
    const app = getApp();
    // 首次进入复用 App 启动登录；后续资料刷新设短缓存，避免每次 onShow 紧接着重复 login。
    const now = Date.now();
    const shouldRefreshUser = this._loaded && now - (this._lastUserRefreshAt || 0) > 30000;
    const userInfo = shouldRefreshUser ? await app.refreshUserInfo() : await app.ensureLogin();
    if (shouldRefreshUser || !this._lastUserRefreshAt) this._lastUserRefreshAt = now;
    if (!userInfo) {
      if (requestId !== this._initRequestId) return;
      util.toast('登录失败，请重试');
      this.setData({ loading: false });
      return;
    }
    if (requestId !== this._initRequestId) return;
    this._loaded = true;
    const newBanners = Array.isArray(userInfo.banners) ? userInfo.banners : [];
    console.log('[init] banners从DB获取:', newBanners.length, '个', newBanners.map(function (f) { return typeof f === 'string' ? f.slice(-20) : typeof f; }));
    const update = {
      loading: false,
      userInfo,
      bound: !!userInfo.partnerId,
      partnerName: userInfo.partnerName || '伴侣'
    };
    // 仅在 banners 实际变化时才 setData，避免 swiper 被无谓重建导致滑动卡顿
    const oldBanners = this.data.banners;
    if (newBanners.length !== oldBanners.length || newBanners.some((v, i) => v !== oldBanners[i])) {
      update.banners = newBanners;
    }
    this.setData(update);
    const bannerKey = newBanners.join('|');
    const bannerCacheExpired = Date.now() - (this._bannerUrlRefreshedAt || 0) > 20 * 60 * 1000;
    const shouldRefreshBanner = bannerKey !== this._bannerFileKey ||
      (newBanners.length > 0 && (this.data.bannerUrls.length === 0 || bannerCacheExpired));
    this._bannerFileKey = bannerKey;
    if (shouldRefreshBanner) this.refreshBannerUrls();
    if (userInfo.partnerId) {
      // 三个聚合模块互不依赖，并行加载；各自负责失败降级。
      Promise.allSettled([
        this.loadTodaySchedules(),
        this.loadPendingReports(),
        this.loadLatestReports()
      ]);
      // 仅首次加载时兜底引导授权，避免每次 onShow 都弹窗骚扰用户
      if (this._isFirstLoad) {
        this.requestSubscriptions();
        this._isFirstLoad = false;
      }
    } else {
      this.setData({
        todaySchedules: [], todayScheduleTotal: 0, todayScheduleHasMore: false, todayScheduleError: false,
        pendingReports: [], pendingError: false, latestReports: []
      });
    }
  },

  /** 按 Asia/Shanghai 日期语义生成 YYYY-MM-DD。 */
  shanghaiToday() {
    const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
  },

  /** 首页只加载今天，最多渲染 5 条。 */
  async loadTodaySchedules() {
    const requestId = (this._scheduleRequestId || 0) + 1;
    this._scheduleRequestId = requestId;
    this.setData({ todayScheduleLoading: true, todayScheduleError: false });
    try {
      const res = await wx.cloud.callFunction({
        name: 'getSchedules',
        data: { date: this.shanghaiToday() }
      });
      if (requestId !== this._scheduleRequestId) return;
      const result = res.result || {};
      if (!result.success) throw new Error(result.msg || '今日安排加载失败');
      const list = Array.isArray(result.list) ? result.list : [];
      const todaySchedules = list.slice(0, 5).map((item) => ({
        id: item.scheduleId || item._id,
        scheduleId: item.scheduleId || item._id,
        occurrenceDate: item.occurrenceDate || item.date,
        instanceKey: item.instanceKey || `${item.scheduleId || item._id}:${item.occurrenceDate || item.date}`,
        title: item.title || '',
        timeText: item.startTime || '全天',
        ownerLabel: item.ownerLabel || '双人',
        ownerClass: item.ownerType === 'personal' ? (item.ownerLabel === '我的' ? 'mine' : 'partner') : 'couple',
        typeText: item.type === 'todo' ? '待办' : item.type === 'checkin' ? '打卡' : '日程',
        typeClass: item.type || 'schedule',
        stateText: item.type === 'checkin' ? (item.completed ? '已打卡' : '待打卡') : (item.completed ? '已完成' : '待完成'),
        completed: !!item.completed,
        toggling: false
      }));
      this.setData({
        todaySchedules,
        todayScheduleTotal: list.length,
        todayScheduleHasMore: list.length > 5,
        todayScheduleLoading: false,
        todayScheduleError: false
      });
    } catch (err) {
      if (requestId !== this._scheduleRequestId) return;
      console.error('加载今日安排失败', err);
      this.setData({ todaySchedules: [], todayScheduleTotal: 0, todayScheduleHasMore: false, todayScheduleLoading: false, todayScheduleError: true });
    }
  },

  /** 加载最近 2 条自己发起的报备 */
  async loadLatestReports() {
    const requestId = (this._latestRequestId || 0) + 1;
    this._latestRequestId = requestId;
    try {
      const res = await wx.cloud.callFunction({
        name: 'getReports',
        data: { role: 'creator', limit: 2 }
      });
      if (!res.result || !res.result.success) throw new Error((res.result && res.result.msg) || '最近报备加载失败');
      const list = (res.result && res.result.list) || [];
      const reports = list.map((report) => ({
        id: report._id,
        location: report.location,
        reason: report.reason,
        createdAtText: util.prettyTime(report.createdAt),
        statusText: util.statusText(report.status),
        statusClass: util.statusClass(report.status)
      }));
      if (requestId !== this._latestRequestId) return;
      this.setData({ latestReports: reports });
    } catch (err) {
      if (requestId !== this._latestRequestId) return;
      console.error('加载最近报备失败', err);
      this.setData({ latestReports: [] });
    }
  },

  /** 加载待我审批的报备列表 */
  async loadPendingReports() {
    const requestId = (this._pendingRequestId || 0) + 1;
    this._pendingRequestId = requestId;
    this.setData({ pendingLoading: true, pendingError: false });
    try {
      const app = getApp();
      const myId = app.globalData.userInfo && app.globalData.userInfo._id;
      const res = await wx.cloud.callFunction({
        name: 'getReports',
        data: { role: 'approver', status: 'pending', pageSize: 3 }
      });
      if (!res.result || !res.result.success) throw new Error((res.result && res.result.msg) || '待审批加载失败');
      const list = (res.result && res.result.list) || [];
      const pending = list
        .filter(r => r.status === 'pending' && r.partnerId === myId)
        .slice(0, 3)
        .map(r => ({
          id: r._id,
          location: r.location,
          creatorName: r.creatorName || '伴侣',
          createdAtText: util.prettyTime(r.createdAt),
          reason: r.reason || ''
        }));
      if (requestId !== this._pendingRequestId) return;
      this.setData({ pendingReports: pending, pendingLoading: false, pendingError: false });
    } catch (err) {
      if (requestId !== this._pendingRequestId) return;
      console.error('加载待审批列表失败', err);
      this.setData({ pendingReports: [], pendingLoading: false, pendingError: true });
    }
  },

  /** Banner 切换回调，更新当前页码 */
  onBannerChange(e) {
    this.setData({ bannerCurrent: e.detail.current });
  },

  /** 添加 Banner 图片（支持多选） */
  async onAddBanner() {
    const app = getApp();
    if (!app.globalData.openid) {
      util.toast('请先登录后再操作');
      return;
    }
    const currentCount = this.data.banners.length;
    if (currentCount >= 10) {
      util.toast('最多 10 张轮播图');
      return;
    }
    let tempFiles;
    try {
      const res = await wx.chooseMedia({
        count: Math.min(9, 10 - currentCount),
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed']
      });
      tempFiles = res.tempFiles;
      if (!tempFiles || tempFiles.length === 0) return;
    } catch (err) {
      if (err.errMsg && err.errMsg.indexOf('cancel') < 0) {
        console.error('选择图片失败', err);
        util.toast('选择图片失败，请重试');
      }
      return;
    }

    this.setData({ uploading: true });
    wx.showLoading({ title: `上传中 0/${tempFiles.length}`, mask: true });
    const fileIDs = [];
    try {
      for (let i = 0; i < tempFiles.length; i++) {
        const f = tempFiles[i];
        const ext = (f.tempFilePath.match(/\.(\w+)$/) || [])[1] || 'jpg';
        const cloudPath = `banners/${app.globalData.openid}/${Date.now()}-${i}.${ext}`;
        const upRes = await wx.cloud.uploadFile({ cloudPath, filePath: f.tempFilePath });
        fileIDs.push(upRes.fileID);
        wx.showLoading({ title: `上传中 ${i + 1}/${tempFiles.length}`, mask: true });
      }
    } catch (err) {
      wx.hideLoading();
      this.setData({ uploading: false });
      console.error('[onAddBanner] 云存储上传失败', err);
      util.toast('图片上传失败: ' + (err.errMsg || '未知错误'));
      return;
    }

    try {
      const funcRes = await wx.cloud.callFunction({
        name: 'updateBanners',
        data: { action: 'add', fileIDs }
      });
      wx.hideLoading();
      this.setData({ uploading: false });
      const result = funcRes.result || {};
      if (result.success) {
        app.globalData.userInfo = Object.assign({}, app.globalData.userInfo, { banners: result.banners });
        this.setData({ banners: result.banners });
        this.refreshBannerUrls(result.banners);
        // 同步状态诊断日志
        if (result.partnerId) {
          console.log('[onAddBanner] 同步状态: partnerId=' + result.partnerId +
            ', synced=' + (result.synced ? '✅' : '❌'));
          if (!result.synced) {
            console.warn('[onAddBanner] ⚠️ 伴侣同步失败！请确认 updateBanners 云函数已重新部署');
          }
        } else {
          console.log('[onAddBanner] 用户未绑定伴侣，无需同步');
        }
        util.toast(`已添加 ${fileIDs.length} 张`);
      } else {
        util.toast(result.msg || '添加失败，请重试');
      }
    } catch (err) {
      wx.hideLoading();
      this.setData({ uploading: false });
      console.error('[onAddBanner] 云函数调用失败', err);
      util.toast('保存失败: ' + (err.errMsg || '未知错误'));
    }
  },

  /** 打开 Banner 管理弹层 */
  async onManageBanners() {
    if (!this.data.banners.length) return;
    const fileIDs = [...this.data.banners];
    this.setData({ showBannerManage: true, manageBanners: fileIDs });
    await this.refreshManageBannerUrls(fileIDs);
  },

  /** 关闭管理弹层 */
  onCloseManage() {
    this.setData({ showBannerManage: false });
  },

  /** 管理弹层内点击蒙层关闭 */
  onManageMaskTap() {
    this.setData({ showBannerManage: false });
  },

  /** 全屏预览某张图片 */
  onPreviewBanner(e) {
    const idx = e.currentTarget.dataset.idx;
    // 优先使用临时 URL 预览（避免云存储权限问题），回退到 fileID
    const urls = this.data.bannerUrls.length > 0 ? this.data.bannerUrls : this.data.banners;
    wx.previewImage({
      current: urls[idx],
      urls: urls
    });
  },

  /** Banner 图片加载失败 */
  onBannerImgError(e) {
    const idx = e.currentTarget.dataset.idx;
    const src = this.data.bannerUrls[idx] || '';
    const fileID = this.data.banners[idx] || '';
    console.error('[onBannerImgError] 图片加载失败: idx=' + idx,
      '\n  临时URL:', src.slice(0, 80) + '...',
      '\n  原始fileID:', fileID.slice(0, 80) + '...',
      '\n  错误详情:', e.detail);
  },

  /** 由受控云函数读取真实 Banner 并生成临时 URL。 */
  async refreshBannerUrls() {
    const requestId = (this._bannerRequestId || 0) + 1;
    this._bannerRequestId = requestId;
    try {
      const res = await wx.cloud.callFunction({ name: 'getSharedBanners', data: {} });
      if (requestId !== this._bannerRequestId) return;
      const result = res.result || {};
      if (!result.success) {
        console.error('[refreshBannerUrls] 加载失败:', result.code || '', result.msg || '');
        this.setData({ bannerUrls: [], bannerLoadFailed: true });
        return;
      }
      const banners = Array.isArray(result.banners) ? result.banners : [];
      const items = Array.isArray(result.items) ? result.items : [];
      const urls = items.filter((item) => item.success && item.tempURL).map((item) => item.tempURL);
      const failedCount = items.length - urls.length;
      if (failedCount > 0) console.warn('[refreshBannerUrls] 有 ' + failedCount + ' 张图片暂时无法加载，已安全跳过');
      const app = getApp();
      app.globalData.userInfo = Object.assign({}, app.globalData.userInfo, { banners });
      this._bannerFileKey = banners.join('|');
      this._bannerUrlRefreshedAt = Date.now();
      this.setData({ banners, bannerUrls: urls, bannerLoadFailed: banners.length > 0 && urls.length === 0 });
    } catch (err) {
      if (requestId !== this._bannerRequestId) return;
      console.error('[refreshBannerUrls] 云函数调用失败:', err);
      this.setData({ bannerUrls: [], bannerLoadFailed: true });
    }
  },

  /** 管理弹层的临时 URL 刷新 */
  async refreshManageBannerUrls(fileIDs) {
    if (!fileIDs || fileIDs.length === 0) {
      this.setData({ manageBannerUrls: [] });
      return;
    }
    const requestId = (this._manageBannerRequestId || 0) + 1;
    this._manageBannerRequestId = requestId;
    try {
      const res = await wx.cloud.callFunction({ name: 'getSharedBanners', data: {} });
      if (requestId !== this._manageBannerRequestId) return;
      const result = res.result || {};
      if (!result.success) throw new Error(result.msg || 'Banner 加载失败');
      const itemMap = {};
      (result.items || []).forEach((item) => { itemMap[item.fileID] = item.tempURL || ''; });
      this.setData({ manageBannerUrls: fileIDs.map((fileID) => itemMap[fileID] || '') });
    } catch (err) {
      if (requestId !== this._manageBannerRequestId) return;
      console.error('[refreshManageBannerUrls] 加载失败:', err);
      this.setData({ manageBannerUrls: fileIDs.map(() => '') });
    }
  },

  /** 管理弹层中删除一张 */
  async onManageDelete(e) {
    const idx = e.currentTarget.dataset.idx;
    const fileID = this.data.manageBanners[idx];
    wx.showLoading({ title: '删除中...', mask: true });
    try {
      const funcRes = await wx.cloud.callFunction({
        name: 'updateBanners',
        data: { action: 'remove', fileID }
      });
      wx.hideLoading();
      const result = funcRes.result || {};
      if (result.success) {
        const app = getApp();
        app.globalData.userInfo = Object.assign({}, app.globalData.userInfo, { banners: result.banners });
        this.setData({ banners: result.banners, manageBanners: [...result.banners] });
        this.refreshBannerUrls(result.banners);
        // 同步更新管理弹层的临时 URL
        this.refreshManageBannerUrls(result.banners);
        if (result.banners.length === 0) {
          this.setData({ showBannerManage: false });
        }
        util.toast('已删除');
      } else {
        util.toast(result.msg || '删除失败');
      }
    } catch (err) {
      wx.hideLoading();
      console.error('删除Banner失败', err);
      util.toast('删除失败，请重试');
    }
  },

  /** 管理弹层中上移 */
  onManageMoveUp(e) {
    const idx = e.currentTarget.dataset.idx;
    if (idx <= 0) return;
    const list = [...this.data.manageBanners];
    [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
    this.setData({ manageBanners: list });
    // 同步排序临时 URL
    const urlList = [...this.data.manageBannerUrls];
    if (urlList.length === list.length) {
      [urlList[idx - 1], urlList[idx]] = [urlList[idx], urlList[idx - 1]];
      this.setData({ manageBannerUrls: urlList });
    }
    this.saveReorder(list);
  },

  /** 管理弹层中下移 */
  onManageMoveDown(e) {
    const idx = e.currentTarget.dataset.idx;
    const list = [...this.data.manageBanners];
    if (idx >= list.length - 1) return;
    [list[idx], list[idx + 1]] = [list[idx + 1], list[idx]];
    this.setData({ manageBanners: list });
    // 同步排序临时 URL
    const urlList = [...this.data.manageBannerUrls];
    if (urlList.length === list.length) {
      [urlList[idx], urlList[idx + 1]] = [urlList[idx + 1], urlList[idx]];
      this.setData({ manageBannerUrls: urlList });
    }
    this.saveReorder(list);
  },

  /** 保存排序到云端 */
  async saveReorder(list) {
    try {
      const funcRes = await wx.cloud.callFunction({
        name: 'updateBanners',
        data: { action: 'reorder', order: list }
      });
      const result = funcRes.result || {};
      if (result.success) {
        const app = getApp();
        app.globalData.userInfo = Object.assign({}, app.globalData.userInfo, { banners: result.banners });
        this.setData({ banners: result.banners });
        this.refreshBannerUrls(result.banners);
        this.refreshManageBannerUrls(result.banners);
      }
    } catch (err) {
      console.error('保存排序失败', err);
    }
  },

  /** 去记账页（直接跳转记一笔） */
  goBill() {
    wx.navigateTo({ url: '/pages/bill-edit/bill-edit' });
  },

  /** 去申请页（报备表单） */
  goApply() {
    wx.navigateTo({ url: '/pages/apply/apply' });
  },

  /** 快速新建今天的日程 */
  goScheduleCreate() {
    wx.navigateTo({ url: `/pages/schedule-edit/schedule-edit?date=${this.shanghaiToday()}` });
  },

  /** 查看完整日程 */
  goScheduleAll() {
    wx.switchTab({ url: '/pages/schedule/schedule' });
  },

  /** 查看日程规则详情 */
  goScheduleDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/schedule-edit/schedule-edit?id=' + id });
  },

  /** 首页只切换当前实例，不触发 init 或其他模块请求。 */
  async onTodayToggle(e) {
    const instanceKey = e.currentTarget.dataset.instanceKey;
    const scheduleId = e.currentTarget.dataset.scheduleId;
    const occurrenceDate = e.currentTarget.dataset.occurrenceDate;
    const completed = e.currentTarget.dataset.completed === true || e.currentTarget.dataset.completed === 'true';
    if (!instanceKey || !scheduleId || !occurrenceDate) return;
    if (!this._todayTogglingKeys) this._todayTogglingKeys = new Set();
    if (this._todayTogglingKeys.has(instanceKey)) return;
    this._todayTogglingKeys.add(instanceKey);
    this.updateTodayInstance(instanceKey, { toggling: true });
    try {
      const res = await wx.cloud.callFunction({
        name: 'toggleSchedule',
        data: { id: scheduleId, occurrenceDate, completed: !completed }
      });
      const result = res.result || {};
      if (!result.success || !result.schedule) throw new Error(result.msg || '操作失败');
      const item = this.data.todaySchedules.find((entry) => entry.instanceKey === instanceKey);
      const nextCompleted = !!result.schedule.completed;
      this.updateTodayInstance(instanceKey, {
        completed: nextCompleted,
        stateText: item && item.typeClass === 'checkin' ? (nextCompleted ? '已打卡' : '待打卡') : (nextCompleted ? '已完成' : '待完成'),
        toggling: false
      });
    } catch (err) {
      console.error('[index] toggle today schedule failed:', err);
      this.updateTodayInstance(instanceKey, { toggling: false });
      util.toast((err && err.message) || '操作失败，请重试');
    } finally {
      this._todayTogglingKeys.delete(instanceKey);
    }
  },

  updateTodayInstance(instanceKey, patch) {
    const todaySchedules = this.data.todaySchedules.map((item) => item.instanceKey === instanceKey ? Object.assign({}, item, patch) : item);
    this.setData({ todaySchedules });
  },

  retryTodaySchedules() {
    this.loadTodaySchedules();
  },

  retryPendingReports() {
    this.loadPendingReports();
  },

  /** 去绑定 */
  goBind() {
    wx.navigateTo({ url: '/pages/bind/bind' });
  },

  /** 去报备详情 */
  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
  },

  /** 请求订阅授权（同时请求两个模板，覆盖双方角色） */
  requestSubscriptions() {
    const tmplIds = [];
    const types = [];
    if (config.TEMPLATE_NEW_REPORT && config.TEMPLATE_NEW_REPORT.indexOf('请替换') < 0) {
      tmplIds.push(config.TEMPLATE_NEW_REPORT);
      types.push('new_report');
    }
    if (config.TEMPLATE_APPROVE_RESULT && config.TEMPLATE_APPROVE_RESULT.indexOf('请替换') < 0) {
      tmplIds.push(config.TEMPLATE_APPROVE_RESULT);
      types.push('approve_result');
    }
    if (tmplIds.length === 0) return;

    wx.requestSubscribeMessage({
      tmplIds,
      success: (res) => {
        tmplIds.forEach((id, i) => {
          if (res[id] === 'accept') {
            wx.cloud.callFunction({
              name: 'subscribe',
              data: { type: types[i] }
            }).catch((err) => console.error('[index] 记录订阅失败', err));
          }
        });
      },
      fail: () => {}
    });
  }
});
