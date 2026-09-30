import { BarChart, LineChart, TreemapChart } from 'echarts/charts';
import { AxisPointerComponent, DataZoomComponent, GridComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import type { CompositionPoint, ContextItem, CostParts, DayRow, ItemKind, RequestRow, UsageView } from './api';
import { fmtDay, fmtTime, fmtTokens, fmtUSD } from './format';

echarts.use([BarChart, LineChart, TreemapChart, GridComponent, TooltipComponent, MarkLineComponent, DataZoomComponent, AxisPointerComponent, CanvasRenderer]);

/* ---------- theme from CSS custom properties ---------- */

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const series = (i: number) => cssVar(`--series-${i}`);

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** White or ink, whichever clears contrast on a filled mark. */
export function inkOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#0b0b0b' : '#ffffff';
}

/** Token components share one fixed order everywhere: slots 1–4. */
export const COMPONENTS = [
  { key: 'input', label: 'Input', slot: 1 },
  { key: 'cacheWrite', label: 'Cache write', slot: 2 },
  { key: 'cacheRead', label: 'Cache read', slot: 3 },
  { key: 'output', label: 'Output', slot: 4 },
] as const;
export type ComponentKey = (typeof COMPONENTS)[number]['key'];
/** Cost Claude Code tallied for calls it never wrote to the transcript (titles, checks, fetch summaries). */
export const SIDE_COMPONENT = { key: 'side' as const, label: 'Side calls', slot: 5 };

/** Context items fold into eight categories (never more than eight hues). */
export const CATEGORIES = [
  { key: 'system', label: 'System prompt + tools', slot: 1, kinds: ['baseline'] },
  { key: 'results', label: 'Tool results', slot: 2, kinds: ['tool_result'] },
  { key: 'calls', label: 'Tool calls', slot: 3, kinds: ['tool_use'] },
  { key: 'prompts', label: 'Prompts & injected text', slot: 4, kinds: ['prompt', 'meta', 'compact_summary', 'image'] },
  { key: 'text', label: 'Assistant text', slot: 5, kinds: ['text'] },
  { key: 'attachments', label: 'Reminders & attachments', slot: 6, kinds: ['attachment'] },
  { key: 'thinking', label: 'Thinking', slot: 7, kinds: ['thinking'] },
  { key: 'unattributed', label: 'Not in transcript', slot: 0, kinds: ['unattributed'] },
] as const;

export function categoryOf(kind: ItemKind) {
  return CATEGORIES.find((c) => (c.kinds as readonly string[]).includes(kind)) ?? CATEGORIES[CATEGORIES.length - 1];
}
export function categoryColor(c: (typeof CATEGORIES)[number]): string {
  return c.slot ? series(c.slot) : cssVar('--other');
}

/** Round an axis top up to a clean value (1, 2, 2.5, 5 × 10ⁿ) so the last tick reads naturally. */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * mag) return m * mag;
  return 10 * mag;
}

/** Off while redrawing live, so charts update in place instead of re-animating from zero. */
let animate = true;
export function setAnimation(on: boolean) {
  animate = on;
}

function base() {
  const text2 = cssVar('--text-secondary');
  const muted = cssVar('--text-muted');
  return {
    animation: animate,
    animationDuration: 250,
    textStyle: { fontFamily: cssVar('--font'), color: text2 },
    tooltip: {
      backgroundColor: cssVar('--surface-1'),
      borderColor: cssVar('--border'),
      borderWidth: 1,
      textStyle: { color: cssVar('--text-primary'), fontSize: 12 },
      extraCssText: 'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);',
    },
    axisCommon: {
      axisLine: { lineStyle: { color: cssVar('--axis') } },
      axisTick: { show: false },
      axisLabel: { color: muted, fontSize: 11 },
      splitLine: { lineStyle: { color: cssVar('--grid'), width: 1 } },
    },
  };
}

function row(color: string, label: string, value: string, line = true) {
  const key = `<span style="display:inline-block;width:12px;height:${line ? 2 : 8}px;border-radius:${line ? 1 : 2}px;background:${color};margin-right:6px;vertical-align:${line ? 3 : 0}px"></span>`;
  return `<div style="display:flex;justify-content:space-between;gap:16px"><span>${key}<span style="color:${cssVar('--text-secondary')}">${esc(label)}</span></span><b>${value}</b></div>`;
}

/* ---------- lifecycle ---------- */

const live = new Set<echarts.ECharts>();

export function mount(el: HTMLElement): echarts.ECharts {
  const chart = echarts.init(el, undefined, { renderer: 'canvas' });
  live.add(chart);
  const ro = new ResizeObserver(() => chart.resize());
  ro.observe(el);
  (chart as unknown as { _ro: ResizeObserver })._ro = ro;
  return chart;
}

export function disposeAll() {
  for (const c of live) {
    (c as unknown as { _ro?: ResizeObserver })._ro?.disconnect();
    c.dispose();
  }
  live.clear();
}

/* ---------- 1. daily stacked bars ---------- */

