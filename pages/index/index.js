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
    const bannerStateVersion = this._bannerStateVersion || 0;
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
    const bannerStateChanged = bannerStateVersion !== (this._bannerStateVersion || 0);
    console.log('[init] banners从DB获取:', newBanners.length, '个', newBanners.map(function (f) { return typeof f === 'string' ? f.slice(-20) : typeof f; }));
    const update = {
      loading: false,
      userInfo,
      bound: !!userInfo.partnerId,
      partnerName: userInfo.partnerName || '伴侣'
    };
    // 仅在 banners 实际变化时才 setData，避免 swiper 被无谓重建导致滑动卡顿
    const oldBanners = this.data.banners;
    if (!bannerStateChanged && (newBanners.length !== oldBanners.length || newBanners.some((v, i) => v !== oldBanners[i]))) {
      update.banners = newBanners;
    }
    this.setData(update);
    if (bannerStateChanged) {
      app.globalData.userInfo = Object.assign({}, app.globalData.userInfo, { banners: this.data.banners.slice() });
    } else {
      const bannerKey = newBanners.join('|');
      const bannerCacheExpired = Date.now() - (this._bannerUrlRefreshedAt || 0) > 20 * 60 * 1000;
      const shouldRefreshBanner = bannerKey !== this._bannerFileKey ||
        (newBanners.length > 0 && (this.data.bannerUrls.length === 0 || this.data.bannerLoadFailed || bannerCacheExpired));
      this._bannerFileKey = bannerKey;
      if (shouldRefreshBanner) this.refreshBannerUrls();
    }
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

  /** 选择 Banner 图片，逐张进入固定比例裁剪页。 */
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

    this._bannerCropQueue = tempFiles.map((file) => file.tempFilePath).filter(Boolean);
    this._croppedBannerFiles = [];
    this.setData({ uploading: true });
    this.openNextBannerCrop();
  },

  openNextBannerCrop() {
    if (!this._bannerCropQueue || this._bannerCropQueue.length === 0) {
      const croppedFiles = (this._croppedBannerFiles || []).slice();
      this._bannerCropQueue = [];
      this._croppedBannerFiles = [];
      if (croppedFiles.length === 0) {
        this.setData({ uploading: false });
        return;
      }
      this.uploadCroppedBanners(croppedFiles);
      return;
    }
    const sourcePath = this._bannerCropQueue[0];
    wx.navigateTo({
      url: '/pages/banner-crop/banner-crop',
      success: (navRes) => {
        let settled = false;
        navRes.eventChannel.on('bannerCropped', ({ tempFilePath }) => {
          if (settled || !tempFilePath) return;
          settled = true;
          this._croppedBannerFiles.push(tempFilePath);
          this._bannerCropQueue.shift();
          setTimeout(() => this.openNextBannerCrop(), 80);
        });
        navRes.eventChannel.on('bannerCropCancelled', () => {
          if (settled) return;
          settled = true;
          this._bannerCropQueue = [];
          this._croppedBannerFiles = [];
          this.setData({ uploading: false });
        });
        navRes.eventChannel.emit('cropSource', { tempFilePath: sourcePath });
      },
      fail: (err) => {
        console.error('[onAddBanner] 打开裁剪页失败:', err);
        this._bannerCropQueue = [];
        this._croppedBannerFiles = [];
        this.setData({ uploading: false });
        util.toast('裁剪页面打开失败，请重试');
      }
    });
  },

  async uploadCroppedBanners(croppedFiles) {
    const app = getApp();
    wx.showLoading({ title: `上传中 0/${croppedFiles.length}`, mask: true });
    const fileIDs = [];
    try {
      for (let i = 0; i < croppedFiles.length; i++) {
        const cloudPath = `banners/${app.globalData.openid}/${Date.now()}-${i}.jpg`;
        const upRes = await wx.cloud.uploadFile({ cloudPath, filePath: croppedFiles[i] });
        fileIDs.push(upRes.fileID);
        wx.showLoading({ title: `上传中 ${i + 1}/${croppedFiles.length}`, mask: true });
      }
    } catch (err) {
      wx.hideLoading();
      this.setData({ uploading: false });
      console.error('[onAddBanner] 云存储上传失败', err);
      util.toast('图片上传失败: ' + (err.errMsg || '未知错误'));
      return;
    }

    const result = await this.updateSharedBanners('add', { action: 'add', fileIDs }, fileIDs);

    wx.hideLoading();
    this.setData({ uploading: false });
    if (result.uncertain) {
      util.toast('操作状态未确认，请稍后刷新');
      return;
    }
    if (!result.success) {
      util.toast(result.msg || '上传失败，请重试');
      return;
    }
    app.globalData.userInfo = Object.assign({}, app.globalData.userInfo, { banners: result.banners });
    const previewByFileID = {};
    fileIDs.forEach((fileID, index) => { previewByFileID[fileID] = croppedFiles[index]; });
    this.applyOptimisticBanners(result.banners, previewByFileID);
    util.toast(`上传成功，共 ${fileIDs.length} 张`);
    const refreshed = await this.refreshBannerUrls(result.banners);
    if (!refreshed) util.toast('上传成功，Banner 刷新失败，请稍后重试');
  },

  currentBannerUrlMap() {
    const map = {};
    (this.data.banners || []).forEach((fileID, index) => {
      if (this.data.bannerUrls[index]) map[fileID] = this.data.bannerUrls[index];
    });
    return map;
  },

  applyOptimisticBanners(banners, previewByFileID) {
    const urlMap = Object.assign(this.currentBannerUrlMap(), previewByFileID || {});
    const bannerUrls = banners.map((fileID) => urlMap[fileID] || '');
    this._bannerStateVersion = (this._bannerStateVersion || 0) + 1;
    this._bannerRequestId = (this._bannerRequestId || 0) + 1;
    this._manageBannerRequestId = (this._manageBannerRequestId || 0) + 1;
    const update = {
      banners: banners.slice(),
      bannerUrls: bannerUrls.slice(),
      bannerCurrent: Math.min(this.data.bannerCurrent, Math.max(0, banners.length - 1)),
      bannerLoadFailed: false
    };
    if (this.data.showBannerManage) {
      update.manageBanners = banners.slice();
      update.manageBannerUrls = bannerUrls.slice();
    }
    this.setData(update);
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
  async fetchSharedBannersResult() {
    try {
      const res = await wx.cloud.callFunction({ name: 'getSharedBanners', data: {} });
      return res.result || {};
    } catch (err) {
      console.error('[fetchSharedBannersResult] 云函数调用失败:', err);
      return null;
    }
  },

  bannerLogTargets(fileIDs) {
    return (fileIDs || []).map((fileID) => `...${String(fileID).slice(-16)}`);
  },

  async reconcileBannerMutation(action, targetFileIDs) {
    const targets = Array.isArray(targetFileIDs) ? targetFileIDs : [targetFileIDs];
    console.log('[BannerMutation][RECONCILE_START]', {
      action,
      expectedTargets: this.bannerLogTargets(targets)
    });
    const result = await this.fetchSharedBannersResult();
    if (!result || !result.success || !Array.isArray(result.banners)) {
      console.warn('[BannerMutation][RECONCILE_UNAVAILABLE]', {
        action,
        code: result && result.code || '',
        message: result && result.msg || ''
      });
      return { available: false, confirmed: false, banners: [] };
    }
    const banners = result.banners.slice();
    const confirmed = action === 'add'
      ? targets.every((fileID) => banners.includes(fileID))
      : targets.every((fileID) => !banners.includes(fileID));
    console.log('[BannerMutation][RECONCILE_RESULT]', {
      action,
      returnedCount: banners.length,
      returnedTargets: this.bannerLogTargets(banners),
      expectedTargets: this.bannerLogTargets(targets),
      confirmed
    });
    return { available: true, confirmed, banners };
  },

  async updateSharedBanners(action, data, targetFileIDs) {
    const targets = Array.isArray(targetFileIDs) ? targetFileIDs : [targetFileIDs];
    console.log('[BannerMutation][CALL_START]', {
      action,
      targets: this.bannerLogTargets(targets)
    });
    let result = null;
    let rejectedError = null;
    try {
      const funcRes = await wx.cloud.callFunction({ name: 'updateBanners', data });
      result = funcRes.result || {};
      console.log('[BannerMutation][CALL_RESOLVE]', {
        action,
        requestID: funcRes.requestID || '',
        success: result.success === true,
        code: result.code || '',
        bannerCount: Array.isArray(result.banners) ? result.banners.length : null
      });
      if (result.success) {
        console.log('[BannerMutation][FINAL_DECISION]', { action, success: true, source: 'response' });
        return result;
      }
      // 明确的参数、权限或业务校验失败不是响应歧义，不用数据库事实覆盖。
      if (result.code && result.code !== 'TRANSACTION_FAILED') {
        console.log('[BannerMutation][FINAL_DECISION]', { action, success: false, source: 'business-response', code: result.code });
        return result;
      }
    } catch (err) {
      rejectedError = err;
      console.error('[BannerMutation][CALL_REJECT]', {
        action,
        requestID: err && err.requestID || '',
        errCode: err && err.errCode || '',
        errMsg: err && err.errMsg || err && err.message || ''
      });
    }

    const reconciled = await this.reconcileBannerMutation(action, targets);
    if (reconciled.confirmed) {
      console.log('[BannerMutation][FINAL_DECISION]', { action, success: true, source: 'database-reconciliation' });
      return { success: true, banners: reconciled.banners, reconciled: true };
    }
    if (!reconciled.available) {
      console.warn('[BannerMutation][FINAL_DECISION]', { action, success: false, uncertain: true, source: 'reconciliation-unavailable' });
      return { success: false, uncertain: true, code: 'BANNER_STATE_UNCONFIRMED' };
    }
    console.warn('[BannerMutation][FINAL_DECISION]', {
      action,
      success: false,
      source: 'database-reconciliation',
      code: result && result.code || rejectedError && rejectedError.errCode || 'TARGET_STATE_NOT_APPLIED'
    });
    return result || { success: false, msg: '操作失败，请重试', code: 'TARGET_STATE_NOT_APPLIED' };
  },

  async refreshBannerUrls(expectedBanners) {
    const requestId = (this._bannerRequestId || 0) + 1;
    this._bannerRequestId = requestId;
    const bannerStateVersion = this._bannerStateVersion || 0;
    try {
      const result = await this.fetchSharedBannersResult();
      if (requestId !== this._bannerRequestId || bannerStateVersion !== (this._bannerStateVersion || 0)) return false;
      if (!result || !result.success) {
        console.error('[refreshBannerUrls] 加载失败:', result && result.code || '', result && result.msg || '');
        this.setData({ bannerLoadFailed: true });
        return false;
      }
      const banners = Array.isArray(result.banners) ? result.banners : [];
      if (Array.isArray(expectedBanners) &&
        (banners.length !== expectedBanners.length || banners.some((fileID, index) => fileID !== expectedBanners[index]))) {
        console.warn('[refreshBannerUrls] 返回的 Banner 版本落后，保留当前本地预览');
        this.setData({ bannerLoadFailed: true });
        return false;
      }
      const items = Array.isArray(result.items) ? result.items : [];
      const oldUrlMap = this.currentBannerUrlMap();
      const itemMap = {};
      items.forEach((item) => { if (item.success && item.tempURL) itemMap[item.fileID] = item.tempURL; });
      const urls = banners.map((fileID) => itemMap[fileID] || oldUrlMap[fileID] || '');
      const failedCount = banners.filter((fileID) => !itemMap[fileID]).length;
      if (failedCount > 0) console.warn('[refreshBannerUrls] 有 ' + failedCount + ' 张图片暂时无法刷新，已保留现有预览');
      const app = getApp();
      app.globalData.userInfo = Object.assign({}, app.globalData.userInfo, { banners });
      this._bannerFileKey = banners.join('|');
      this._bannerUrlRefreshedAt = Date.now();
      this.setData({ banners: banners.slice(), bannerUrls: urls.slice(), bannerLoadFailed: failedCount > 0 });
      return failedCount === 0;
    } catch (err) {
      if (requestId !== this._bannerRequestId) return false;
      console.error('[refreshBannerUrls] 云函数调用失败:', err);
      this.setData({ bannerLoadFailed: true });
      return false;
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
    const result = await this.updateSharedBanners('remove', { action: 'remove', fileID }, [fileID]);
    wx.hideLoading();
    if (result.uncertain) {
      util.toast('操作状态未确认，请稍后刷新');
      return;
    }
    if (!result.success) {
      util.toast(result.msg || '删除失败');
      return;
    }
    const app = getApp();
    app.globalData.userInfo = Object.assign({}, app.globalData.userInfo, { banners: result.banners });
    this.applyOptimisticBanners(result.banners);
    if (result.banners.length === 0) this.setData({ showBannerManage: false });
    util.toast('删除成功');
    const refreshed = await this.refreshBannerUrls(result.banners);
    if (!refreshed) {
      util.toast('删除成功，Banner 刷新失败，请稍后重试');
    } else if (this.data.showBannerManage) {
      this.setData({ manageBannerUrls: this.data.bannerUrls.slice() });
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
