import { BarChart, LineChart, TreemapChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import type { ContextItem, CostParts, DayRow, ItemKind, RequestRow } from './api';
import { fmtDay, fmtTime, fmtTokens, fmtUSD } from './format';

echarts.use([BarChart, LineChart, TreemapChart, GridComponent, TooltipComponent, MarkLineComponent, DataZoomComponent, CanvasRenderer]);

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

function base() {
  const text2 = cssVar('--text-secondary');
  const muted = cssVar('--text-muted');
  return {
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
  const valueOf = (d: DayRow, k: ComponentKey) => (mode === 'cost' ? d.costParts[k] : d[k]);
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
          [...COMPONENTS].reverse().map((c) => row(series(c.slot), c.label, fmt(valueOf(d, c.key)))).join('') +
          `<div style="color:${cssVar('--text-muted')};margin-top:4px">${d.sessions} sessions · ${d.requests} requests · click to open</div>`
        );
      },
    },
    xAxis: { type: 'category', data: days.map((d) => d.day), ...b.axisCommon, splitLine: { show: false }, axisLabel: { ...b.axisCommon.axisLabel, formatter: (v: string) => fmtDay(v).replace(/^\w+, /, '') } },
    yAxis: { type: 'value', ...b.axisCommon, axisLine: { show: false }, axisLabel: { ...b.axisCommon.axisLabel, formatter: (v: number) => fmt(v) } },
    series: COMPONENTS.map((c, i) => ({
      name: c.label,
      type: 'bar',
      stack: 'x',
      barMaxWidth: 24,
      data: days.map((d) => valueOf(d, c.key)),
      itemStyle: {
        color: series(c.slot),
        borderColor: surface,
        borderWidth: 1,
        borderRadius: i === COMPONENTS.length - 1 ? [4, 4, 0, 0] : 0,
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
    yAxis: { type: 'value', max: (v: { max: number }) => Math.max(v.max, peak * 1.1), ...b.axisCommon, axisLine: { show: false }, axisLabel: { ...b.axisCommon.axisLabel, formatter: (v: number) => fmtTokens(v) } },
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
          [...COMPONENTS].reverse().map((c) => row(series(c.slot), c.label, fmtUSD(r.costParts[c.key as keyof CostParts]))).join('')
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
      data: all.map((r) => r.costParts[c.key as keyof CostParts]),
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
