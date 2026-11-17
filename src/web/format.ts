const dateTime = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" });
const number = new Intl.NumberFormat("de-DE");
const percent = new Intl.NumberFormat("de-DE", { style: "percent", maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat("de-DE", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export const fmtDateTime = (ms: number | null | undefined) => (ms ? dateTime.format(new Date(ms)) : "–");
export const fmtDate = (ms: number | null | undefined) => (ms ? dateOnly.format(new Date(ms)) : "–");
export const fmtNumber = (n: number) => number.format(n);
export const fmtPercent = (ratio: number) => percent.format(ratio);
export const fmtUsd = (n: number) => usd.format(n);

export function fmtRelative(ms: number | null | undefined): string {
  if (!ms) return "–";
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("de-DE", { numeric: "auto" });
  if (abs < 60_000) return diff >= 0 ? "gleich" : "gerade eben";
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  return rtf.format(Math.round(diff / 86_400_000), "day");
}