export function dailyChart(
  el: HTMLElement,
  days: DayRow[],
  mode: 'tokens' | 'cost',
  onDay: (day: string) => void,
) {
  const b = base();
  const chart = mount(el);
  const surface = cssVar('--surface-1');
  // In cost mode, side calls (from Claude Code's own tally) get their own segment when there are any.
  const comps: { key: ComponentKey | 'side'; label: string; slot: number }[] =
    mode === 'cost' && days.some((d) => (d.costParts.side ?? 0) > 0) ? [...COMPONENTS, SIDE_COMPONENT] : [...COMPONENTS];
  const valueOf = (d: DayRow, k: ComponentKey | 'side') => (k === 'side' ? d.costParts.side ?? 0 : mode === 'cost' ? d.costParts[k] : d[k]);
  const fmt = mode === 'cost' ? fmtUSD : fmtTokens;
  chart.setOption({
    ...b,
    grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      ...b.tooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: cssVar('--wash') } },
      formatter: (ps: { dataIndex: number }[]) => {
        const d = days[ps[0].dataIndex];
        const total = mode === 'cost' ? d.cost : d.input + d.cacheWrite + d.cacheRead + d.output;
        return (
          `<div style="font-weight:600;margin-bottom:4px">${fmtDay(d.day)} · ${fmt(total)}</div>` +
          [...comps].reverse().map((c) => row(series(c.slot), c.label, fmt(valueOf(d, c.key)))).join('') +
          `<div style="color:${cssVar('--text-muted')};margin-top:4px">${d.sessions} sessions · ${d.requests} requests · click to open</div>`
        );
      },
    },
    xAxis: { type: 'category', data: days.map((d) => d.day), ...b.axisCommon, splitLine: { show: false }, axisLabel: { ...b.axisCommon.axisLabel, formatter: (v: string) => fmtDay(v).replace(/^\w+, /, '') } },
    yAxis: { type: 'value', ...b.axisCommon, axisLine: { show: false }, axisLabel: { ...b.axisCommon.axisLabel, formatter: (v: number) => fmt(v) } },
    series: comps.map((c, i) => ({
      name: c.label,
      type: 'bar',
      stack: 'x',
      barMaxWidth: 24,
      data: days.map((d) => valueOf(d, c.key)),
      itemStyle: {
        color: series(c.slot),
        borderColor: surface,
        borderWidth: 1,
        borderRadius: i === comps.length - 1 ? [4, 4, 0, 0] : 0,
      },
      emphasis: { focus: 'none', itemStyle: { opacity: 0.85 } },
    })),
  });
  chart.on('click', (p) => onDay(days[p.dataIndex].day));
  chart.getZr().on('click', (e) => {
    if (e.target) return;
    const idx = chart.convertFromPixel({ seriesIndex: 0 }, [e.offsetX, e.offsetY]) as number[] | undefined;
    const i = idx?.[0];
    if (i != null && days[i]) onDay(days[i].day);
  });
  return chart;
}

/* ---------- 3a. context size per request ---------- */

export function contextChart(el: HTMLElement, reqs: RequestRow[], onReq: (id: string) => void, selected?: string) {
  const b = base();
  const chart = mount(el);
  const main = reqs.filter((r) => !r.agentId);
  const subs = reqs.filter((r) => r.agentId);
  const limit = Math.max(...reqs.map((r) => r.contextLimit), 0);
  const peak = Math.max(...reqs.map((r) => r.contextTokens), 0);
  const all = [...reqs].sort((a, b) => a.ts - b.ts);
  const x = all.map((r) => r.id);
  const pointsFor = (list: RequestRow[]) => {
    const ids = new Set(list.map((r) => r.id));
    return all.map((r) => (ids.has(r.id) ? r.contextTokens : null));
  };
  const surface = cssVar('--surface-1');
  const s = [
    {
      name: 'Main thread',
      type: 'line',
      data: pointsFor(main),
      connectNulls: true,
      showSymbol: main.length < 120,
      symbol: 'circle',
      symbolSize: 8,
      lineStyle: { width: 2, color: series(1), cap: 'round', join: 'round' },
      itemStyle: { color: series(1), borderColor: surface, borderWidth: 2 },
      areaStyle: { color: series(1), opacity: 0.1 },
      markLine:
        limit && peak > limit * 0.25
          ? {
              silent: true,
              symbol: 'none',
              lineStyle: { color: cssVar('--critical'), width: 1, type: 'solid' },
              label: { formatter: `Context limit ${fmtTokens(limit)}`, color: cssVar('--text-secondary'), position: 'insideEndTop' },
              data: [{ yAxis: limit }],
            }
          : undefined,
    },
  ];
  if (subs.length)
    s.push({
      name: 'Subagents',
      type: 'line',
      data: pointsFor(subs),
      connectNulls: false,
      showSymbol: true,
      symbol: 'circle',
      symbolSize: 8,
      lineStyle: { width: 0, color: series(2), cap: 'round', join: 'round' },
      itemStyle: { color: series(2), borderColor: surface, borderWidth: 2 },
      areaStyle: undefined as unknown as { color: string; opacity: number },
      markLine: undefined,
    });
  chart.setOption({
    ...b,
    grid: { left: 8, right: 16, top: 20, bottom: 8, containLabel: true },
    tooltip: {
      ...b.tooltip,
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: cssVar('--axis') } },
      formatter: (ps: { dataIndex: number }[]) => {
        const r = all[ps[0].dataIndex];
        return (
          `<div style="font-weight:600;margin-bottom:4px">${fmtTime(r.ts)} · ${esc(r.model)}${r.agentId ? ' · subagent' : ''}</div>` +
          row(series(r.agentId ? 2 : 1), 'In context', fmtTokens(r.contextTokens), true) +
          row(series(3), 'Cache read', fmtTokens(r.usage.cacheRead), true) +
          row(series(2), 'Cache write', fmtTokens(r.usage.cacheWrite5m + r.usage.cacheWrite1h), true) +
          row(series(4), 'Output', fmtTokens(r.usage.output), true) +
          `<div style="color:${cssVar('--text-muted')};margin-top:4px">${esc(r.tools.join(', ') || 'no tool calls')} · ${fmtUSD(r.cost)}</div>`
        );
      },
    },
    xAxis: { type: 'category', data: x, ...b.axisCommon, splitLine: { show: false }, axisLabel: { ...b.axisCommon.axisLabel, formatter: (_: string, i: number) => String(i + 1) } },
    yAxis: { type: 'value', max: (v: { max: number }) => niceCeil(Math.max(v.max, peak * 1.04)), ...b.axisCommon, axisLine: { show: false }, axisLabel: { ...b.axisCommon.axisLabel, formatter: (v: number) => fmtTokens(v) } },
    series: s,
  });
  if (selected) {
    const i = x.indexOf(selected);
    if (i >= 0) chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: i });
  }
  const pick = (i: number | undefined) => {
    if (i != null && all[i]) onReq(all[i].id);
  };
  chart.getZr().on('click', (e) => {
    const idx = chart.convertFromPixel({ seriesIndex: 0 }, [e.offsetX, e.offsetY]) as number[] | undefined;
    pick(idx?.[0]);
  });
  return chart;
}

