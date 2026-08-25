const util = require('../../utils/util');
const calendar = require('../../utils/calendar');

const TYPE_META = {
  schedule: { text: '日程', className: 'schedule' },
  todo: { text: '待办', className: 'todo' },
  checkin: { text: '打卡', className: 'checkin' }
};

function enrichItem(item) {
  const meta = TYPE_META[item.type] || TYPE_META.schedule;
  const hasTime = !!item.startTime;
  const occurrenceDate = item.occurrenceDate || item.date;
  const scheduleId = item.scheduleId || item._id;
  const instanceKey = item.instanceKey || `${scheduleId}:${occurrenceDate}`;
  let stateText = '';
  if (item.type === 'schedule') stateText = item.completed ? '已完成' : '待完成';
  if (item.type === 'todo') stateText = item.completed ? '已完成' : '待完成';
  if (item.type === 'checkin') stateText = item.completed ? '已打卡' : '待打卡';
  return Object.assign({}, item, {
    typeText: meta.text,
    typeClass: meta.className,
    occurrenceDate,
    scheduleId,
    instanceKey,
    ownerLabel: item.ownerLabel || '双人',
    ownerClass: item.ownerType === 'personal' ? (item.ownerLabel === '我的' ? 'mine' : 'partner') : 'couple',
    repeatText: item.repeatType === 'daily' ? '每天' : item.repeatType === 'weekly' ? '每周' : item.repeatType === 'monthly' ? '每月' : '',
    timeText: hasTime ? (item.endTime ? `${item.startTime}–${item.endTime}` : item.startTime) : '',
    stateText,
    completedHint: item.completed && item.completedByName ? `由 ${item.completedByName} 完成` : ''
  });
}

