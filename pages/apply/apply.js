// pages/apply/apply.js —— 申请页：发起报备 + 邀请码展示
const util = require('../../utils/util');
const config = require('../../utils/config');

Page({
  data: {
    // 用户与绑定状态
    userInfo: null,
    bound: false,
    partnerName: '',
    myCode: '',         // 我的邀请码

    // 表单
    location: '',
    companions: '',
    date: '',
    time: '',
    startDate: '',
    startTime: '',
    duration: '',
    reason: '',
    images: [],

    // 交互
    submitting: false
  },

  onLoad() {
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
    const userInfo = await app.ensureLogin();
    if (!userInfo) return;
    this._loaded = true;
    this.setData({
      userInfo,
      bound: !!userInfo.partnerId,
      partnerName: userInfo.partnerName || '伴侣',
      date: util.today(),
      time: util.nowTime(),
      startDate: util.today(),
      startTime: util.nowTime()
    });
    // 独立获取邀请码
    this.loadInviteCode();
  },

  /** 独立获取邀请码 */
  async loadInviteCode() {
    try {
      const res = await wx.cloud.callFunction({ name: 'getMyInviteCode' });
      const result = res.result || {};
      if (result.success && result.bindCode) {
        this.setData({ myCode: result.bindCode });
      }
    } catch (err) {
      console.error('获取邀请码失败', err);
    }
  },

  /** 复制邀请码 */
  onCopyCode() {
    const code = this.data.myCode;
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: () => util.toast('邀请码已复制，快发给 TA 吧')
    });
  },

  /** 去绑定页 */
  goBind() {
    wx.navigateTo({ url: '/pages/bind/bind' });
  },

  /** 表单输入 */
  onLocationInput(e) { this.setData({ location: e.detail.value }); },
  onCompanionsInput(e) { this.setData({ companions: e.detail.value }); },
  onReasonInput(e) { this.setData({ reason: e.detail.value }); },
  onDateChange(e) { this.setData({ date: e.detail.value }); this.calcDuration(); },
  onTimeChange(e) { this.setData({ time: e.detail.value }); this.calcDuration(); },
  onStartDateChange(e) { this.setData({ startDate: e.detail.value }); this.calcDuration(); },
  onStartTimeChange(e) { this.setData({ startTime: e.detail.value }); this.calcDuration(); },

  /** 自动计算时长（小时） */
  calcDuration() {
    const { startDate, startTime, date, time } = this.data;
    if (!startDate || !startTime || !date || !time) {
      this.setData({ duration: '' });
      return;
    }
    const startMs = new Date(startDate.replace(/-/g, ' ') + ' ' + startTime).getTime();
    const endMs = new Date(date.replace(/-/g, ' ') + ' ' + time).getTime();
    if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs) {
      this.setData({ duration: '0' });
      return;
    }
    const hours = Math.round((endMs - startMs) / 3600000 * 10) / 10;
    this.setData({ duration: String(hours) });
  },

  /** 选择图片 */
  async onChooseImage() {
    const remain = 3 - this.data.images.length;
    if (remain <= 0) { util.toast('最多上传 3 张图片'); return; }
    try {
      const res = await wx.chooseMedia({
        count: remain, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed']
      });
      const tempFiles = res.tempFiles || [];
      const newLocal = tempFiles.map((f) => ({
        localPath: f.tempFilePath, fileID: '', uploading: true
      }));
      this.setData({ images: this.data.images.concat(newLocal) });
      const app = getApp();
      for (let i = 0; i < newLocal.length; i++) {
        const item = newLocal[i];
        const ext = (item.localPath.match(/\.(\w+)$/) || [])[1] || 'jpg';
        const cloudPath = `report-images/${app.globalData.openid || 'user'}/${Date.now()}-${Math.floor(Math.random() * 10000)}.${ext}`;
        const upRes = await wx.cloud.uploadFile({ cloudPath, filePath: item.localPath });
        item.fileID = upRes.fileID;
        item.uploading = false;
      }
      this.setData({ images: this.data.images });
    } catch (err) { console.error('选择/上传图片失败', err); }
  },

  /** 删除图片 */
  onRemoveImage(e) {
    const idx = e.currentTarget.dataset.idx;
    const images = this.data.images.slice();
    images.splice(idx, 1);
    this.setData({ images });
  },

  /** 预览图片 */
  onPreviewImage(e) {
    const idx = e.currentTarget.dataset.idx;
    const urls = this.data.images.map((img) => img.localPath || img.fileID);
    wx.previewImage({ current: urls[idx], urls });
  },

  /** 提交前请求订阅授权 */
  requestSubscribe() {
    const tmplId = config.TEMPLATE_APPROVE_RESULT;
    if (!tmplId || tmplId.indexOf('请替换') >= 0) return;
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      success: (res) => {
        if (res[tmplId] === 'accept') {
          wx.cloud.callFunction({ name: 'subscribe', data: { type: 'approve_result' } })
            .catch((err) => console.error('记录订阅失败', err));
        }
      },
      fail: () => {}
    });
  },

  /** 提交报备 */
  async onSubmit() {
    const { location, companions, startDate, startTime, date, time, reason, images, submitting, bound } = this.data;
    if (submitting) return;
    if (!bound) { util.toast('请先绑定伴侣再发起报备'); return; }
    if (!location.trim()) return util.toast('请填写外出地点');
    if (!date || !time) return util.toast('请选择预计归来时间');
    if (!reason.trim()) return util.toast('请填写事由说明');
    const uploading = images.some((img) => img.uploading);
    if (uploading) return util.toast('图片还在上传中，请稍候');

    this.requestSubscribe();
    this.setData({ submitting: true });
    wx.showLoading({ title: '提交中...', mask: true });

    try {
      const fileIDs = images.map((img) => img.fileID).filter(Boolean);
      const res = await wx.cloud.callFunction({
        name: 'createReport',
        data: {
          location: location.trim(),
          companions: companions.trim(),
          startTime: `${startDate} ${startTime}`,
          returnTime: `${date} ${time}`,
          reason: reason.trim(),
          images: fileIDs
        }
      });
      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        wx.showModal({
          title: '报备已发出',
          content: '已通知你的伴侣审批，记得留意消息哦 ❤',
          showCancel: false,
          confirmText: '知道了',
          confirmColor: '#FF6B81',
          success: () => {
            this.setData({
              location: '', companions: '', reason: '', images: [],
              date: util.today(), time: util.nowTime(),
              startDate: util.today(), startTime: util.nowTime(), duration: ''
            });
            wx.navigateBack();
          }
        });
      } else {
        util.toast(result.msg || '提交失败，请重试');
      }
    } catch (err) {
      wx.hideLoading();
      console.error('提交报备失败', err);
      util.toast('提交失败，请检查网络');
    } finally {
      this.setData({ submitting: false });
    }
  }
});