/* ---------- 3b. cost per request, stacked by component ---------- */

export function costChart(el: HTMLElement, reqs: RequestRow[], onReq: (id: string) => void) {
  const b = base();
  const chart = mount(el);
  const all = [...reqs].sort((a, b) => a.ts - b.ts);
  const surface = cssVar('--surface-1');
  chart.setOption({
    ...b,
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      ...b.tooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: cssVar('--wash') } },
      formatter: (ps: { dataIndex: number }[]) => {
        const r = all[ps[0].dataIndex];
        return (
          `<div style="font-weight:600;margin-bottom:4px">#${ps[0].dataIndex + 1} · ${fmtTime(r.ts)} · ${fmtUSD(r.cost)}</div>` +
          [...COMPONENTS].reverse().map((c) => row(series(c.slot), c.label, fmtUSD(r.costParts[c.key as keyof CostParts] ?? 0))).join('')
        );
      },
    },
    xAxis: { type: 'category', data: all.map((r) => r.id), ...b.axisCommon, splitLine: { show: false }, axisLabel: { ...b.axisCommon.axisLabel, formatter: (_: string, i: number) => String(i + 1) } },
    yAxis: { type: 'value', ...b.axisCommon, axisLine: { show: false }, axisLabel: { ...b.axisCommon.axisLabel, formatter: (v: number) => fmtUSD(v) } },
    series: COMPONENTS.map((c, i) => ({
      name: c.label,
      type: 'bar',
      stack: 'c',
      barMaxWidth: 24,
      data: all.map((r) => r.costParts[c.key as keyof CostParts] ?? 0),
      itemStyle: { color: series(c.slot), borderColor: surface, borderWidth: all.length > 150 ? 0 : 1, borderRadius: i === COMPONENTS.length - 1 ? [4, 4, 0, 0] : 0 },
    })),
  });
  chart.getZr().on('click', (e) => {
    const idx = chart.convertFromPixel({ seriesIndex: 0 }, [e.offsetX, e.offsetY]) as number[] | undefined;
    const i = idx?.[0];
    if (i != null && all[i]) onReq(all[i].id);
  });
  return chart;
}

/* ---------- 4. treemap of context items ---------- */

export function contextTreemap(el: HTMLElement, items: ContextItem[], onItem: (item: ContextItem) => void, onlyAdded = false) {
  const b = base();
  const chart = mount(el);
  const surface = cssVar('--surface-1');
  const shown = items.filter((i) => i.tokens > 0 && (!onlyAdded || i.added));
  const total = shown.reduce((a, i) => a + i.tokens, 0);
  const data = CATEGORIES.map((c) => {
    const kids = shown.filter((i) => categoryOf(i.kind).key === c.key);
    const color = categoryColor(c);
    return {
      name: c.label,
      value: kids.reduce((a, i) => a + i.tokens, 0),
      itemStyle: { color },
      children: kids
        .sort((a, b) => b.tokens - a.tokens)
        .map((i) => ({ name: i.detail ? `${i.label} · ${i.detail}` : i.label, value: i.tokens, itemId: i.id, itemStyle: { color }, label: { color: inkOn(color) } })),
    };
  }).filter((c) => c.value > 0);
  chart.setOption({
    ...b,
    tooltip: {
      ...b.tooltip,
      formatter: (p: { name: string; value: number; treePathInfo: { name: string }[] }) => {
        const cat = p.treePathInfo[1]?.name ?? '';
        return (
          `<div style="max-width:360px;white-space:normal;font-weight:600;margin-bottom:4px">${esc(p.name)}</div>` +
          `<div style="color:${cssVar('--text-secondary')}">${esc(cat)}</div>` +
          `<div><b>${fmtTokens(p.value)}</b> tokens · ${((p.value / total) * 100).toFixed(1)}%</div>`
        );
      },
    },
    series: [
      {
        type: 'treemap',
        data,
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        width: '100%',
        height: '100%',
        top: 0,
        left: 0,
        leafDepth: 2,
        label: { show: true, fontSize: 11, overflow: 'truncate', formatter: (p: { name: string; value: number }) => `${p.name}\n${fmtTokens(p.value)}` },
        upperLabel: { show: true, height: 20, fontSize: 11, color: cssVar('--text-primary'), fontWeight: 600, formatter: (p: { name: string; value: number }) => `${p.name} · ${fmtTokens(p.value)}` },
        itemStyle: { borderColor: surface, borderWidth: 1, gapWidth: 1 },
        levels: [
          { itemStyle: { borderColor: surface, borderWidth: 2, gapWidth: 2 }, upperLabel: { show: false } },
          { itemStyle: { borderColor: surface, borderWidth: 1, gapWidth: 1 }, upperLabel: { show: true } },
          { itemStyle: { borderWidth: 0 } },
        ],
      },
    ],
  });
  chart.on('click', (p) => {
    const id = (p.data as { itemId?: string } | undefined)?.itemId;
    const it = id ? items.find((i) => i.id === id) : undefined;
    if (it) onItem(it);
  });
  return chart;
}

