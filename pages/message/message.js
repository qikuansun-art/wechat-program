// pages/message/message.js —— 消息：审批通知
const util = require('../../utils/util');
const config = require('../../utils/config');

const GUIDE_KEY = 'notify_guide_closed'; // 引导条关闭标记

Page({
  data: {
    loading: true,
    // 消息列表结构：
    // { type: 'todo' | 'result', reportId, location, returnTime, reason,
    //   creatorName, createdAt, status, rejectReason }
    list: [],
    todoCount: 0,
    // 开启通知引导条
    showGuide: false
  },

  onShow() {
    this.loadMessages();
    this.checkGuide();
  },

  /** 判断是否显示「开启通知」引导条（未绑定 / 已关闭过则隐藏） */
  checkGuide() {
    const app = getApp();
    const userInfo = app.globalData.userInfo;
    const closed = wx.getStorageSync(GUIDE_KEY);
    const showGuide = !!userInfo && !!userInfo.partnerId && !closed;
    this.setData({ showGuide });
  },

  /** 点击「开启」：请求订阅授权 */
  onEnableNotify() {
    const tmplId = config.TEMPLATE_NEW_REPORT;
    if (!tmplId || tmplId.indexOf('请替换') >= 0) {
      util.toast('通知模板尚未配置（见 utils/config.js）');
      return;
    }
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      success: (res) => {
        if (res[tmplId] === 'accept') {
          // 记录订阅额度
          wx.cloud.callFunction({ name: 'subscribe', data: { type: 'new_report' } })
            .then(() => {
              wx.setStorageSync(GUIDE_KEY, true);
              this.setData({ showGuide: false });
              util.toast('通知已开启，TA 的报备会第一时间提醒你 💌');
            })
            .catch((err) => console.error('记录订阅失败', err));
        } else {
          wx.showToast({ title: '未授权，将收不到报备提醒', icon: 'none' });
        }
      },
      fail: () => {
        // 用户可能点了"总是保持以上选择"并拒绝
        wx.setStorageSync(GUIDE_KEY, true);
        this.setData({ showGuide: false });
      }
    });
  },

  /** 关闭引导条（不授权） */
  onCloseGuide() {
    wx.setStorageSync(GUIDE_KEY, true);
    this.setData({ showGuide: false });
  },

  async loadMessages() {
    const app = getApp();
    const userInfo = await app.ensureLogin();
    if (!userInfo) {
      this.setData({ loading: false });
      return;
    }
    try {
      const res = await wx.cloud.callFunction({ name: 'getMessages', data: {} });
      const result = res.result || {};
      const list = (result.list || []).map((item) => {
        const m = Object.assign({}, item, {
          createdAtText: util.prettyTime(item.createdAt),
          processedAtText: util.prettyTime(item.processedAt),
          statusText: util.statusText(item.status),
          statusClass: util.statusClass(item.status)
        });
        if (item.type === 'todo') {
          m.todoLabel = '待我审批';
        } else if (item.type === 'result') {
          m.resultLabel = item.status === 'approved' ? '已批准' : '已驳回';
        }
        return m;
      });
      const todoCount = list.filter((i) => i.type === 'todo').length;
      this.setData({ list, todoCount, loading: false });
    } catch (err) {
      console.error('加载消息失败', err);
      this.setData({ loading: false });
    }
  },

  /** 点击消息：待审批 → 详情页审批；结果 → 详情页查看 */
  onTapItem(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/detail/detail?id=${id}` });
  },

  /** 下拉刷新 */
  onPullDownRefresh() {
    this.loadMessages().finally(() => wx.stopPullDownRefresh());
  }
});
