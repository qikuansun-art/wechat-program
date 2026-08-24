// 月历纯函数工具：生成固定 6 × 7 的 42 格数据。
function pad(value) {
  return String(value).padStart(2, '0');
}

function dateKey(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function shiftMonth(year, month, offset) {
  const target = new Date(year, month - 1 + offset, 1);
  return { year: target.getFullYear(), month: target.getMonth() + 1 };
}

function buildMonth(year, month, options) {
  const config = options || {};
  const today = config.today || '';
  const selectedDate = config.selectedDate || '';
  const markedDates = config.markedDates || {};
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const currentDays = daysInMonth(year, month);
  const previous = shiftMonth(year, month, -1);
  const previousDays = daysInMonth(previous.year, previous.month);
  const cells = [];

  for (let index = 0; index < 42; index++) {
    const relativeDay = index - firstWeekday + 1;
    let cellYear = year;
    let cellMonth = month;
    let day = relativeDay;
    let currentMonth = true;

    if (relativeDay <= 0) {
      cellYear = previous.year;
      cellMonth = previous.month;
      day = previousDays + relativeDay;
      currentMonth = false;
    } else if (relativeDay > currentDays) {
      const next = shiftMonth(year, month, 1);
      cellYear = next.year;
      cellMonth = next.month;
      day = relativeDay - currentDays;
      currentMonth = false;
    }

    const date = dateKey(cellYear, cellMonth, day);
    cells.push({
      key: date,
      date,
      year: cellYear,
      month: cellMonth,
      day,
      currentMonth,
      isToday: date === today,
      selected: date === selectedDate,
      hasItems: !!markedDates[date]
    });
  }
  return cells;
}

module.exports = { pad, dateKey, daysInMonth, shiftMonth, buildMonth };
