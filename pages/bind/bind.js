// pages/bind/bind.js —— 绑定伴侣
const util = require('../../utils/util');
const config = require('../../utils/config');

Page({
  data: {
    code: '',        // 输入的对方邀请码
    binding: false,
    myCode: ''       // 我自己的邀请码
  },

  onLoad(options) {
    // 独立调用云函数获取邀请码
    this.loadMyCode();

    // 扫码进入：小程序码带 code 参数
    if (options && options.code) {
      const code = (options.code || '').toUpperCase().trim();
      this.setData({ code });
      this.onBind();
    }
  },

  /** 独立调用云函数获取邀请码 */
  async loadMyCode() {
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

  /** 复制我的邀请码 */
  onCopyMyCode() {
    const code = this.data.myCode;
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: () => util.toast('邀请码已复制，快发给 TA 吧')
    });
  },

  onCodeInput(e) {
    const value = e.detail.value.toUpperCase();
    this.setData({ code: value });
  },

  /** 扫码绑定 */
  onScan() {
    const that = this;
    wx.scanCode({
      onlyFromCamera: false,
      success(res) {
        const raw = res.result || '';
        const match = raw.match(/[?&]code=([A-Za-z0-9]+)/);
        if (match) {
          that.setData({ code: match[1].toUpperCase() });
          that.onBind();
        } else if (/^[A-Za-z0-9]{4,10}$/.test(raw)) {
          that.setData({ code: raw.toUpperCase() });
          that.onBind();
        } else {
          util.toast('未识别到有效邀请码');
        }
      },
      fail(err) {
        if (err.errMsg && err.errMsg.includes('cancel')) return;
        util.toast('扫码失败');
      }
    });
  },

  /** 输入邀请码绑定 */
  onBind() {
    const code = this.data.code.toUpperCase().trim();
    if (!code) return util.toast('请输入邀请码');
    if (!/^[A-Z0-9]{4,10}$/.test(code)) return util.toast('邀请码格式不正确');
    if (this.data.binding) return;

    this.setData({ binding: true });
    wx.showLoading({ title: '绑定中...', mask: true });

    wx.cloud.callFunction({
      name: 'bind',
      data: { code }
    }).then((res) => {
      wx.hideLoading();
      const result = res.result || {};
      if (result.success) {
        const app = getApp();
        const userInfo = Object.assign({}, app.globalData.userInfo || {}, {
          partnerId: result.partner.id,
          partnerName: result.partner.nickName,
          bindTime: new Date()
        });
        app.globalData.userInfo = userInfo;

        // 绑定成功后立即引导双方授权订阅消息
        // 这是最佳时机：双方刚建立关系，需要确保后续通知能送达
        this.requestSubscribeAfterBind();

        wx.showModal({
          title: '绑定成功 🎉',
          content: `已与「${result.partner.nickName}」绑定，现在可以互相报备和审批啦`,
          showCancel: false,
          confirmText: '开始报备',
          confirmColor: '#FF6B81',
          success: () => {
            wx.switchTab({ url: '/pages/index/index' });
          }
        });
      } else {
        util.toast(result.msg || '绑定失败，请重试');
      }
    }).catch((err) => {
      wx.hideLoading();
      console.error('绑定失败', err);
      util.toast('绑定失败，请检查网络');
    }).finally(() => {
      this.setData({ binding: false });
    });
  },

  /** 绑定成功后引导双方授权订阅消息
   *  同时请求两个模板：
   *  - new_report：作为审批人，接收伴侣发起的报备提醒
   *  - approve_result：作为发起人，接收自己的审批结果通知
   */
  requestSubscribeAfterBind() {
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
        // 逐一记录接受的模板
        tmplIds.forEach((id, i) => {
          if (res[id] === 'accept') {
            wx.cloud.callFunction({
              name: 'subscribe',
              data: { type: types[i] }
            }).catch((err) => console.error('记录订阅失败', err));
          }
        });
      },
      fail: () => {}
    });
  }
});