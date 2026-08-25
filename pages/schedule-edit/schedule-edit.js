const util = require('../../utils/util');
const app = getApp();

const TYPES = [
  { value: 'schedule', label: '日程', hint: '有明确时间的共同安排' },
  { value: 'todo', label: '待办', hint: '完成后可以勾选' },
  { value: 'checkin', label: '打卡', hint: '记录由谁完成' }
];
const OWNER_OPTIONS = [
  { value: 'mine', label: '我的' },
  { value: 'partner', label: 'TA的' },
  { value: 'couple', label: '双人' }
];
const REPEAT_OPTIONS = [
  { value: 'none', label: '不重复' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' }
];
const WEEKDAY_OPTIONS = [
  { value: 1, label: '周一' }, { value: 2, label: '周二' }, { value: 3, label: '周三' },
  { value: 4, label: '周四' }, { value: 5, label: '周五' }, { value: 6, label: '周六' },
  { value: 7, label: '周日' }
];

function parseUtcDate(value) {
  const parts = String(value || '').split('-').map(Number);
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
}
function formatUtcDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
function addDays(value, days) {
  const date = parseUtcDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatUtcDate(date);
}
function isoWeekday(value) { return parseUtcDate(value).getUTCDay() || 7; }
function dayOfMonth(value) { return parseUtcDate(value).getUTCDate(); }
function shanghaiDate(offsetDays) {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const date = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + offsetDays));
  return formatUtcDate(date);
}
function markWeekdays(selected) {
  const values = Array.isArray(selected) ? selected : [];
  return WEEKDAY_OPTIONS.map((item) => Object.assign({}, item, { selected: values.includes(item.value) }));
}