/* ---------- 3c. context composition over time ---------- */

export function compositionChart(el: HTMLElement, points: CompositionPoint[], mode: 'tokens' | 'share', onReq: (id: string) => void) {
  const b = base();
  const chart = mount(el);
  const surface = cssVar('--surface-1');
  const catTotals = (p: CompositionPoint) =>
    CATEGORIES.map((c) => (c.kinds as readonly ItemKind[]).reduce((a, k) => a + (p.byKind[k] ?? 0), 0));
  const rows = points.map(catTotals);
  const present = CATEGORIES.map((_, ci) => rows.some((r) => r[ci] > 0));
  const value = (r: number[], ci: number, total: number) => (mode === 'share' ? (total ? (r[ci] / total) * 100 : 0) : r[ci]);
  const fmt = (v: number) => (mode === 'share' ? `${v.toFixed(v < 10 ? 1 : 0)}%` : fmtTokens(v));
  chart.setOption({
    ...b,
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      ...b.tooltip,
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: cssVar('--axis') } },
      formatter: (ps: { dataIndex: number }[]) => {
        const i = ps[0].dataIndex;
        const p = points[i];
        const r = rows[i];
        return (
          `<div style="font-weight:600;margin-bottom:4px">#${i + 1} · ${fmtTime(p.ts)} · ${fmtTokens(p.total)} in context</div>` +
          CATEGORIES.map((c, ci) => ({ c, ci }))
            .filter(({ ci }) => present[ci])
            .reverse()
            .map(({ c, ci }) => row(categoryColor(c), c.label, `${fmtTokens(r[ci])} · ${p.total ? ((r[ci] / p.total) * 100).toFixed(1) : 0}%`))
            .join('') +
          `<div style="color:${cssVar('--text-muted')};margin-top:4px">click to open this request</div>`
        );
      },
    },
    xAxis: { type: 'category', boundaryGap: false, data: points.map((p) => p.id), ...b.axisCommon, splitLine: { show: false }, axisLabel: { ...b.axisCommon.axisLabel, formatter: (_: string, i: number) => String(i + 1) } },
    yAxis: {
      type: 'value',
      max: mode === 'share' ? 100 : undefined,
      ...b.axisCommon,
      axisLine: { show: false },
      axisLabel: { ...b.axisCommon.axisLabel, formatter: (v: number) => fmt(v) },
    },
    series: CATEGORIES.map((c, ci) => ({ c, ci }))
      .filter(({ ci }) => present[ci])
      .map(({ c, ci }) => ({
        name: c.label,
        type: 'line',
        stack: 'ctx',
        symbol: 'none',
        lineStyle: { width: 1, color: surface },
        areaStyle: { color: categoryColor(c), opacity: 0.9 },
        emphasis: { disabled: true },
        data: rows.map((r, i) => value(r, ci, points[i].total)),
      })),
  });
  chart.getZr().on('click', (e) => {
    const idx = chart.convertFromPixel({ seriesIndex: 0 }, [e.offsetX, e.offsetY]) as number[] | undefined;
    const i = idx?.[0];
    if (i != null && points[i]) onReq(points[i].id);
  });
  return chart;
}

/* ---------- dashboard view: spend by product/model/… per UTC day or week ---------- */

/** Series colours for the dashboard view: products keep fixed slots; other groupings go by stable order. */
export function usageColors(view: UsageView): string[] {
  const PRODUCT_SLOT: Record<string, number> = { claude_code: 1, chat: 2, cowork: 3, chrome: 4 };
  return view.series.map((s, i) => (view.group === 'product' ? series(PRODUCT_SLOT[s.key] ?? 8) : i < 8 ? series(i + 1) : cssVar('--other')));
}

