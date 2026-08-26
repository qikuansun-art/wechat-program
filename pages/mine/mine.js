// pages/mine/mine.js —— 我的：个人中心
// 直接调用 login 云函数获取最新数据，不依赖任何缓存
const util = require('../../utils/util');
const anniversary = require('../../utils/anniversary');

Page({
  data: {
    loading: true,
    userInfo: null,
    bound: false,
    partnerName: '',
    bindTimeText: '',
    inviteCode: '',
    anniversaryText: '未设置',
    anniversaryLoading: false,
    anniversaryError: false,
    editNickname: false,
    nicknameDraft: ''
  },

  onShow() {
    if (this._loaded && this._anniversaryDirty) {
      this._anniversaryDirty = false;
      this.loadCoupleSettings();
      return;
    }
    this.init();
  },

  async init() {
    this.setData({ loading: true });
    try {
      // 直接调用 login 云函数（不走缓存），确保拿到最新数据
      const res = await wx.cloud.callFunction({ name: 'login' });
      const data = res.result || {};
      if (!data.success) {
        this.setData({ loading: false });
        wx.showModal({ title: '提示', content: '登录失败：' + (data.msg || '未知错误'), showCancel: false });
        return;
      }
      const userInfo = data.userInfo;
      if (!userInfo) {
        this.setData({ loading: false });
        return;
      }
      // 更新全局缓存
      const app = getApp();
      app.globalData.openid = data.openid || '';
      app.globalData.userInfo = userInfo;

      this.setData({
        loading: false,
        userInfo,
        bound: !!userInfo.partnerId,
        partnerName: userInfo.partnerName || '',
        bindTimeText: util.prettyTime(userInfo.bindTime),
        inviteCode: userInfo.bindCode || ''
      });
      this._loaded = true;
      if (userInfo.partnerId) this.loadCoupleSettings();
      else this.setData({ anniversaryText: '未设置', anniversaryError: false });

      // 如果还是没有邀请码，弹窗提示
      if (!userInfo.bindCode) {
        console.warn('login 未返回 bindCode，返回数据：', JSON.stringify(data));
      }
    } catch (err) {
      this.setData({ loading: false });
      console.error('mine init 失败', err);
      wx.showModal({
        title: '加载失败',
        content: '调用 login 云函数失败：' + (err.errMsg || JSON.stringify(err)),
        showCancel: false
      });
    }
  },

  async loadCoupleSettings() {
    const requestId = (this._anniversaryRequestId || 0) + 1;
    this._anniversaryRequestId = requestId;
    this.setData({ anniversaryLoading: true, anniversaryError: false });
    try {
      const res = await wx.cloud.callFunction({ name: 'getCoupleSettings', data: {} });
      if (requestId !== this._anniversaryRequestId) return;
      const result = res.result || {};
      if (!result.success) throw new Error(result.msg || '纪念日加载失败');
      const value = result.settings && result.settings.anniversaryDate || '';
      this.setData({ anniversaryText: anniversary.dotDate(value) || '未设置', anniversaryLoading: false, anniversaryError: false });
    } catch (err) {
      if (requestId !== this._anniversaryRequestId) return;
      console.error('[Mine][ANNIVERSARY_LOAD_FAILED]', err);
      this.setData({ anniversaryLoading: false, anniversaryError: true });
    }
  },

  goAnniversaryEdit() {
    wx.navigateTo({
      url: '/pages/anniversary-edit/anniversary-edit',
      success: (res) => res.eventChannel.on('anniversarySaved', () => { this._anniversaryDirty = true; })
    });
  },

  async onChooseAvatar(e) {
    const app = getApp();
    const avatarUrl = e.detail.avatarUrl;
    if (!avatarUrl) return;
    wx.showLoading({ title: '上传中...', mask: true });
    try {
      const ext = (avatarUrl.match(/\.(\w+)$/) || [])[1] || 'png';
      const cloudPath = `avatars/${app.globalData.openid || 'user'}/avatar-${Date.now()}.${ext}`;
      const upRes = await wx.cloud.uploadFile({ cloudPath, filePath: avatarUrl });
      const res = await wx.cloud.callFunction({
        name: 'updateProfile',
        data: { avatarUrl: upRes.fileID }
      });
      wx.hideLoading();
      if (res.result && res.result.success) {
        app.globalData.userInfo = Object.assign({}, app.globalData.userInfo, { avatarUrl: upRes.fileID });
        this.setData({ 'userInfo.avatarUrl': upRes.fileID });
        util.toast('头像已更新');
      } else {
        util.toast('更新失败，请重试');
      }
    } catch (err) {
      wx.hideLoading();
      console.error('更新头像失败', err);
      util.toast('更新失败，请重试');
    }
  },

  onEditNickname() {
    this.setData({ editNickname: true, nicknameDraft: this.data.userInfo.nickName || '' });
  },

  onNicknameInput(e) {
    this.setData({ nicknameDraft: e.detail.value });
  },

  async onSaveNickname() {
    const nickname = this.data.nicknameDraft.trim();
    if (!nickname) return util.toast('昵称不能为空');
    const app = getApp();
    try {
      const res = await wx.cloud.callFunction({
        name: 'updateProfile',
        data: { nickName: nickname }
      });
      if (res.result && res.result.success) {
        app.globalData.userInfo = Object.assign({}, app.globalData.userInfo, { nickName: nickname });
        this.setData({ 'userInfo.nickName': nickname, editNickname: false });
        util.toast('昵称已更新');
      } else {
        util.toast('更新失败，请重试');
      }
    } catch (err) {
      console.error('更新昵称失败', err);
      util.toast('更新失败，请重试');
    }
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind/bind' });
  },

  onUnbind() {
    const that = this;
    wx.showModal({
      title: '解绑伴侣',
      content: `解绑后你将与 ${this.data.partnerName} 断开连接，已产生的报备记录仍会保留。确定解绑吗？`,
      confirmText: '解绑',
      confirmColor: '#F0483E',
      success(res) {
        if (res.confirm) that.doUnbind();
      }
    });
  },

  async doUnbind() {
    wx.showLoading({ title: '解绑中...', mask: true });
    try {
      const res = await wx.cloud.callFunction({ name: 'unbind', data: {} });
      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        const app = getApp();
        app.globalData.userInfo = Object.assign({}, app.globalData.userInfo, {
          partnerId: '',
          partnerName: '',
          bindTime: null
        });
        this.setData({ bound: false, partnerName: '', bindTimeText: '' });
        wx.showModal({
          title: '已解绑',
          content: '可以重新绑定新的伴侣',
          showCancel: false,
          confirmText: '知道了',
          confirmColor: '#FF6B81'
        });
      } else {
        util.toast(result.msg || '解绑失败，请重试');
      }
    } catch (err) {
      wx.hideLoading();
      console.error('解绑失败', err);
      util.toast('解绑失败，请重试');
    }
  },

  onCopyCode() {
    const code = this.data.inviteCode;
    if (!code) {
      util.toast('邀请码暂未生成');
      return;
    }
    wx.setClipboardData({
      data: code,
      success: () => util.toast('邀请码已复制，快发给 TA 吧')
    });
  }
});
