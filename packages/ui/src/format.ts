export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');

export function fmtTokens(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(0) + 'K';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

export function fmtUSD(n: number): string {
  if (n === 0) return '$0';
  if (Math.abs(n) < 0.01) return '$' + n.toFixed(4);
  if (Math.abs(n) < 100) return '$' + n.toFixed(2);
  return '$' + Math.round(n).toLocaleString('en-US');
}

export const fmtPct = (x: number) => (x * 100).toFixed(x < 0.1 ? 1 : 0) + '%';

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtDay(day: string): string {
  const d = new Date(day + 'T12:00:00');
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Local YYYY-MM-DD. */
export function isoDay(d: Date): string {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDay(d);
}