export function usageChart(el: HTMLElement, view: UsageView, onBucket: (bucket: string) => void) {
  const b = base();
  const chart = mount(el);
  const surface = cssVar('--surface-1');
  const colors = usageColors(view);
  const shown = view.series.map((s, i) => ({ s, i })).filter(({ s }) => s.total > 0);
  const top = shown.length - 1;
  const refByBucket = view.buckets.map((bk, i) => {
    if (view.interval === 'day') return view.reference.days[bk] ?? null;
    const next = view.buckets[i + 1];
    const vals = Object.entries(view.reference.days).filter(([d]) => d >= bk && (!next || d < next));
    return vals.length ? vals.reduce((a, [, v]) => a + v, 0) : null;
  });
  const hasRef = refByBucket.some((v) => v != null);
  const label = (bk: string) => {
    const d = new Date(bk + 'T00:00:00Z');
    const md = d.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return view.interval === 'week' ? `Week of ${md}` : md;
  };
  const seriesOpts: object[] = shown.map(({ s, i }, k) => ({
    name: s.label,
    type: 'bar',
    stack: 'spend',
    barMaxWidth: 24,
    data: s.values,
    itemStyle: { color: colors[i], borderColor: surface, borderWidth: 1, borderRadius: k === top ? [4, 4, 0, 0] : 0 },
  }));
  if (hasRef)
    seriesOpts.push({
      name: 'Dashboard (entered)',
      type: 'line',
      data: refByBucket,
      connectNulls: false,
      symbol: 'circle',
      symbolSize: 8,
      lineStyle: { width: 2, color: cssVar('--text-secondary') },
      itemStyle: { color: cssVar('--text-secondary'), borderColor: surface, borderWidth: 2 },
      z: 5,
    });
  chart.setOption({
    ...b,
    grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      ...b.tooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: cssVar('--wash') } },
      formatter: (ps: { dataIndex: number }[]) => {
        const i = ps[0].dataIndex;
        const tot = shown.reduce((a, { s }) => a + s.values[i], 0);
        return (
          `<div style="font-weight:600;margin-bottom:4px">${label(view.buckets[i])} (UTC) · ${fmtUSD(tot)}</div>` +
          [...shown].reverse().map(({ s, i: si }) => row(colors[si], s.label, fmtUSD(s.values[i]))).join('') +
          (refByBucket[i] != null ? row(cssVar('--text-secondary'), 'Dashboard (entered)', fmtUSD(refByBucket[i]!)) : '')
        );
      },
    },
    xAxis: { type: 'category', data: view.buckets, ...b.axisCommon, splitLine: { show: false }, axisLabel: { ...b.axisCommon.axisLabel, formatter: (v: string) => label(v).replace('Week of ', '') } },
    yAxis: { type: 'value', ...b.axisCommon, axisLine: { show: false }, axisLabel: { ...b.axisCommon.axisLabel, formatter: (v: number) => fmtUSD(v) } },
    series: seriesOpts,
  });
  chart.getZr().on('click', (e) => {
    const idx = chart.convertFromPixel({ seriesIndex: 0 }, [e.offsetX, e.offsetY]) as number[] | undefined;
    const i = idx?.[0];
    if (i != null && view.buckets[i]) onBucket(view.buckets[i]);
  });
  return chart;
}

/* ---------- cost accumulated over time ---------- */

type Part = ComponentKey | 'side';
const PARTS: { key: Part; label: string; slot: number }[] = [...COMPONENTS, SIDE_COMPONENT];

/**
 * Running total of a session's cost, stacked by what it was paid for. By request (clickable, lines up
 * with the other session charts) or by clock time (shows idle gaps and bursts).
 */
export function sessionAccumulationChart(el: HTMLElement, reqs: RequestRow[], axis: 'request' | 'time', onReq: (id: string) => void) {
  const b = base();
  const chart = mount(el);
  const all = [...reqs].sort((a, b) => a.ts - b.ts);
  const value = (r: RequestRow, k: Part) => (k === 'side' ? r.side ?? 0 : r.costParts[k] ?? 0);
  const parts = PARTS.filter((p) => all.some((r) => value(r, p.key) > 0));
  const running = parts.map(() => 0);
  const rows = all.map((r) => parts.map((p, i) => (running[i] += value(r, p.key))));
  const surface = cssVar('--surface-1');
  const byTime = axis === 'time';
  chart.setOption({
    ...b,
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      ...b.tooltip,
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: cssVar('--axis') } },
      formatter: (ps: { dataIndex: number }[]) => {
        const i = ps[0].dataIndex;
        const r = all[i];
        const tot = rows[i].reduce((a, v) => a + v, 0);
        return (
          `<div style="font-weight:600;margin-bottom:4px">#${i + 1} · ${fmtTime(r.ts)} · ${fmtUSD(tot)} so far</div>` +
          [...parts].map((p, k) => ({ p, v: rows[i][k] })).reverse().map(({ p, v }) => row(series(p.slot), p.label, fmtUSD(v))).join('') +
          `<div style="color:${cssVar('--text-muted')};margin-top:4px">this request ${fmtUSD(r.cost + (r.side ?? 0))} · click to open it</div>`
        );
      },
    },
    xAxis: byTime
      ? { type: 'time', ...b.axisCommon, splitLine: { show: false }, axisLabel: { ...b.axisCommon.axisLabel, formatter: (v: number) => fmtTime(v).replace(/:\d\d(\s|$)/, '$1') } }
      : { type: 'category', boundaryGap: false, data: all.map((r) => r.id), ...b.axisCommon, splitLine: { show: false }, axisLabel: { ...b.axisCommon.axisLabel, formatter: (_: string, i: number) => String(i + 1) } },
    yAxis: { type: 'value', ...b.axisCommon, axisLine: { show: false }, axisLabel: { ...b.axisCommon.axisLabel, formatter: (v: number) => fmtUSD(v) } },
    series: parts.map((p, k) => ({
      name: p.label,
      type: 'line',
      stack: 'cum',
      step: byTime ? 'end' : undefined,
      symbol: 'none',
      lineStyle: { width: 1, color: surface },
      areaStyle: { color: series(p.slot), opacity: 0.9 },
      emphasis: { disabled: true },
      data: byTime ? all.map((r, i) => [r.ts, rows[i][k]]) : rows.map((row) => row[k]),
    })),
  });
  chart.getZr().on('click', (e) => {
    const pt = chart.convertFromPixel({ seriesIndex: 0 }, [e.offsetX, e.offsetY]) as number[] | undefined;
    if (!pt) return;
    let i: number;
    if (byTime) {
      const t = pt[0];
      i = all.findIndex((r, j) => r.ts <= t && (j === all.length - 1 || all[j + 1].ts > t));
    } else i = pt[0];
    if (i >= 0 && all[i]) onReq(all[i].id);
  });
  return chart;
}

