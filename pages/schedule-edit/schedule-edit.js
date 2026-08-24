const util = require('../../utils/util');

const TYPES = [
  { value: 'schedule', label: '日程', hint: '有明确时间的共同安排' },
  { value: 'todo', label: '待办', hint: '完成后可以勾选' },
  { value: 'checkin', label: '打卡', hint: '记录由谁完成' }
];

Page({
  data: {
    types: TYPES,
    editMode: false,
    editId: '',
    loading: false,
    saving: false,
    deleting: false,
    errorCode: '',
    errorMessage: '',
    type: 'schedule',
    title: '',
    date: '',
    startTime: '',
    endTime: '',
    note: ''
  },

  onLoad(options) {
    const editId = options && options.id ? String(options.id) : '';
    const requestedDate = options && /^\d{4}-\d{2}-\d{2}$/.test(options.date || '') ? options.date : util.today();
    this.setData({ editMode: !!editId, editId, date: requestedDate });
    wx.setNavigationBarTitle({ title: editId ? '编辑事项' : '新建事项' });
    if (editId) this.loadDetail();
  },

  async loadDetail() {
    this.setData({ loading: true, errorCode: '', errorMessage: '' });
    try {
      const res = await wx.cloud.callFunction({ name: 'getScheduleDetail', data: { id: this.data.editId } });
      const result = res.result || {};
      if (!result.success || !result.schedule) {
        this.handleError(result, '事项加载失败');
        return;
      }
      const item = result.schedule;
      this.setData({
        loading: false,
        type: item.type,
        title: item.title || '',
        date: item.date || util.today(),
        startTime: item.startTime || '',
        endTime: item.endTime || '',
        note: item.note || ''
      });
    } catch (err) {
      console.error('[schedule-edit] detail failed:', err);
      this.setData({ loading: false, errorCode: 'NETWORK_ERROR', errorMessage: '加载失败，请检查网络后重试' });
      util.toast('事项加载失败，请重试');
    }
  },

  handleError(result, fallback) {
    const message = result.code === 'NOT_BOUND'
      ? '请先绑定伴侣后使用情侣日程'
      : result.code === 'BINDING_INVALID'
        ? '绑定关系异常，请重新绑定'
        : (result.msg || fallback);
    this.setData({ loading: false, errorCode: result.code || 'LOAD_FAILED', errorMessage: message });
  },

  onTypeTap(event) {
    const type = event.currentTarget.dataset.type;
    if (TYPES.some((item) => item.value === type)) this.setData({ type });
  },

  onTitleInput(event) {
    this.setData({ title: event.detail.value });
  },

  onDateChange(event) {
    this.setData({ date: event.detail.value });
  },

  onStartTimeChange(event) {
    this.setData({ startTime: event.detail.value });
  },

  onEndTimeChange(event) {
    this.setData({ endTime: event.detail.value });
  },

  onClearStartTime() {
    this.setData({ startTime: '' });
  },

  onClearEndTime() {
    this.setData({ endTime: '' });
  },

  onNoteInput(event) {
    this.setData({ note: event.detail.value });
  },

  async onSave() {
    if (this.data.saving) return;
    const title = this.data.title.trim();
    if (!title) return util.toast('请输入事项标题');
    if (this.data.startTime && this.data.endTime && this.data.endTime < this.data.startTime) {
      return util.toast('结束时间不能早于开始时间');
    }
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中...', mask: true });
    try {
      const payload = {
        type: this.data.type,
        title,
        date: this.data.date,
        startTime: this.data.startTime,
        endTime: this.data.endTime,
        note: this.data.note.trim()
      };
      if (this.data.editMode) payload.id = this.data.editId;
      const res = await wx.cloud.callFunction({ name: 'saveSchedule', data: payload });
      const result = res.result || {};
      if (!result.success) {
        if (result.code === 'NOT_BOUND' || result.code === 'BINDING_INVALID') this.handleError(result, '保存失败');
        util.toast(result.msg || '保存失败，请重试');
        return;
      }
      util.toast(this.data.editMode ? '修改已保存' : '事项已创建');
      setTimeout(() => wx.navigateBack(), 500);
    } catch (err) {
      console.error('[schedule-edit] save failed:', err);
      util.toast('保存失败，请检查网络');
    } finally {
      wx.hideLoading();
      this.setData({ saving: false });
    }
  },

  onDelete() {
    if (!this.data.editMode || this.data.deleting) return;
    wx.showModal({
      title: '删除事项',
      content: '删除后无法恢复，确定要删除吗？',
      confirmText: '删除',
      confirmColor: '#F0483E',
      success: (modalResult) => {
        if (modalResult.confirm) this.deleteSchedule();
      }
    });
  },

  async deleteSchedule() {
    this.setData({ deleting: true });
    wx.showLoading({ title: '删除中...', mask: true });
    try {
      const res = await wx.cloud.callFunction({ name: 'deleteSchedule', data: { id: this.data.editId } });
      const result = res.result || {};
      if (!result.success) {
        util.toast(result.msg || '删除失败，请重试');
        return;
      }
      util.toast('事项已删除');
      setTimeout(() => wx.navigateBack(), 500);
    } catch (err) {
      console.error('[schedule-edit] delete failed:', err);
      util.toast('删除失败，请检查网络');
    } finally {
      wx.hideLoading();
      this.setData({ deleting: false });
    }
  },

  onRetry() {
    this.loadDetail();
  },

  onGoBind() {
    wx.navigateTo({ url: '/pages/bind/bind' });
  }
});
