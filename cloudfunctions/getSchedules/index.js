// 云函数：getSchedules —— 查询指定月/日并在服务端展开循环实例
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const MAX_RULES = 500;
const MAX_OCCURRENCES = 2000;
const RECURRING_TYPES = ['daily', 'weekly', 'monthly'];

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function parseDate(value) { const [y, m, d] = value.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function formatDate(date) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`; }
function eachDate(start, end, callback) {
  for (let cursor = parseDate(start); formatDate(cursor) <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) callback(formatDate(cursor), cursor);
}
function normalize(schedule, me) {
  const ownerType = schedule.ownerType === 'personal' ? 'personal' : 'couple';
  const ownerId = ownerType === 'personal' ? (schedule.ownerId || null) : null;
  const repeatType = RECURRING_TYPES.includes(schedule.repeatType) ? schedule.repeatType : 'none';
  return Object.assign({}, schedule, {
    ownerType, ownerId, ownerLabel: ownerType === 'couple' ? '双人' : (ownerId === me._id ? '我的' : 'TA'),
    repeatType, date: repeatType === 'none' ? (schedule.date || null) : null,
    repeatStartDate: repeatType === 'none' ? null : schedule.repeatStartDate,
    repeatEndDate: repeatType === 'none' ? null : schedule.repeatEndDate,
    repeatWeekdays: repeatType === 'weekly' && Array.isArray(schedule.repeatWeekdays) ? schedule.repeatWeekdays : [],
    repeatDay: repeatType === 'monthly' ? schedule.repeatDay : null
  });
}
function isOccurrence(schedule, date) {
  if (!isValidDate(date)) return false;
  if (schedule.repeatType === 'none') return schedule.date === date;
  if (!isValidDate(schedule.repeatStartDate) || !isValidDate(schedule.repeatEndDate) || date < schedule.repeatStartDate || date > schedule.repeatEndDate) return false;
  const parsed = parseDate(date);
  if (schedule.repeatType === 'daily') return true;
  if (schedule.repeatType === 'weekly') {
    const weekday = parsed.getUTCDay() || 7;
    return schedule.repeatWeekdays.includes(weekday);
  }
  return schedule.repeatType === 'monthly' && parsed.getUTCDate() === schedule.repeatDay;
}
function makeInstance(schedule, occurrenceDate) {
  const recurring = schedule.repeatType !== 'none';
  return {
    _id: schedule._id, scheduleId: schedule._id, occurrenceDate,
    // V1 页面仍按 item.date 分组；V2 页面改造后以 occurrenceDate 为准。
    date: occurrenceDate,
    instanceKey: `${schedule._id}:${occurrenceDate}`, isRecurring: recurring, repeatType: schedule.repeatType,
    type: schedule.type, title: schedule.title, startTime: schedule.startTime || '', endTime: schedule.endTime || '', note: schedule.note || '',
    ownerType: schedule.ownerType, ownerId: schedule.ownerId, ownerLabel: schedule.ownerLabel,
    creatorId: schedule.creatorId, creatorName: schedule.creatorName || '',
    completed: recurring ? false : !!schedule.completed,
    completedBy: recurring ? '' : (schedule.completedBy || ''),
    completedByName: recurring ? '' : (schedule.completedByName || ''),
    completedAt: recurring ? null : (schedule.completedAt || null),
    createdAt: schedule.createdAt, updatedAt: schedule.updatedAt
  };
}
async function getBoundUser(openid) {
  const users = db.collection('users');
  const res = await users.where({ openid }).get();
  if (res.data.length !== 1) return { error: { success: false, code: 'USER_NOT_FOUND', msg: '请先登录' } };
  const me = res.data[0];
  if (!me.partnerId) return { error: { success: false, code: 'NOT_BOUND', msg: '请先绑定伴侣' } };
  const partnerRes = await users.doc(me.partnerId).get().catch(() => null);
  if (!partnerRes || !partnerRes.data || partnerRes.data.partnerId !== me._id) return { error: { success: false, code: 'BINDING_INVALID', msg: '绑定关系异常，请重新绑定' } };
  return { me, userIds: [me._id, me.partnerId] };
}
function getRange(event) {
  const requestedDate = typeof event.date === 'string' ? event.date.trim() : '';
  if (requestedDate) return isValidDate(requestedDate) ? { startDate: requestedDate, endDate: requestedDate } : null;
  const year = Number(event.year), month = Number(event.month);
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) return null;
  const monthText = String(month).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { startDate: `${year}-${monthText}-01`, endDate: `${year}-${monthText}-${String(lastDay).padStart(2, '0')}` };
}

exports.main = async (event = {}) => {
  try {
    const auth = await getBoundUser(cloud.getWXContext().OPENID);
    if (auth.error) return auth.error;
    const range = getRange(event);
    if (!range) return { success: false, code: 'INVALID_RANGE', msg: '查询日期参数不正确' };
    const schedules = db.collection('schedules');
    const normalPromise = schedules.where({ creatorId: _.in(auth.userIds), date: _.gte(range.startDate).and(_.lte(range.endDate)) }).limit(MAX_RULES + 1).get();
    const recurringPromises = RECURRING_TYPES.map((repeatType) => schedules.where({
      creatorId: _.in(auth.userIds), repeatType, repeatStartDate: _.lte(range.endDate)
    }).limit(MAX_RULES + 1).get());
    const queryResults = await Promise.all([normalPromise].concat(recurringPromises));
    if (queryResults.some((result) => result.data.length > MAX_RULES)) return { success: false, code: 'TOO_MANY_RULES', msg: '日程规则过多，请减少后再查看' };
    const rawRules = queryResults.reduce((all, result) => all.concat(result.data), []);
    const seen = new Set();
    const rules = rawRules.filter((rule) => !seen.has(rule._id) && seen.add(rule._id)).map((rule) => normalize(rule, auth.me));
    const list = [];
    rules.forEach((rule) => {
      if (rule.repeatType === 'none') {
        if (isOccurrence(rule, rule.date)) list.push(makeInstance(rule, rule.date));
        return;
      }
      if (rule.repeatEndDate < range.startDate) return;
      const start = rule.repeatStartDate > range.startDate ? rule.repeatStartDate : range.startDate;
      const end = rule.repeatEndDate < range.endDate ? rule.repeatEndDate : range.endDate;
      eachDate(start, end, (date) => { if (isOccurrence(rule, date)) list.push(makeInstance(rule, date)); });
    });
    if (list.length > MAX_OCCURRENCES) return { success: false, code: 'TOO_MANY_RESULTS', msg: '查询范围内事项过多，请缩小范围' };
    const completionTargets = list.filter((item) => item.isRecurring && item.type !== 'schedule');
    if (completionTargets.length) {
      const ids = Array.from(new Set(completionTargets.map((item) => item.scheduleId)));
      const completionRes = await db.collection('schedule_completions').where({
        scheduleId: _.in(ids), occurrenceDate: _.gte(range.startDate).and(_.lte(range.endDate))
      }).get();
      const completionMap = new Map(completionRes.data.map((item) => [`${item.scheduleId}:${item.occurrenceDate}`, item]));
      completionTargets.forEach((item) => {
        const completion = completionMap.get(item.instanceKey);
        if (completion) Object.assign(item, { completed: true, completedBy: completion.completedBy, completedByName: completion.completedByName || '', completedAt: completion.completedAt });
      });
    }
    list.sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate) || (a.startTime || '99:99').localeCompare(b.startTime || '99:99') || String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.scheduleId.localeCompare(b.scheduleId));
    return { success: true, range, list };
  } catch (err) {
    console.error('[getSchedules] failed:', err && (err.errMsg || err.message || err));
    return { success: false, code: 'QUERY_FAILED', msg: '查询失败，请重试' };
  }
};