Page({
  data: {
    types: TYPES,
    ownerOptions: OWNER_OPTIONS,
    repeatOptions: REPEAT_OPTIONS,
    weekdayOptions: markWeekdays([]),
    editMode: false,
    editId: '',
    loading: false,
    saving: false,
    deleting: false,
    stopping: false,
    errorCode: '',
    errorMessage: '',
    type: 'schedule',
    title: '',
    date: '',
    startTime: '',
    endTime: '',
    note: '',
    ownerChoice: 'couple',
    repeatType: 'none',
    repeatStartDate: '',
    repeatEndDate: '',
    repeatWeekdays: [],
    repeatDay: null,
    showMonthSkipHint: false,
    originalRepeatType: 'none'
  },

  onLoad(options) {
    const editId = options && options.id ? String(options.id) : '';
    const requestedDate = options && /^\d{4}-\d{2}-\d{2}$/.test(options.date || '') ? options.date : util.today();
    this._myId = '';
    this._partnerId = '';
    this.setData({ editMode: !!editId, editId, date: requestedDate });
    wx.setNavigationBarTitle({ title: editId ? '编辑事项' : '新建事项' });
    this.initialize();
  },

  async initialize() {
    const user = await app.ensureLogin();
    this._myId = user && user._id ? user._id : '';
    this._partnerId = user && user.partnerId ? user.partnerId : '';
    if (this.data.editMode) this.loadDetail();
  },

  async loadDetail() {
    this.setData({ loading: true, errorCode: '', errorMessage: '' });
    try {
      const res = await wx.cloud.callFunction({ name: 'getScheduleDetail', data: { id: this.data.editId } });
      const result = res.result || {};
      if (!result.success || !result.schedule) return this.handleError(result, '事项加载失败');
      const item = result.schedule;
      const repeatType = ['daily', 'weekly', 'monthly'].includes(item.repeatType) ? item.repeatType : 'none';
      let ownerChoice = 'couple';
      if (item.ownerType === 'personal') ownerChoice = item.ownerId === this._myId ? 'mine' : 'partner';
      const repeatStartDate = item.repeatStartDate || item.date || util.today();
      const repeatDay = repeatType === 'monthly' ? Number(item.repeatDay) : null;
      this.setData({
        loading: false,
        type: item.type,
        title: item.title || '',
        date: item.date || repeatStartDate,
        startTime: item.startTime || '',
        endTime: item.endTime || '',
        note: item.note || '',
        ownerChoice,
        repeatType,
        repeatStartDate: repeatType === 'none' ? '' : repeatStartDate,
        repeatEndDate: repeatType === 'none' ? '' : (item.repeatEndDate || addDays(repeatStartDate, 30)),
        repeatWeekdays: repeatType === 'weekly' && Array.isArray(item.repeatWeekdays) ? item.repeatWeekdays : [],
        weekdayOptions: markWeekdays(repeatType === 'weekly' ? item.repeatWeekdays : []),
        repeatDay,
        showMonthSkipHint: repeatType === 'monthly' && repeatDay >= 29,
        originalRepeatType: repeatType
      });
    } catch (err) {
      console.error('[schedule-edit] detail failed:', err);
      this.setData({ loading: false, errorCode: 'NETWORK_ERROR', errorMessage: '加载失败，请检查网络后重试' });
      util.toast('事项加载失败，请重试');
    }
  },

  handleError(result, fallback) {
    const message = result.code === 'NOT_BOUND' ? '请先绑定伴侣后使用情侣日程'
      : result.code === 'BINDING_INVALID' ? '绑定关系异常，请重新绑定' : (result.msg || fallback);
    this.setData({ loading: false, errorCode: result.code || 'LOAD_FAILED', errorMessage: message });
  },

  onTypeTap(event) {
    const type = event.currentTarget.dataset.type;
    if (TYPES.some((item) => item.value === type)) this.setData({ type });
  },
  onOwnerTap(event) {
    const ownerChoice = event.currentTarget.dataset.owner;
    if (OWNER_OPTIONS.some((item) => item.value === ownerChoice)) this.setData({ ownerChoice });
  },
  onRepeatTap(event) {
    const repeatType = event.currentTarget.dataset.repeat;
    if (!REPEAT_OPTIONS.some((item) => item.value === repeatType) || repeatType === this.data.repeatType) return;
    if (repeatType === 'none') {
      this.setData({ repeatType, date: this.data.repeatStartDate || this.data.date, repeatStartDate: '', repeatEndDate: '', repeatWeekdays: [], weekdayOptions: markWeekdays([]), repeatDay: null, showMonthSkipHint: false });
      return;
    }
    const start = this.data.repeatType === 'none' ? this.data.date : (this.data.repeatStartDate || this.data.date);
    const update = { repeatType, date: start, repeatStartDate: start, repeatEndDate: addDays(start, 30), repeatWeekdays: [], weekdayOptions: markWeekdays([]), repeatDay: null, showMonthSkipHint: false };
    if (repeatType === 'weekly') {
      update.repeatWeekdays = [isoWeekday(start)];
      update.weekdayOptions = markWeekdays(update.repeatWeekdays);
    }
    if (repeatType === 'monthly') {
      update.repeatDay = dayOfMonth(start);
      update.showMonthSkipHint = update.repeatDay >= 29;
    }
    this.setData(update);
  },
  onWeekdayTap(event) {
    const day = Number(event.currentTarget.dataset.day);
    const selected = this.data.repeatWeekdays.slice();
    const index = selected.indexOf(day);
    if (index >= 0) selected.splice(index, 1); else selected.push(day);
    selected.sort((a, b) => a - b);
    this.setData({ repeatWeekdays: selected, weekdayOptions: markWeekdays(selected) });
  },
  isWeekdaySelected(day) { return this.data.repeatWeekdays.includes(day); },
  onTitleInput(event) { this.setData({ title: event.detail.value }); },
  onDateChange(event) { this.setData({ date: event.detail.value }); },
  onRepeatStartChange(event) {
    const repeatStartDate = event.detail.value;
    const update = { repeatStartDate };
    if (this.data.repeatEndDate < repeatStartDate) update.repeatEndDate = addDays(repeatStartDate, 30);
    if (this.data.repeatType === 'weekly' && !this.data.repeatWeekdays.length) {
      update.repeatWeekdays = [isoWeekday(repeatStartDate)];
      update.weekdayOptions = markWeekdays(update.repeatWeekdays);
    }
    if (this.data.repeatType === 'monthly' && !this.data.repeatDay) {
      update.repeatDay = dayOfMonth(repeatStartDate);
      update.showMonthSkipHint = update.repeatDay >= 29;
    }
    this.setData(update);
  },
  onRepeatEndChange(event) { this.setData({ repeatEndDate: event.detail.value }); },
  onRepeatDayInput(event) {
    const raw = event.detail.value;
    const repeatDay = raw === '' ? null : Number(raw);
    this.setData({ repeatDay, showMonthSkipHint: repeatDay >= 29 && repeatDay <= 31 });
  },
  onStartTimeChange(event) { this.setData({ startTime: event.detail.value }); },
  onEndTimeChange(event) { this.setData({ endTime: event.detail.value }); },
  onClearStartTime() { this.setData({ startTime: '' }); },
  onClearEndTime() { this.setData({ endTime: '' }); },
  onNoteInput(event) { this.setData({ note: event.detail.value }); },

  buildPayload(overrides) {
    const ownerChoice = this.data.ownerChoice;
    const payload = {
      type: this.data.type,
      title: this.data.title.trim(),
      startTime: this.data.startTime,
      endTime: this.data.endTime,
      note: this.data.note.trim(),
      ownerType: ownerChoice === 'couple' ? 'couple' : 'personal',
      ownerId: ownerChoice === 'mine' ? this._myId : (ownerChoice === 'partner' ? this._partnerId : null),
      repeatType: this.data.repeatType
    };
    if (this.data.editMode) payload.id = this.data.editId;
    if (this.data.repeatType === 'none') payload.date = this.data.date;
    else {
      payload.repeatStartDate = this.data.repeatStartDate;
      payload.repeatEndDate = this.data.repeatEndDate;
      if (this.data.repeatType === 'weekly') payload.repeatWeekdays = this.data.repeatWeekdays.slice();
      if (this.data.repeatType === 'monthly') payload.repeatDay = this.data.repeatDay;
    }
    return Object.assign(payload, overrides || {});
  },

  validateForm(payload) {
    if (!payload.title) return '请输入事项标题';
    if (!this._myId || !this._partnerId) return '用户或伴侣信息未就绪，请稍后重试';
    if (payload.startTime && payload.endTime && payload.endTime < payload.startTime) return '结束时间不能早于开始时间';
    if (payload.repeatType !== 'none' && payload.repeatEndDate < payload.repeatStartDate) return '循环结束日期不能早于开始日期';
    if (payload.repeatType === 'weekly' && (!payload.repeatWeekdays || !payload.repeatWeekdays.length)) return '请至少选择一个重复星期';
    if (payload.repeatType === 'monthly' && (!Number.isInteger(payload.repeatDay) || payload.repeatDay < 1 || payload.repeatDay > 31)) return '每月日期必须为 1～31';
    return '';
  },

  async onSave() {
    if (this.data.saving) return;
    const payload = this.buildPayload();
    const error = this.validateForm(payload);
    if (error) return util.toast(error);
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中...', mask: true });
    try {
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

  onStopRepeat() {
    if (!this.data.editMode || this.data.repeatType === 'none' || this.data.stopping) return;
    const today = shanghaiDate(0);
    const yesterday = shanghaiDate(-1);
    if (this.data.repeatEndDate < today) return util.toast('该重复事项已停止');
    if (yesterday < this.data.repeatStartDate) {
      wx.showModal({
        title: '停止重复',
        content: '该重复事项尚未产生历史记录，是否直接删除？',
        confirmText: '直接删除',
        confirmColor: '#F0483E',
        success: (result) => { if (result.confirm) this.deleteSchedule(); }
      });
      return;
    }
    wx.showModal({
      title: '停止重复',
      content: '从今天起停止重复，历史记录会保留。',
      confirmText: '停止重复',
      success: (result) => { if (result.confirm) this.stopRepeat(yesterday); }
    });
  },
  async stopRepeat(yesterday) {
    const payload = this.buildPayload({ repeatEndDate: yesterday });
    const error = this.validateForm(payload);
    if (error) return util.toast(error);
    this.setData({ stopping: true });
    wx.showLoading({ title: '处理中...', mask: true });
    try {
      const res = await wx.cloud.callFunction({ name: 'saveSchedule', data: payload });
      const result = res.result || {};
      if (!result.success) return util.toast(result.msg || '停止重复失败，请重试');
      util.toast('已停止重复');
      setTimeout(() => wx.navigateBack(), 500);
    } catch (err) {
      console.error('[schedule-edit] stop repeat failed:', err);
      util.toast('停止重复失败，请检查网络');
    } finally {
      wx.hideLoading();
      this.setData({ stopping: false });
    }
  },

  onDelete() {
    if (!this.data.editMode || this.data.deleting) return;
    const recurring = this.data.originalRepeatType !== 'none';
    wx.showModal({
      title: '删除事项',
      content: recurring ? '删除后，整个重复事项及其完成记录都将移除，无法恢复。' : '删除后无法恢复，确定要删除吗？',
      confirmText: '删除',
      confirmColor: '#F0483E',
      success: (modalResult) => { if (modalResult.confirm) this.deleteSchedule(); }
    });
  },
  async deleteSchedule() {
    this.setData({ deleting: true });
    wx.showLoading({ title: '删除中...', mask: true });
    try {
      const res = await wx.cloud.callFunction({ name: 'deleteSchedule', data: { id: this.data.editId } });
      const result = res.result || {};
      if (!result.success) return util.toast(result.msg || '删除失败，请重试');
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
  onRetry() { this.loadDetail(); },
  onGoBind() { wx.navigateTo({ url: '/pages/bind/bind' }); }
});
