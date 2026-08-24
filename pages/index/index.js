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
    bannerUrls: [],       // 临时 URL 数组（用于页面渲染，绕过云存储跨用户权限限制）

    // 记账入口
    billMonthExpense: null,

    // 最近报备
    latestReports: [],

    // 待审批列表
    pendingReports: [],

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
    const app = getApp();
    // 已登录时强制从数据库刷新，确保能看到伴侣同步过来的轮播图等最新数据
    // 未登录时才走 ensureLogin 首次登录流程
    const userInfo = app.globalData.userInfo
      ? await app.refreshUserInfo()
      : await app.ensureLogin();
    if (!userInfo) {
      util.toast('登录失败，请重试');
      this.setData({ loading: false });
      return;
    }
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
    // 将云文件 ID 转换为临时 URL，解决伴侣上传的图片因云存储权限无法显示的问题
    if (newBanners.length > 0) {
      await this.refreshBannerUrls(newBanners);
    } else {
      this.setData({ bannerUrls: [] });
    }
    if (userInfo.partnerId) {
      this.loadBillMonthExpense();
      this.loadLatestReports();
      this.loadPendingReports();
      // 仅首次加载时兜底引导授权，避免每次 onShow 都弹窗骚扰用户
      if (this._isFirstLoad) {
        this.requestSubscriptions();
        this._isFirstLoad = false;
      }
    }
  },

  /** 加载本月支出 */
  async loadBillMonthExpense() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'getBillStats',
        data: { yearMonth: util.monthOf(new Date()) }
      });
      const stats = (res.result && res.result.stats) || {};
      this.setData({ billMonthExpense: (Number(stats.expense) || 0).toFixed(2) });
    } catch (err) {
      console.error('加载本月支出失败', err);
      this.setData({ billMonthExpense: null });
    }
  },

  /** 加载最近 2 条自己发起的报备 */
  async loadLatestReports() {
    try {
      const res = await wx.cloud.callFunction({
        name: 'getReports',
        data: { role: 'creator', limit: 2 }
      });
      const list = (res.result && res.result.list) || [];
      const reports = list.map((report) => ({
        id: report._id,
        location: report.location,
        reason: report.reason,
        createdAtText: util.prettyTime(report.createdAt),
        statusText: util.statusText(report.status),
        statusClass: util.statusClass(report.status)
      }));
      this.setData({ latestReports: reports });
    } catch (err) {
      console.error('加载最近报备失败', err);
    }
  },

  /** 加载待我审批的报备列表 */
  async loadPendingReports() {
    try {
      const app = getApp();
      const myId = app.globalData.userInfo && app.globalData.userInfo._id;
      const res = await wx.cloud.callFunction({
        name: 'getReports',
        data: { status: 'pending', pageSize: 10 }
      });
      const list = (res.result && res.result.list) || [];
      // 筛选：审批人是当前用户（即等待我审批的）
      const pending = list
        .filter(r => r.partnerId === myId)
        .map(r => ({
          id: r._id,
          location: r.location,
          creatorName: r.creatorName || '伴侣',
          createdAtText: util.prettyTime(r.createdAt),
          reason: r.reason || ''
        }));
      this.setData({ pendingReports: pending });
    } catch (err) {
      console.error('加载待审批列表失败', err);
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
    // 转换管理弹层的缩略图为临时 URL
    try {
      const res = await wx.cloud.getTempFileURL({ fileList: fileIDs });
      const fileList = res.fileList || [];
      const urls = fileList.map(function (f, i) {
        return (f.status === 0 && f.tempFileURL) ? f.tempFileURL : (fileIDs[i] || '');
      });
      this.setData({ manageBannerUrls: urls });
    } catch (err) {
      console.error('[onManageBanners] 转换临时URL失败:', err);
      this.setData({ manageBannerUrls: fileIDs });
    }
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

  /** 将云文件 fileID 批量转换为临时 HTTP URL（解决跨用户云存储访问权限问题） */
  async refreshBannerUrls(fileIDs) {
    if (!fileIDs || fileIDs.length === 0) {
      this.setData({ bannerUrls: [] });
      return;
    }
    console.log('[refreshBannerUrls] 请求转换', fileIDs.length, '个fileID:', fileIDs.map(function (f) { return f.slice(-20); }));
    try {
      const res = await wx.cloud.getTempFileURL({ fileList: fileIDs });
      console.log('[refreshBannerUrls] API返回:', JSON.stringify(res));
      const fileList = res.fileList || [];
      // 逐文件检查转换结果，status !== 0 的视为失败
      const urls = fileList.map(function (f, i) {
        if (f.status === 0 && f.tempFileURL) {
          return f.tempFileURL;
        }
        console.warn('[refreshBannerUrls] 第' + i + '个文件转换失败: status=' + f.status + ', errMsg=' + (f.errMsg || '无')); 
        return ''; // 先占位，下面回退
      });
      // 回退策略：转换失败的用原始 fileID（自己的图片用 fileID 仍可加载）
      const finalUrls = urls.map(function (url, i) {
        return url || fileIDs[i] || '';
      });
      const failedCount = urls.filter(function (u) { return !u; }).length;
      if (failedCount > 0) {
        console.warn('[refreshBannerUrls] ' + failedCount + '个文件转换失败，已回退使用原始fileID');
      }
      console.log('[refreshBannerUrls] 最终URL数:', finalUrls.length, ', 前3个:', finalUrls.slice(0, 3).map(function (u) { return u.slice(0, 50) + '...'; }));
      this.setData({ bannerUrls: finalUrls });
    } catch (err) {
      console.error('[refreshBannerUrls] 整体调用失败:', err);
      // 整体失败时直接用原始 fileID
      this.setData({ bannerUrls: fileIDs });
    }
  },

  /** 管理弹层的临时 URL 刷新 */
  async refreshManageBannerUrls(fileIDs) {
    if (!fileIDs || fileIDs.length === 0) {
      this.setData({ manageBannerUrls: [] });
      return;
    }
    try {
      const res = await wx.cloud.getTempFileURL({ fileList: fileIDs });
      const fileList = res.fileList || [];
      const urls = fileList.map(function (f, i) {
        return (f.status === 0 && f.tempFileURL) ? f.tempFileURL : (fileIDs[i] || '');
      });
      this.setData({ manageBannerUrls: urls });
    } catch (err) {
      console.error('[refreshManageBannerUrls] 转换失败:', err);
      this.setData({ manageBannerUrls: fileIDs });
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