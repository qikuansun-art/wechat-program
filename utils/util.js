// utils/util.js —— 公共工具函数

/** 状态 → 文案 / 样式类名 映射 */
const STATUS = {
  pending:  { text: '待审批', className: 'pending'  },
  approved: { text: '已批准', className: 'approved' },
  rejected: { text: '已驳回', className: 'rejected' }
};

/** 获取状态文案，未知状态返回原值 */
function statusText(status) {
  return STATUS[status] ? STATUS[status].text : status;
}

/** 获取状态标签样式类名 */
function statusClass(status) {
  return STATUS[status] ? STATUS[status].className : '';
}

/** 数字补零 */
function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
}

/** Date → 'YYYY-MM-DD HH:mm' */
function formatDateTime(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Date → 'YYYY-MM-DD' */
function formatDate(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 今天日期字符串 'YYYY-MM-DD'，给 picker 默认值用 */
function today() {
  return formatDate(new Date());
}

/** YYYY-MM-DD → 周一…周日；用 UTC 避免设备时区解析偏移。 */
function weekdayText(dateString) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString || ''));
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getUTCDay()];
}

function formatDateWithWeek(dateString) {
  const week = weekdayText(dateString);
  return week ? `${dateString} ${week}` : String(dateString || '');
}

/** 当前时间字符串 'HH:mm'，给 picker 默认值用 */
function nowTime() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 数据库 serverDate / 时间戳 → 展示用字符串 */
function prettyTime(value) {
  if (!value) return '';
  // 云开发返回的 Date 类型字段会序列化为 { $date: 毫秒 } 或 ISO 字符串
  if (typeof value === 'object' && value.$date) {
    return formatDateTime(value.$date);
  }
  return formatDateTime(value);
}

/** Date → 'YYYY-MM'（记账月份） */
function monthOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** Date → 'YYYY年M月' 展示文本 */
function monthText(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

/** 'YYYY-MM-DD' → 分组标题（今天/昨天/M月D日 周X） */
function dayText(dateStr) {
  const d = new Date(dateStr.replace(/-/g, '/'));
  if (isNaN(d.getTime())) return dateStr;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const thatDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startOfToday - thatDay) / 86400000);
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff > 1 && diff < 7) return `${d.getMonth() + 1}月${d.getDate()}日 周${week}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 简单校验手机号以外的通用必填提示 */
function toast(msg) {
  wx.showToast({ title: msg, icon: 'none', duration: 2000 });
}

module.exports = {
  STATUS,
  pad,
  daysInMonth,
  statusText,
  statusClass,
  formatDateTime,
  formatDate,
  prettyTime,
  today,
  weekdayText,
  formatDateWithWeek,
  nowTime,
  monthOf,
  monthText,
  dayText,
  toast
};