/**
 * Spend accumulated day by day over the selected range, stacked by component, with the monthly limit or
 * plan fee as a reference line and the current pace carried to the end of the billing period.
 */
export function rangeAccumulationChart(
  el: HTMLElement,
  days: DayRow[],
  opts: { from: string; to: string; reference?: { value: number; label: string }; projectTo?: string },
  onDay: (day: string) => void,
) {
  const b = base();
  const chart = mount(el);
  const surface = cssVar('--surface-1');
  // Every calendar day in range, so idle days are flat steps rather than skipped.
  const byDay = new Map(days.map((d) => [d.day, d]));
  const labels: string[] = [];
  for (let t = new Date(opts.from + 'T12:00:00'); ; t.setDate(t.getDate() + 1)) {
    const d = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    if (d > opts.to) break;
    labels.push(d);
  }
  const value = (d: DayRow | undefined, k: Part) => (!d ? 0 : k === 'side' ? d.costParts.side ?? 0 : d.costParts[k] ?? 0);
  const parts = PARTS.filter((p) => days.some((d) => value(d, p.key) > 0));
  const running = parts.map(() => 0);
  const rows = labels.map((d) => parts.map((p, i) => (running[i] += value(byDay.get(d), p.key))));
  const totalAt = (i: number) => rows[i]?.reduce((a, v) => a + v, 0) ?? 0;
  const endTotal = totalAt(labels.length - 1);
  // Pace: the average day so far, carried forward to the end of the period.
  let proj: (number | null)[] | undefined;
  const allLabels = [...labels];
  if (opts.projectTo && opts.projectTo > opts.to && labels.length) {
    for (let t = new Date(opts.to + 'T12:00:00'); ; ) {
      t.setDate(t.getDate() + 1);
      const d = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
      if (d > opts.projectTo) break;
      allLabels.push(d);
    }
    const perDay = endTotal / labels.length;
    proj = allLabels.map((_, i) => (i < labels.length - 1 ? null : endTotal + perDay * (i - (labels.length - 1))));
  }
  const muted = cssVar('--text-secondary');
  const seriesOpts: object[] = parts.map((p, k) => ({
    name: p.label,
    type: 'line',
    stack: 'cum',
    symbol: 'none',
    lineStyle: { width: 1, color: surface },
    areaStyle: { color: series(p.slot), opacity: 0.9 },
    emphasis: { disabled: true },
    data: allLabels.map((_, i) => (i < rows.length ? rows[i][k] : null)),
  }));
  if (proj)
    seriesOpts.push({
      name: 'On pace',
      type: 'line',
      symbol: 'none',
      lineStyle: { width: 2, color: muted, opacity: 0.7 },
      data: proj,
      z: 4,
    });
  if (opts.reference) {
    const crit = cssVar('--critical');
    // A flat series rather than a markLine: its colour and label are applied reliably on every redraw.
    seriesOpts.push({
      name: opts.reference.label,
      type: 'line',
      symbol: 'none',
      silent: true,
      z: 3,
      lineStyle: { width: 1, color: crit },
      itemStyle: { color: crit },
      data: allLabels.map(() => opts.reference!.value),
      endLabel: { show: true, formatter: `${opts.reference.label} ${fmtUSD(opts.reference.value)}`, color: cssVar('--text-secondary'), fontSize: 11, offset: [-150, -10] },
      tooltip: { show: false },
    });
  }
  const peak = Math.max(endTotal, proj ? proj[proj.length - 1] ?? 0 : 0, opts.reference?.value ?? 0);
  chart.setOption({
    ...b,
    grid: { left: 8, right: 16, top: 20, bottom: 8, containLabel: true },
    tooltip: {
      ...b.tooltip,
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: cssVar('--axis') } },
      formatter: (ps: { dataIndex: number }[]) => {
        const i = ps[0].dataIndex;
        if (i >= rows.length)
          return `<div style="font-weight:600">${fmtDay(allLabels[i])}</div>` + row(muted, 'On pace', fmtUSD(proj?.[i] ?? 0));
        const d = byDay.get(labels[i]);
        return (
          `<div style="font-weight:600;margin-bottom:4px">${fmtDay(labels[i])} · ${fmtUSD(totalAt(i))} so far</div>` +
          [...parts].map((p, k) => ({ p, v: rows[i][k] })).reverse().map(({ p, v }) => row(series(p.slot), p.label, fmtUSD(v))).join('') +
          `<div style="color:${cssVar('--text-muted')};margin-top:4px">${d ? `${fmtUSD(d.cost)} that day · click to open it` : 'no usage that day'}</div>`
        );
      },
    },
    xAxis: { type: 'category', boundaryGap: false, data: allLabels, ...b.axisCommon, splitLine: { show: false }, axisLabel: { ...b.axisCommon.axisLabel, formatter: (v: string) => fmtDay(v).replace(/^\w+, /, '') } },
    yAxis: { type: 'value', max: (v: { max: number }) => niceCeil(Math.max(v.max, peak * 1.04)), ...b.axisCommon, axisLine: { show: false }, axisLabel: { ...b.axisCommon.axisLabel, formatter: (v: number) => fmtUSD(v) } },
    series: seriesOpts,
  });
  chart.getZr().on('click', (e) => {
    const pt = chart.convertFromPixel({ seriesIndex: 0 }, [e.offsetX, e.offsetY]) as number[] | undefined;
    const i = pt?.[0];
    if (i != null && labels[i] && byDay.has(labels[i])) onDay(labels[i]);
  });
  return { chart, total: endTotal, projected: proj ? proj[proj.length - 1] ?? endTotal : undefined };
}

