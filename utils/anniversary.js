const DAY_MS = 24 * 60 * 60 * 1000;

function validDate(value) {
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(value || ''))) return false;
  const parts = value.split('-').map(Number);
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return date.getUTCFullYear() === parts[0] && date.getUTCMonth() === parts[1] - 1 && date.getUTCDate() === parts[2];
}

function shanghaiToday(now) {
  const shifted = new Date((now === undefined ? Date.now() : now) + 8 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function dayNumber(value) {
  const parts = value.split('-').map(Number);
  return Date.UTC(parts[0], parts[1] - 1, parts[2]) / DAY_MS;
}

function anniversaryDays(anniversaryDate, today) {
  const naturalToday = today || shanghaiToday();
  if (!validDate(anniversaryDate) || !validDate(naturalToday)) return null;
  return Math.trunc(dayNumber(naturalToday) - dayNumber(anniversaryDate)) + 1;
}

function dotDate(value) {
  return validDate(value) ? value.replace(/-/g, '.') : '';
}

module.exports = { validDate, shanghaiToday, anniversaryDays, dotDate };
