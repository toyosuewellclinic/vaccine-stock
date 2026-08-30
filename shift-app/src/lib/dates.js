// 日付は 'YYYY-MM-DD' 文字列で扱い、計算は UTC 基準で行う（実行環境の TZ に影響されないため）。

const DAY_MS = 86400000;
const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

export function toDayIndex(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function fromDayIndex(index) {
  return new Date(index * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date, days) {
  return fromDayIndex(toDayIndex(date) + days);
}

export function eachDate(startDate, endDate) {
  const out = [];
  for (let i = toDayIndex(startDate); i <= toDayIndex(endDate); i++) out.push(fromDayIndex(i));
  return out;
}

// 0=日 ... 6=土
export function dayOfWeek(date) {
  return (((toDayIndex(date) + 4) % 7) + 7) % 7;
}

export function weekdayJa(date) {
  return WEEKDAY_JA[dayOfWeek(date)];
}

export function formatJa(date) {
  const [, m, d] = date.split('-');
  return `${Number(m)}/${Number(d)}(${weekdayJa(date)})`;
}

export function timeToMinutes(time) {
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + (m || 0);
}

// タイムゾーンを指定して「今日」の 'YYYY-MM-DD' を得る
export function todayIn(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

export function daysBetween(from, to) {
  return toDayIndex(to) - toDayIndex(from);
}