/* ---------- session timeline: context composition over cost per request, one shared request axis ---------- */

export interface TimelineOptions {
  mode: 'tokens' | 'share';
  /** 'typical' caps the cost axis so a few cache-rewrite spikes don't flatten every other bar. */
  costScale: 'full' | 'typical';
  /** Zoom window (percent of the thread) to restore, so live redraws keep where you were looking. */
  zoom?: { start: number; end: number };
  onZoom?: (z: { start: number; end: number }) => void;
}

/**
 * Two panels, one x axis: what filled the context on each request (top), and what that request cost
 * (bottom). Same requests, same positions, one crosshair, one zoom.
 */
export function timelineChart(el: HTMLElement, points: CompositionPoint[], reqs: RequestRow[], opts: TimelineOptions, onReq: (id: string) => void) {
  const b = base();
  const chart = mount(el);
  const surface = cssVar('--surface-1');
  const byId = new Map(reqs.map((r) => [r.id, r]));
  const ids = points.map((p) => p.id);
  const pos = new Map(ids.map((id, i) => [id, i]));
  const rows = points.map((p) => CATEGORIES.map((c) => (c.kinds as readonly ItemKind[]).reduce((a, k) => a + (p.byKind[k] ?? 0), 0)));
  const present = CATEGORIES.map((_, ci) => rows.some((r) => r[ci] > 0));
  const ctxVal = (i: number, ci: number) => (opts.mode === 'share' ? (points[i].total ? (rows[i][ci] / points[i].total) * 100 : 0) : rows[i][ci]);
  const partVal = (r: RequestRow | undefined, k: Part) => (!r ? 0 : k === 'side' ? r.side ?? 0 : r.costParts[k] ?? 0);
  const parts = PARTS.filter((p) => ids.some((id) => partVal(byId.get(id), p.key) > 0));
  const totals = ids.map((id) => {
    const r = byId.get(id);
    return r ? r.cost + (r.side ?? 0) : 0;
  });
  // Typical scale: 1.5× the 95th percentile, so the everyday bars are readable; spikes are clipped, and listed.
  const sorted = [...totals].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const cap = opts.costScale === 'typical' && sorted.length > 20 ? niceCeil(p95 * 1.5) : undefined;
  const clipped = cap ? totals.map((t, i) => ({ t, i })).filter((x) => x.t > cap) : [];
  const limit = Math.max(...points.map((p) => p.contextLimit), 0);
  const peak = Math.max(...points.map((p) => p.total), 0);
  const dense = ids.length > 150;
  const fmtCtx = (v: number) => (opts.mode === 'share' ? `${v.toFixed(0)}%` : fmtTokens(v));

  const ctxSeries = CATEGORIES.map((c, ci) => ({ c, ci }))
    .filter(({ ci }) => present[ci])
    .map(({ c, ci }, k) => ({
      name: c.label,
      type: 'line',
      stack: 'ctx',
      xAxisIndex: 0,
      yAxisIndex: 0,
      symbol: 'none',
      lineStyle: { width: 1, color: surface },
      areaStyle: { color: categoryColor(c), opacity: 0.9 },
      emphasis: { disabled: true },
      data: ids.map((_, i) => ctxVal(i, ci)),
      markLine:
        k === 0 && opts.mode === 'tokens' && limit && peak > limit * 0.25
          ? { silent: true, symbol: 'none', lineStyle: { color: cssVar('--critical'), width: 1, type: 'solid' }, label: { formatter: `Context limit ${fmtTokens(limit)}`, color: cssVar('--text-secondary'), position: 'insideEndTop' }, data: [{ yAxis: limit }] }
          : undefined,
    }));
  const costSeries = parts.map((p, k) => ({
    name: p.label,
    type: 'bar',
    stack: 'cost',
    xAxisIndex: 1,
    yAxisIndex: 1,
    barMaxWidth: 24,
    barCategoryGap: dense ? '10%' : '30%',
    data: ids.map((id) => partVal(byId.get(id), p.key)),
    itemStyle: { color: series(p.slot), borderColor: surface, borderWidth: dense ? 0 : 1, borderRadius: k === parts.length - 1 ? [3, 3, 0, 0] : 0 },
  }));

  const axisX = (i: number) => ({
    type: 'category',
    gridIndex: i,
    data: ids,
    boundaryGap: true,
    ...b.axisCommon,
    splitLine: { show: false },
    // Label by the request's real position (the formatter's own index restarts inside a zoomed window).
    axisLabel: i === 0 ? { show: false } : { ...b.axisCommon.axisLabel, formatter: (id: string) => String((pos.get(id) ?? 0) + 1) },
    axisTick: { show: false },
  });
  chart.setOption({
    ...b,
    axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: cssVar('--axis') } },
    grid: [
      { left: 8, right: 16, top: 12, height: '52%', containLabel: true },
      { left: 8, right: 16, top: '63%', bottom: 44, containLabel: true },
    ],
    xAxis: [axisX(0), axisX(1)],
    yAxis: [
      { type: 'value', gridIndex: 0, max: opts.mode === 'share' ? 100 : (v: { max: number }) => niceCeil(v.max * 1.04), ...b.axisCommon, axisLine: { show: false }, axisLabel: { ...b.axisCommon.axisLabel, formatter: fmtCtx } },
      { type: 'value', gridIndex: 1, max: cap, ...b.axisCommon, axisLine: { show: false }, axisLabel: { ...b.axisCommon.axisLabel, formatter: (v: number) => fmtUSD(v) } },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], start: opts.zoom?.start ?? 0, end: opts.zoom?.end ?? 100, zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: false },
      {
        type: 'slider',
        xAxisIndex: [0, 1],
        bottom: 6,
        height: 18,
        start: opts.zoom?.start ?? 0,
        end: opts.zoom?.end ?? 100,
        borderColor: cssVar('--border'),
        fillerColor: cssVar('--wash'),
        backgroundColor: 'transparent',
        dataBackground: { lineStyle: { color: cssVar('--axis') }, areaStyle: { color: cssVar('--surface-2') } },
        textStyle: { color: cssVar('--text-muted'), fontSize: 11 },
        labelFormatter: (v: number) => `#${Math.round(v) + 1}`,
      },
    ],
    tooltip: {
      ...b.tooltip,
      trigger: 'axis',
      axisPointer: { type: 'line' },
      formatter: (ps: { dataIndex: number }[]) => {
        const i = ps[0].dataIndex;
        const p = points[i];
        const r = byId.get(ids[i]);
        const ctxRows = CATEGORIES.map((c, ci) => ({ c, ci }))
          .filter(({ ci }) => present[ci] && rows[i][ci] > 0)
          .reverse()
          .map(({ c, ci }) => row(categoryColor(c), c.label, `${fmtTokens(rows[i][ci])} · ${p.total ? ((rows[i][ci] / p.total) * 100).toFixed(0) : 0}%`))
          .join('');
        const costRows = [...parts].reverse().map((pt) => row(series(pt.slot), pt.label, fmtUSD(partVal(r, pt.key)))).join('');
        return (
          `<div style="font-weight:600;margin-bottom:4px">#${i + 1} · ${fmtTime(p.ts)}${r ? ` · ${esc(r.model)}` : ''}</div>` +
          `<div style="color:${cssVar('--text-muted')};margin:2px 0">In context: <b style="color:${cssVar('--text-primary')}">${fmtTokens(p.total)}</b></div>` +
          ctxRows +
          `<div style="color:${cssVar('--text-muted')};margin:6px 0 2px">Cost: <b style="color:${cssVar('--text-primary')}">${fmtUSD(totals[i])}</b>${cap && totals[i] > cap ? ' (clipped on the chart)' : ''}</div>` +
          costRows +
          `<div style="color:${cssVar('--text-muted')};margin-top:4px">${esc(r?.tools.join(', ') || 'no tool calls')} · click to open</div>`
        );
      },
    },
    series: [...ctxSeries, ...costSeries],
  });
  chart.on('datazoom', () => {
    const dz = (chart.getOption() as { dataZoom?: { start: number; end: number }[] }).dataZoom?.[0];
    if (dz && opts.onZoom) opts.onZoom({ start: dz.start, end: dz.end });
  });
  chart.getZr().on('click', (e) => {
    // Only clicks inside the two plot areas open a request (not the zoom slider).
    const px = [e.offsetX, e.offsetY];
    const inTop = chart.containPixel({ gridIndex: 0 }, px);
    const inBottom = chart.containPixel({ gridIndex: 1 }, px);
    if (!inTop && !inBottom) return;
    const pt = chart.convertFromPixel({ gridIndex: inBottom ? 1 : 0 }, px) as number[] | undefined;
    const i = pt ? Math.round(pt[0]) : undefined;
    if (i != null && ids[i]) onReq(ids[i]);
  });
  return { chart, clipped: clipped.map((x) => ({ n: x.i + 1, cost: x.t })), cap };
}