Page({
  data: {
    year: 0,
    month: 0,
    monthText: '',
    today: '',
    selectedDate: '',
    selectedDateText: '',
    weekdays: ['日', '一', '二', '三', '四', '五', '六'],
    calendarDays: [],
    monthList: [],
    selectedList: [],
    loading: true,
    errorCode: '',
    errorMessage: ''
  },

  onLoad(options) {
    const today = util.today();
    const parts = today.split('-').map(Number);
    this._dateMap = {};
    this._requestId = 0;
    this.setData({
      year: parts[0],
      month: parts[1],
      today,
      selectedDate: options && /^\d{4}-\d{2}-\d{2}$/.test(options.date || '') ? options.date : today
    });
    this.rebuildCalendar();
  },

  onShow() {
    if (!this.data.year) return;
    this.loadCurrentMonth();
  },

  onPullDownRefresh() {
    this.loadCurrentMonth().finally(() => wx.stopPullDownRefresh());
  },

  rebuildCalendar() {
    const markedDates = {};
    Object.keys(this._dateMap || {}).forEach((date) => { markedDates[date] = this._dateMap[date].length > 0; });
    const { year, month, today, selectedDate } = this.data;
    this.setData({
      monthText: `${year}年${month}月`,
      selectedDateText: this.formatSelectedDate(selectedDate),
      calendarDays: calendar.buildMonth(year, month, { today, selectedDate, markedDates })
    });
  },

  formatSelectedDate(date) {
    const parts = String(date || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some((value) => !value)) return '';
    return `${parts[1]}月${parts[2]}日${date === this.data.today ? ' · 今天' : ''}`;
  },

  async loadCurrentMonth() {
    const requestId = ++this._requestId;
    const { year, month } = this.data;
    this.setData({ loading: true, errorCode: '', errorMessage: '' });
    try {
      const res = await wx.cloud.callFunction({ name: 'getSchedules', data: { year, month } });
      if (requestId !== this._requestId) return;
      const result = res.result || {};
      if (!result.success) {
        this.handleLoadError(result);
        return;
      }
      this.applyMonthList(Array.isArray(result.list) ? result.list : []);
    } catch (err) {
      if (requestId !== this._requestId) return;
      console.error('[schedule] load failed:', err);
      this.setData({ loading: false, errorCode: 'NETWORK_ERROR', errorMessage: '加载失败，请检查网络后重试' });
      util.toast('日程加载失败，请重试');
    }
  },

  handleLoadError(result) {
    const message = result.code === 'NOT_BOUND'
      ? '请先绑定伴侣后使用情侣日程'
      : result.code === 'BINDING_INVALID'
        ? '绑定关系异常，请重新绑定'
        : (result.msg || '日程加载失败，请重试');
    this._dateMap = {};
    this.setData({ loading: false, monthList: [], selectedList: [], errorCode: result.code || 'LOAD_FAILED', errorMessage: message });
    this.rebuildCalendar();
  },

  applyMonthList(list) {
    const dateMap = {};
    list.forEach((raw) => {
      const item = enrichItem(raw);
      if (!dateMap[item.occurrenceDate]) dateMap[item.occurrenceDate] = [];
      dateMap[item.occurrenceDate].push(item);
    });
    Object.keys(dateMap).forEach((date) => {
      dateMap[date].sort((left, right) => {
        const leftTime = left.startTime || '99:99';
        const rightTime = right.startTime || '99:99';
        if (leftTime !== rightTime) return leftTime.localeCompare(rightTime);
        return String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
      });
    });
    this._dateMap = dateMap;
    this.setData({ monthList: list, selectedList: dateMap[this.data.selectedDate] || [], loading: false, errorCode: '', errorMessage: '' });
    this.rebuildCalendar();
  },

  onPreviousMonth() {
    this.changeMonth(-1);
  },

  onNextMonth() {
    this.changeMonth(1);
  },

  onBackToCurrentMonth() {
    const parts = this.data.today.split('-').map(Number);
    this._dateMap = {};
    this.setData({ year: parts[0], month: parts[1], selectedDate: this.data.today, monthList: [], selectedList: [] });
    this.rebuildCalendar();
    this.loadCurrentMonth();
  },

  changeMonth(offset) {
    const target = calendar.shiftMonth(this.data.year, this.data.month, offset);
    const selectedDate = calendar.dateKey(target.year, target.month, 1);
    this._dateMap = {};
    this.setData({ year: target.year, month: target.month, selectedDate, monthList: [], selectedList: [] });
    this.rebuildCalendar();
    this.loadCurrentMonth();
  },

  onDayTap(event) {
    const date = event.currentTarget.dataset.date;
    const year = Number(event.currentTarget.dataset.year);
    const month = Number(event.currentTarget.dataset.month);
    if (!date) return;
    if (year !== this.data.year || month !== this.data.month) {
      this._dateMap = {};
      this.setData({ year, month, selectedDate: date, monthList: [], selectedList: [] });
      this.rebuildCalendar();
      this.loadCurrentMonth();
      return;
    }
    this.setData({ selectedDate: date, selectedList: this._dateMap[date] || [] });
    this.rebuildCalendar();
  },

  onCreate() {
    wx.navigateTo({ url: `/pages/schedule-edit/schedule-edit?date=${this.data.selectedDate}` });
  },

  onEditItem(event) {
    const id = event.currentTarget.dataset.scheduleId || event.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: `/pages/schedule-edit/schedule-edit?id=${id}` });
  },

  async onToggle(event) {
    const id = event.currentTarget.dataset.scheduleId || event.currentTarget.dataset.id;
    const occurrenceDate = event.currentTarget.dataset.occurrenceDate;
    const instanceKey = event.currentTarget.dataset.instanceKey;
    const completed = event.currentTarget.dataset.completed === true || event.currentTarget.dataset.completed === 'true';
    if (!id || !occurrenceDate || !instanceKey || this._togglingKey) return;
    this._togglingKey = instanceKey;
    try {
      const res = await wx.cloud.callFunction({ name: 'toggleSchedule', data: { id, occurrenceDate, completed: !completed } });
      const result = res.result || {};
      if (!result.success || !result.schedule) {
        util.toast(result.msg || '操作失败，请重试');
        return;
      }
      const completionPatch = {
        completed: !!result.schedule.completed,
        completedBy: result.schedule.completedBy || '',
        completedByName: result.schedule.completedByName || '',
        completedAt: result.schedule.completedAt || null
      };
      const dateItems = this._dateMap[occurrenceDate] || [];
      this._dateMap[occurrenceDate] = dateItems.map((item) =>
        item.instanceKey === instanceKey ? enrichItem(Object.assign({}, item, completionPatch)) : item
      );
      if (this.data.selectedDate === occurrenceDate) {
        const selectedIndex = this.data.selectedList.findIndex((item) => item.instanceKey === instanceKey);
        if (selectedIndex >= 0) {
          const updated = this._dateMap[occurrenceDate].find((item) => item.instanceKey === instanceKey);
          this.setData({
            [`selectedList[${selectedIndex}].completed`]: updated.completed,
            [`selectedList[${selectedIndex}].completedBy`]: updated.completedBy,
            [`selectedList[${selectedIndex}].completedByName`]: updated.completedByName,
            [`selectedList[${selectedIndex}].completedAt`]: updated.completedAt,
            [`selectedList[${selectedIndex}].stateText`]: updated.stateText,
            [`selectedList[${selectedIndex}].completedHint`]: updated.completedHint
          });
        }
      }
      util.toast(result.schedule.completed ? '已完成' : '已取消完成');
    } catch (err) {
      console.error('[schedule] toggle failed:', err);
      util.toast('操作失败，请检查网络');
    } finally {
      this._togglingKey = '';
    }
  },

  onRetry() {
    this.loadCurrentMonth();
  },

  onGoBind() {
    wx.navigateTo({ url: '/pages/bind/bind' });
  }
});
