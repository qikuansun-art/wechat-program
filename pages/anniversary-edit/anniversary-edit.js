const anniversary = require('../../utils/anniversary');
const util = require('../../utils/util');

Page({
  data: {
    loading: true,
    saving: false,
    anniversaryDate: '',
    anniversaryDateText: '',
    maxDate: ''
  },

  onLoad() {
    const today = anniversary.shanghaiToday();
    this.setData({ anniversaryDate: today, anniversaryDateText: this.displayDate(today), maxDate: today });
    this.loadSettings();
  },

  async loadSettings() {
    try {
      const res = await wx.cloud.callFunction({ name: 'getCoupleSettings', data: {} });
      const result = res.result || {};
      if (!result.success) throw new Error(result.msg || '纪念日加载失败');
      const value = result.settings && result.settings.anniversaryDate;
      if (value) this.setData({ anniversaryDate: value, anniversaryDateText: this.displayDate(value) });
      this.setData({ loading: false });
    } catch (err) {
      console.error('[AnniversaryEdit][LOAD_FAILED]', err);
      this.setData({ loading: false });
      util.toast('纪念日加载失败，请重试');
    }
  },

  displayDate(value) {
    const parts = value.split('-').map(Number);
    return `${parts[0]}年${parts[1]}月${parts[2]}日`;
  },

  onDateChange(e) {
    const value = e.detail.value;
    this.setData({ anniversaryDate: value, anniversaryDateText: this.displayDate(value) });
  },

  async onSave() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中...', mask: true });
    try {
      const res = await wx.cloud.callFunction({ name: 'saveAnniversary', data: { anniversaryDate: this.data.anniversaryDate } });
      const result = res.result || {};
      if (!result.success) throw new Error(result.msg || '保存失败');
      wx.hideLoading();
      const channel = this.getOpenerEventChannel && this.getOpenerEventChannel();
      if (channel && channel.emit) channel.emit('anniversarySaved', { anniversaryDate: result.settings.anniversaryDate });
      util.toast('纪念日已保存');
      setTimeout(() => wx.navigateBack(), 300);
    } catch (err) {
      wx.hideLoading();
      console.error('[AnniversaryEdit][SAVE_FAILED]', err);
      this.setData({ saving: false });
      util.toast((err && err.message) || '保存失败，请重试');
    }
  }
});
