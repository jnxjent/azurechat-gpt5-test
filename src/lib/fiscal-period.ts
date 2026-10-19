// Company fiscal calendar, confirmed by the user. End dates in the API are exclusive.
export const FISCAL_CALENDAR = { startMonth: 4, timeZone: "Asia/Tokyo" } as const;
export type FiscalPeriod = { fiscalStart: string; fiscalEnd: string };

export const FISCAL_PERIOD_DICTIONARY = {
  currentYear: ["今期", "当期", "今年度", "本年度", "今会計年度", "当年度"],
  previousYear: ["前期", "前年度", "昨年度", "去年度", "前会計年度"],
  nextYear: ["来期", "次期", "来年度", "次年度"],
  firstHalf: ["上期", "上半期"],
  secondHalf: ["下期", "下半期"],
  quarters: [["第1四半期", "第一四半期", "Q1", "1Q"], ["第2四半期", "第二四半期", "Q2", "2Q"], ["第3四半期", "第三四半期", "Q3", "3Q"], ["第4四半期", "第四四半期", "Q4", "4Q"]],
} as const;

const explicitRange = /(\d{4})[年/-](\d{1,2})(?:月|[-/])(\d{1,2})?日?\s*(?:から|[～〜~–—])\s*(\d{4})[年/-](\d{1,2})(?:月|[-/])(\d{1,2})?日?/g;
const iso = (value: Date) => value.toISOString().slice(0, 10);

export function hasFiscalPeriodExpression(message: string): boolean {
  const text = message.normalize("NFKC");
  return /\d{4}[年/-]\d|\d{4}年度|四半期|上期|下期|上半期|下半期|昨年|去年|今年(?!度)|\b[Qq][1-4]\b|\b[1-4][Qq]\b/.test(text)
    || [...FISCAL_PERIOD_DICTIONARY.currentYear, ...FISCAL_PERIOD_DICTIONARY.previousYear, ...FISCAL_PERIOD_DICTIONARY.nextYear].some(word => text.includes(word));
}

export function resolveFiscalPeriod(message: string, now = new Date()): FiscalPeriod | undefined {
  const text = message.normalize("NFKC");
  const ranges = Array.from(text.matchAll(explicitRange));
  if (ranges.length > 1) return undefined; // Multiple periods need a comparison plan, not a single aggregate.
  if (ranges.length === 1) {
    const [, sy, sm, sd, ey, em, ed] = ranges[0];
    const start = new Date(Date.UTC(+sy, +sm - 1, sd ? +sd : 1));
    const last = new Date(Date.UTC(+ey, +em - 1, ed ? +ed : 1));
    if (start.getUTCFullYear() !== +sy || start.getUTCMonth() !== +sm - 1 || last.getUTCFullYear() !== +ey || last.getUTCMonth() !== +em - 1 || (sd && start.getUTCDate() !== +sd) || (ed && last.getUTCDate() !== +ed)) return undefined;
    const end = ed ? new Date(last.getTime() + 86400000) : new Date(Date.UTC(+ey, +em, 1));
    if (end <= start || end.getTime() - start.getTime() > 366 * 86400000) return undefined;
    return { fiscalStart: iso(start), fiscalEnd: iso(end) };
  }
  // An incomplete/invalid explicit date must not silently fall back to a relative year.
  if (/\d{4}[年/-]\d/.test(text)) return undefined;
  if (!Number.isFinite(now.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: FISCAL_CALENDAR.timeZone, year: "numeric", month: "numeric" }).formatToParts(now);
  const calendarYear = Number(parts.find(part => part.type === "year")?.value);
  const month = Number(parts.find(part => part.type === "month")?.value);
  const currentYear = calendarYear - (month < FISCAL_CALENDAR.startMonth ? 1 : 0);
  const years = Array.from(text.matchAll(/(\d{4})年度/g)).map(match => Number(match[1]));
  if (new Set(years).size > 1) return undefined;
  const has = (words: readonly string[]) => words.some(word => text.includes(word));
  const offsets = [has(FISCAL_PERIOD_DICTIONARY.currentYear) ? 0 : undefined, has(FISCAL_PERIOD_DICTIONARY.previousYear) ? -1 : undefined, has(FISCAL_PERIOD_DICTIONARY.nextYear) ? 1 : undefined].filter((value): value is number => value !== undefined);
  if (offsets.length > 1) return undefined;
  let year = years[0] ?? currentYear + (offsets[0] ?? 0);
  if (years.length && offsets.length && year !== currentYear + offsets[0]) return undefined;
  const quarterMatches = FISCAL_PERIOD_DICTIONARY.quarters.flatMap((words, index) => words.some(word => /Q/i.test(word) ? new RegExp(`(?<![A-Za-z0-9])${word}(?![A-Za-z0-9])`, "i").test(text) : text.includes(word)) ? [index] : []);
  const half = [has(FISCAL_PERIOD_DICTIONARY.firstHalf) ? 0 : undefined, has(FISCAL_PERIOD_DICTIONARY.secondHalf) ? 6 : undefined].filter((value): value is number => value !== undefined);
  if (quarterMatches.length > 1 || half.length > 1 || (quarterMatches.length && half.length)) return undefined;
  let offset = quarterMatches.length ? quarterMatches[0] * 3 : half[0] ?? 0;
  let length = quarterMatches.length ? 3 : half.length ? 6 : 12;
  const relativeQuarters = ["今四半期", "当四半期", "前四半期", "次四半期"].filter(word => text.includes(word));
  if (/四半期|(?:^|[^A-Za-z0-9])[Qq]\d|\d[Qq](?:$|[^A-Za-z0-9])/.test(text) && !quarterMatches.length && !relativeQuarters.length) return undefined;
  if (relativeQuarters.length) {
    if (relativeQuarters.length > 1 || years.length || offsets.length || quarterMatches.length || half.length) return undefined;
    const shift = relativeQuarters[0] === "前四半期" ? -1 : relativeQuarters[0] === "次四半期" ? 1 : 0;
    offset = (Math.floor(((month - FISCAL_CALENDAR.startMonth + 12) % 12) / 3) + shift) * 3;
    length = 3;
    year = currentYear;
  } else if (!years.length && !offsets.length && !quarterMatches.length && !half.length) return undefined;
  return { fiscalStart: iso(new Date(Date.UTC(year, FISCAL_CALENDAR.startMonth - 1 + offset, 1))), fiscalEnd: iso(new Date(Date.UTC(year, FISCAL_CALENDAR.startMonth - 1 + offset + length, 1))) };
}
