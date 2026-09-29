import './style.css';
import { api, saveFile, type ContextItem, type RequestDetail, type RequestRow, type SessionDetail, type SessionRow, type Summary } from './api';
import { CATEGORIES, categoryColor, categoryOf, COMPONENTS, contextChart, contextTreemap, costChart, cssVar, dailyChart, disposeAll } from './charts';
import { daysAgo, fmtDateTime, fmtDay, fmtDuration, fmtInt, fmtPct, fmtTime, fmtTokens, fmtUSD } from './format';

/* ---------- tiny DOM helper: text always goes in as textContent ---------- */

type Child = Node | string | number | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

/* ---------- state ---------- */

type RangeKey = '7d' | '30d' | '90d' | 'all';
const RANGES: { key: RangeKey; label: string; days?: number }[] = [
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
  { key: 'all', label: 'All' },
];

const store = {
  get(k: string, d: string) {
    try {
      return localStorage.getItem('session-lens:' + k) ?? d;
    } catch {
      return d;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem('session-lens:' + k, v);
    } catch {
      /* private mode */
    }
  },
};

const state = {
  range: store.get('range', '30d') as RangeKey,
  project: store.get('project', ''),
  dailyMode: store.get('dailyMode', 'cost') as 'tokens' | 'cost',
  projects: [] as string[],
};

function rangeParams(): { from?: string; to?: string; project?: string } {
  const r = RANGES.find((x) => x.key === state.range);
  return { from: r?.days ? daysAgo(r.days - 1) : undefined, project: state.project || undefined };
}

/* ---------- routing ---------- */

interface Route {
  view: 'overview' | 'day' | 'session' | 'request';
  id?: string;
  params: URLSearchParams;
}

function parseRoute(): Route {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const [view, ...rest] = path.split('/');
  const id = rest.length ? decodeURIComponent(rest.join('/')) : undefined;
  const params = new URLSearchParams(query);
  if (view === 'day' && id) return { view: 'day', id, params };
  if (view === 'session' && id) return { view: 'session', id, params };
  if (view === 'request' && id) return { view: 'request', id, params };
  return { view: 'overview', params };
}

export function go(hash: string) {
  location.hash = hash;
}

/* ---------- shell ---------- */

const app = document.getElementById('app')!;
let main: HTMLElement;
let crumbs: HTMLElement;
let renderToken = 0;

/** Inside VS Code the editor theme decides, via the class it puts on <body>. */
function hostTheme(): string {
  const c = document.body.classList;
  if (c.contains('vscode-light') || c.contains('vscode-high-contrast-light')) return 'light';
  if (c.contains('vscode-dark') || c.contains('vscode-high-contrast')) return 'dark';
  return '';
}

function applyTheme() {
  const t = store.get('theme', '') || hostTheme();
  if (t) document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
}

new MutationObserver(() => {
  if (!store.get('theme', '')) {
    applyTheme();
    render();
  }
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

function shell() {
  applyTheme();
  const rangeSeg = h(
    'div',
    { class: 'seg', role: 'group', 'aria-label': 'Date range' },
    ...RANGES.map((r) =>
      h(
        'button',
        {
          'aria-pressed': String(state.range === r.key),
          onclick: () => {
            state.range = r.key;
            store.set('range', r.key);
            shell();
            render();
          },
        },
        r.label,
      ),
    ),
  );
  const projectSel = h(
    'select',
    {
      'aria-label': 'Project',
      onchange: (e: Event) => {
        state.project = (e.target as HTMLSelectElement).value;
        store.set('project', state.project);
        render();
      },
    },
    h('option', { value: '' }, 'All projects'),
    ...state.projects.map((p) => h('option', { value: p, selected: p === state.project ? 'selected' : null }, p)),
  );
  const themeBtn = h(
    'button',
    {
      class: 'btn',
      title: 'Toggle light / dark',
      onclick: () => {
        const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        store.set('theme', cur === 'dark' ? 'light' : 'dark');
        applyTheme();
        render();
      },
    },
    'Theme',
  );
  const refreshBtn = h('button', { class: 'btn', onclick: () => render() }, 'Refresh');
  crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' });
  main = h('main');
  app.replaceChildren(
    h(
      'div',
      { class: 'app' },
      h(
        'header',
        { class: 'top' },
        h('h1', {}, lensIcon(), 'Session Lens'),
        h('div', { class: 'filters' }, rangeSeg, projectSel),
        h('div', { class: 'spacer' }),
        refreshBtn,
        themeBtn,
      ),
      crumbs,
      main,
    ),
  );
}

function lensIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.innerHTML = `<circle cx="7" cy="7" r="5" fill="none" stroke="${cssVar('--accent')}" stroke-width="2"/><path d="M11 11l4 4" stroke="${cssVar('--accent')}" stroke-width="2" stroke-linecap="round"/>`;
  return svg;
}

function setCrumbs(parts: { label: string; href?: string }[]) {
  crumbs.replaceChildren();
  parts.forEach((p, i) => {
    if (i) crumbs.append(h('span', { class: 'sep' }, '›'));
    crumbs.append(p.href ? h('a', { href: p.href }, p.label) : h('span', { class: 'here', title: p.label }, p.label));
  });
}

function tile(label: string, value: string, sub?: string, hero = false) {
  return h('div', { class: 'tile' + (hero ? ' hero' : '') }, h('div', { class: 'label' }, label), h('div', { class: 'value', title: value }, value), sub ? h('div', { class: 'sub' }, sub) : null);
}

function card(title: string, sub: string | null, actions: Node[], ...body: Child[]) {
  return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, title), sub ? h('div', { class: 'sub' }, sub) : null), ...actions), ...body);
}

function legend(items: { label: string; color: string }[]) {
  return h('div', { class: 'legend' }, ...items.map((i) => h('span', {}, h('i', { style: { background: i.color } }), i.label)));
}

function seg<T extends string>(options: { key: T; label: string }[], current: T, onPick: (k: T) => void) {
  return h(
    'div',
    { class: 'seg' },
    ...options.map((o) => h('button', { 'aria-pressed': String(o.key === current), onclick: () => onPick(o.key) }, o.label)),
  );
}

function exportButtons(name: string, rows: () => Record<string, unknown>[]) {
  const csv = () => {
    const data = rows();
    const cols = [...new Set(data.flatMap((r) => Object.keys(r)))];
    const cell = (v: unknown) => {
      const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    saveFile(`${name}.csv`, [cols.join(','), ...data.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n'), 'text/csv');
  };
  const json = () => saveFile(`${name}.json`, JSON.stringify(rows(), null, 2), 'application/json');
  return [h('button', { class: 'btn', onclick: csv }, 'CSV'), h('button', { class: 'btn', onclick: json }, 'JSON')];
}

function spark(values: number[], w = 90, hgt = 22) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(hgt));
  svg.setAttribute('class', 'spark');
  svg.setAttribute('aria-hidden', 'true');
  if (values.length < 2) return svg;
  const max = Math.max(...values) || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * (w - 4) + 2).toFixed(1)},${(hgt - 2 - (v / max) * (hgt - 4)).toFixed(1)}`);
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', pts.join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', cssVar('--series-1'));
  line.setAttribute('stroke-width', '1.5');
  line.setAttribute('stroke-linejoin', 'round');
  svg.append(line);
  return svg;
}

function meter(pct: number) {
  const cls = pct >= 0.9 ? 'meter crit' : pct >= 0.7 ? 'meter warn' : 'meter';
  return h('span', {}, h('span', { class: cls }, h('div', { style: { width: `${Math.min(pct, 1) * 100}%` } })), fmtPct(pct));
}

function barCell(value: number, max: number, text: string, color = cssVar('--series-1')) {
  return h('div', { class: 'bar-cell' }, h('span', {}, text), h('span', { class: 'track' }, h('span', { class: 'fill', style: { width: `${max ? (value / max) * 100 : 0}%`, background: color, display: 'block' } })));
}

/* ---------- sortable table ---------- */

interface Col<T> {
  key: string;
  label: string;
  num?: boolean;
  sort?: (r: T) => number | string;
  cell: (r: T) => Child;
  cls?: string;
}

function table<T>(rows: T[], cols: Col<T>[], opts: { onRow?: (r: T) => void; initial?: string; desc?: boolean; selected?: (r: T) => boolean; limit?: number } = {}) {
  let sortKey = opts.initial;
  let desc = opts.desc ?? true;
  let limit = opts.limit ?? Infinity;
  const wrap = h('div', { class: 'table-wrap' });
  const draw = () => {
    const col = cols.find((c) => c.key === sortKey);
    const sorted = col?.sort
      ? [...rows].sort((a, b) => {
          const x = col.sort!(a);
          const y = col.sort!(b);
          const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
          return desc ? -d : d;
        })
      : rows;
    const head = h(
      'tr',
      {},
      ...cols.map((c) =>
        h(
          'th',
          {
            class: [c.num ? 'num' : '', c.sort ? 'sortable' : ''].join(' '),
            'aria-sort': sortKey === c.key ? (desc ? 'descending' : 'ascending') : null,
            onclick: c.sort
              ? () => {
                  if (sortKey === c.key) desc = !desc;
                  else {
                    sortKey = c.key;
                    desc = true;
                  }
                  draw();
                }
              : null,
          },
          c.label + (sortKey === c.key ? (desc ? ' ↓' : ' ↑') : ''),
        ),
      ),
    );
    const body = sorted.slice(0, limit).map((r) =>
      h(
        'tr',
        {
          class: [opts.onRow ? 'clickable' : '', opts.selected?.(r) ? 'selected' : ''].join(' '),
          onclick: opts.onRow ? () => opts.onRow!(r) : null,
          tabindex: opts.onRow ? '0' : null,
          onkeydown: opts.onRow ? (e: KeyboardEvent) => e.key === 'Enter' && opts.onRow!(r) : null,
        },
        ...cols.map((c) => h('td', { class: [c.num ? 'num' : '', c.cls ?? ''].join(' ') }, c.cell(r))),
      ),
    );
    const more =
      sorted.length > limit
        ? h(
            'div',
            { style: { padding: '8px 0' } },
            h(
              'button',
              {
                class: 'btn',
                onclick: () => {
                  limit = Infinity;
                  draw();
                },
              },
              `Show all ${sorted.length}`,
            ),
          )
        : null;
    wrap.replaceChildren(h('table', {}, h('thead', {}, head), h('tbody', {}, ...body)), ...(more ? [more] : []));
  };
  draw();
  return wrap;
}

/* ---------- level 1: overview ---------- */

async function overview(token: number) {
  const params = rangeParams();
  const [sum, sess] = await Promise.all([api<Summary>('summary', params), api<{ sessions: SessionRow[] }>('sessions', params)]);
  if (token !== renderToken) return;
  if (JSON.stringify(sum.projects) !== JSON.stringify(state.projects)) {
    state.projects = sum.projects;
    shell();
  }
  setCrumbs([{ label: 'Overview' }]);
  const t = sum.totals;
  const inTokens = t.input + t.cacheRead + t.cacheWrite;
  const kids: Child[] = [];
  if (sum.unknownModels.length)
    kids.push(h('div', { class: 'note' }, `No price on file for ${sum.unknownModels.join(', ')}; costed at the fallback rate. Add them to ~/.session-lens/settings.json.`));
  kids.push(
    h(
      'div',
      { class: 'tiles' },
      tile('Estimated cost', fmtUSD(t.cost), sum.discount ? `after ${fmtPct(sum.discount)} discount` : 'at API list prices', true),
      tile('Sessions', fmtInt(t.sessions), `${fmtInt(t.requests)} requests`),
      tile('Input tokens', fmtTokens(inTokens), `${fmtPct(inTokens ? t.cacheRead / inTokens : 0)} served from cache`),
      tile('Output tokens', fmtTokens(t.output)),
      tile('Days active', String(sum.days.length), sum.range.first ? `data from ${fmtDay(sum.range.first)}` : 'no data'),
    ),
  );
  if (!sum.days.length) {
    kids.push(h('div', { class: 'empty' }, 'No Claude Code requests in this range. Try "All".'));
    main.replaceChildren(...kids.map((k) => (k instanceof Node ? k : document.createTextNode(String(k)))));
    return;
  }
  const chartEl = h('div', { class: 'chart' });
  let showTable = false;
  const tableHolder = h('div');
  const daysTable = () =>
    table(
      sum.days,
      [
        { key: 'day', label: 'Day', sort: (d) => d.day, cell: (d) => fmtDay(d.day) },
        { key: 'sessions', label: 'Sessions', num: true, sort: (d) => d.sessions, cell: (d) => d.sessions },
        { key: 'requests', label: 'Requests', num: true, sort: (d) => d.requests, cell: (d) => d.requests },
        ...COMPONENTS.map((c) => ({ key: c.key, label: c.label, num: true, sort: (d: Summary['days'][number]) => d[c.key], cell: (d: Summary['days'][number]) => fmtTokens(d[c.key]) })),
        { key: 'cost', label: 'Cost', num: true, sort: (d) => d.cost, cell: (d) => fmtUSD(d.cost) },
      ],
      { onRow: (d) => go(`#/day/${d.day}`), initial: 'day' },
    );
  const modeSeg = seg(
    [
      { key: 'cost', label: 'Cost' },
      { key: 'tokens', label: 'Tokens' },
    ],
    state.dailyMode,
    (k) => {
      state.dailyMode = k;
      store.set('dailyMode', k);
      render();
    },
  );
  const tableBtn = h(
    'button',
    {
      class: 'btn',
      onclick: () => {
        showTable = !showTable;
        tableHolder.replaceChildren(...(showTable ? [daysTable()] : []));
      },
    },
    'Table',
  );
  kids.push(
    card(
      state.dailyMode === 'cost' ? 'Cost by day' : 'Tokens by day',
      'Click a day to see its sessions',
      [modeSeg, tableBtn, ...exportButtons('usage-by-day', () => sum.days.map(({ costByModel, costParts, ...d }) => ({ ...d, ...Object.fromEntries(Object.entries(costParts).map(([k, v]) => [`cost_${k}`, v])) })))],
      legend(COMPONENTS.map((c) => ({ label: c.label, color: cssVar(`--series-${c.slot}`) }))),
      chartEl,
      tableHolder,
    ),
  );
  kids.push(sessionsCard(sess.sessions, 'Sessions in range', undefined));
  main.replaceChildren(...(kids.filter(Boolean) as Node[]));
  dailyChart(chartEl, sum.days, state.dailyMode, (day) => go(`#/day/${day}`));
}

/* ---------- level 2: sessions (for a day or the range) ---------- */

function sessionsCard(rows: SessionRow[], title: string, day: string | undefined) {
  const maxCost = Math.max(...rows.map((r) => r.cost), 0);
  const q = day ? `?day=${day}` : '';
  return card(
    title,
    rows.length ? `${rows.length} sessions · click one to open it` : 'No sessions',
    exportButtons(day ? `sessions-${day}` : 'sessions', () => rows.map(({ spark: _s, ...r }) => ({ ...r, firstTs: new Date(r.firstTs).toISOString(), lastTs: new Date(r.lastTs).toISOString() }))),
    table(
      rows,
      [
        {
          key: 'title',
          label: 'Session',
          sort: (r) => r.title,
          cls: 'title',
          cell: (r) => h('div', {}, h('span', { class: 't', title: r.title }, r.title), h('span', { class: 'muted' }, `${r.project} · ${fmtDateTime(r.firstTs)} · ${fmtDuration(r.lastTs - r.firstTs)}`)),
        },
        { key: 'models', label: 'Model', cell: (r) => h('span', { class: 'muted' }, r.models.join(', ')) },
        { key: 'requests', label: 'Requests', num: true, sort: (r) => r.requests, cell: (r) => (r.subagents ? `${r.requests} · ${r.subagents} sub` : r.requests) },
        { key: 'spark', label: 'Context over time', cell: (r) => spark(r.spark) },
        { key: 'peak', label: 'Peak context', num: true, sort: (r) => r.peakContextPct, cell: (r) => h('span', { title: `${fmtInt(r.peakContext)} tokens` }, meter(r.peakContextPct)) },
        { key: 'tokens', label: 'Tokens in / out', num: true, sort: (r) => r.input + r.cacheRead + r.cacheWrite, cell: (r) => `${fmtTokens(r.input + r.cacheRead + r.cacheWrite)} / ${fmtTokens(r.output)}` },
        { key: 'start', label: 'Started', num: true, sort: (r) => r.firstTs, cell: (r) => fmtTime(r.firstTs) },
        { key: 'cost', label: 'Cost', num: true, sort: (r) => r.cost, cell: (r) => barCell(r.cost, maxCost, fmtUSD(r.cost)) },
      ],
      { onRow: (r) => go(`#/session/${encodeURIComponent(r.id)}${q}`), initial: 'cost', limit: 50 },
    ),
  );
}

async function dayView(token: number, day: string) {
  const params = { from: day, to: day, project: state.project || undefined };
  const [sum, sess] = await Promise.all([api<Summary>('summary', params), api<{ sessions: SessionRow[] }>('sessions', params)]);
  if (token !== renderToken) return;
  setCrumbs([{ label: 'Overview', href: '#/' }, { label: fmtDay(day) }]);
  const t = sum.totals;
  const inTokens = t.input + t.cacheRead + t.cacheWrite;
  main.replaceChildren(
    h(
      'div',
      { class: 'tiles' },
      tile('Cost', fmtUSD(t.cost), fmtDay(day), true),
      tile('Sessions', fmtInt(t.sessions), `${fmtInt(t.requests)} requests`),
      tile('Input tokens', fmtTokens(inTokens), `${fmtPct(inTokens ? t.cacheRead / inTokens : 0)} from cache`),
      tile('Output tokens', fmtTokens(t.output)),
    ),
    sessionsCard(sess.sessions, `Sessions on ${fmtDay(day)}`, day),
  );
}

/* ---------- level 3: one session ---------- */

async function sessionView(token: number, id: string, day?: string) {
  const d = await api<SessionDetail>('session', { id });
  if (token !== renderToken) return;
  const s = d.session;
  const reqs = d.requests;
  const dayQ = day ? `&day=${day}` : '';
  setCrumbs([{ label: 'Overview', href: '#/' }, ...(day ? [{ label: fmtDay(day), href: `#/day/${day}` }] : []), { label: s.title }]);
  const open = (rid: string) => go(`#/request/${encodeURIComponent(rid)}?session=${encodeURIComponent(s.id)}${dayQ}`);
  const peak = reqs.reduce((a, r) => (r.contextTokens / r.contextLimit > a.contextTokens / a.contextLimit ? r : a), reqs[0]);
  const u = reqs.reduce(
    (a, r) => ({ read: a.read + r.usage.cacheRead, write: a.write + r.usage.cacheWrite5m + r.usage.cacheWrite1h, input: a.input + r.usage.input, out: a.out + r.usage.output }),
    { read: 0, write: 0, input: 0, out: 0 },
  );
  const ctxEl = h('div', { class: 'chart' });
  const costEl = h('div', { class: 'chart' });
  const byId = new Map(reqs.map((r, i) => [r.id, { r, n: i + 1 }]));
  const reqCols: Col<RequestRow>[] = [
    { key: 'n', label: '#', num: true, cell: (r) => byId.get(r.id)!.n },
    { key: 'time', label: 'Time', cell: (r) => fmtTime(r.ts) },
    { key: 'who', label: 'Thread', cell: (r) => (r.agentId ? h('span', { class: 'pill' }, 'subagent') : h('span', { class: 'muted' }, 'main')) },
    { key: 'model', label: 'Model', cell: (r) => h('span', { class: 'muted' }, r.model) },
    { key: 'tools', label: 'Tool calls', cell: (r) => h('span', { class: 'muted' }, r.tools.join(', ') || '—') },
    { key: 'ctx', label: 'In context', num: true, cell: (r) => fmtTokens(r.contextTokens) },
    { key: 'write', label: 'Cache write', num: true, cell: (r) => fmtTokens(r.usage.cacheWrite5m + r.usage.cacheWrite1h) },
    { key: 'out', label: 'Output', num: true, cell: (r) => fmtTokens(r.usage.output) },
    { key: 'cost', label: 'Cost', num: true, cell: (r) => fmtUSD(r.cost) },
  ];
  const turns = d.turns.map((t, i) =>
    h(
      'details',
      { class: 'turn', open: d.turns.length <= 3 ? '' : null },
      h(
        'summary',
        {},
        h('span', { class: 'muted' }, String(i + 1)),
        h('span', { class: 't', title: t.text }, t.text),
        h('span', { class: 'muted' }, `${t.requestIds.length} req`),
        h('b', {}, fmtUSD(t.cost)),
      ),
      table(t.requestIds.map((rid) => byId.get(rid)!.r), reqCols, { onRow: (r) => open(r.id) }),
    ),
  );
  const kids: Node[] = [
    h(
      'div',
      { class: 'tiles' },
      tile('Session cost', fmtUSD(s.cost), s.reportedCostUSD != null ? `Claude Code last logged ${fmtUSD(s.reportedCostUSD)}` : s.project, true),
      tile('Requests', fmtInt(reqs.length), `${d.turns.length} prompts · ${d.subagents.length} subagents`),
      tile('Duration', fmtDuration(s.lastTs - s.firstTs), fmtDateTime(s.firstTs)),
      tile('Peak context', peak ? fmtTokens(peak.contextTokens) : '—', peak ? `${fmtPct(peak.contextTokens / peak.contextLimit)} of ${fmtTokens(peak.contextLimit)}` : ''),
      tile('Cache read / write', `${fmtTokens(u.read)} / ${fmtTokens(u.write)}`, `${fmtTokens(u.out)} output`),
    ),
    h(
      'div',
      { class: 'grid2' },
      card('Context size per request', 'Tokens the model saw on each call. Click a point to break it down.', [], legend([{ label: 'Main thread', color: cssVar('--series-1') }, ...(d.subagents.length ? [{ label: 'Subagents', color: cssVar('--series-2') }] : [])]), ctxEl),
      card('Cost per request', 'Stacked by what you paid for. Click a bar to break it down.', [], legend(COMPONENTS.map((c) => ({ label: c.label, color: cssVar(`--series-${c.slot}`) }))), costEl),
    ),
    card(
      'Prompts',
      'Each prompt with the requests that answered it (subagent work is grouped under the prompt that launched it)',
      exportButtons(`session-${s.id.slice(0, 8)}-requests`, () =>
        reqs.map((r, i) => ({ n: i + 1, id: r.id, time: new Date(r.ts).toISOString(), thread: r.agentId ?? 'main', model: r.model, tools: r.tools.join(' '), contextTokens: r.contextTokens, ...r.usage, cost: r.cost })),
      ),
      ...turns,
    ),
  ];
  if (d.subagents.length)
    kids.push(
      card(
        'Subagents',
        null,
        [],
        table(d.subagents, [
          { key: 'type', label: 'Type', cell: (a) => a.agentType ?? 'agent' },
          { key: 'desc', label: 'Task', cell: (a) => a.description ?? a.agentId },
          { key: 'model', label: 'Model', cell: (a) => h('span', { class: 'muted' }, a.model ?? '') },
          { key: 'req', label: 'Requests', num: true, cell: (a) => a.requests },
          { key: 'cost', label: 'Cost', num: true, cell: (a) => fmtUSD(a.cost) },
        ], {
          onRow: (a) => {
            const first = reqs.find((r) => r.agentId === a.agentId);
            if (first) open(first.id);
          },
        }),
      ),
    );
  main.replaceChildren(...kids);
  contextChart(ctxEl, reqs, open);
  costChart(costEl, reqs, open);
}

/* ---------- level 4: one request's context ---------- */

async function requestView(token: number, id: string, params: URLSearchParams) {
  const d = await api<RequestDetail>('request', { id });
  if (token !== renderToken) return;
  const r = d.request;
  const a = d.attribution;
  const day = params.get('day') ?? undefined;
  const sid = d.session?.id ?? params.get('session') ?? '';
  const dayQ = day ? `?day=${day}` : '';
  const reqHref = (rid: string) => `#/request/${encodeURIComponent(rid)}?session=${encodeURIComponent(sid)}${day ? `&day=${day}` : ''}`;
  setCrumbs([
    { label: 'Overview', href: '#/' },
    ...(day ? [{ label: fmtDay(day), href: `#/day/${day}` }] : []),
    { label: d.session?.title ?? 'Session', href: `#/session/${encodeURIComponent(sid)}${dayQ}` },
    { label: `${r.agentId ? 'Subagent request' : 'Request'} ${d.thread.index + 1} of ${d.thread.count}` },
  ]);

  let filter: 'all' | 'added' = 'all';
  let category = '';
  const total = a.measuredInput;
  const byCat = CATEGORIES.map((c) => ({ c, tokens: a.items.filter((i) => categoryOf(i.kind).key === c.key).reduce((s, i) => s + i.tokens, 0) })).filter((x) => x.tokens > 0);

  // 100% composition bar (HTML): every category, labelled in the legend beneath it.
  const compBar = h(
    'div',
    { style: { display: 'flex', height: '14px', borderRadius: '4px', overflow: 'hidden', gap: '2px', margin: '6px 0 4px' }, role: 'img', 'aria-label': 'Context composition' },
    ...byCat.map((x) => h('div', { title: `${x.c.label}: ${fmtTokens(x.tokens)}`, style: { flex: `${x.tokens} 0 0`, background: categoryColor(x.c), minWidth: '2px' } })),
  );
  const compLegend = h(
    'div',
    { class: 'legend' },
    ...byCat.map((x) => h('span', {}, h('i', { style: { background: categoryColor(x.c) } }), `${x.c.label} ${fmtTokens(x.tokens)} (${fmtPct(x.tokens / total)})`)),
  );

  const treeEl = h('div', { class: 'chart tall' });
  const itemsHolder = h('div');
  const maxTok = Math.max(...a.items.map((i) => i.tokens), 0);
  const drawItems = () => {
    const rows = a.items.filter((i) => (filter === 'all' || i.added) && (!category || categoryOf(i.kind).key === category));
    itemsHolder.replaceChildren(
      table(
        rows,
        [
          { key: 'rank', label: 'Position', num: true, sort: (i) => a.items.indexOf(i), cell: (i) => a.items.indexOf(i) },
          {
            key: 'kind',
            label: 'Kind',
            sort: (i) => categoryOf(i.kind).label,
            cell: (i) => h('span', {}, h('span', { class: 'key', style: { background: categoryColor(categoryOf(i.kind)) } }), categoryOf(i.kind).label),
          },
          { key: 'label', label: 'Item', sort: (i) => i.label, cls: 'title', cell: (i) => h('div', {}, h('span', { class: 't', title: i.label }, i.label), i.detail ? h('span', { class: 'muted t', title: i.detail }, i.detail) : null) },
          { key: 'added', label: '', cell: (i) => (i.added && d.thread.index > 0 ? h('span', { class: 'pill new' }, 'new') : null) },
          { key: 'time', label: 'Added at', num: true, sort: (i) => i.ts, cell: (i) => (i.uuid ? fmtTime(i.ts) : '') },
          { key: 'share', label: 'Share', num: true, sort: (i) => i.tokens, cell: (i) => fmtPct(total ? i.tokens / total : 0) },
          { key: 'tokens', label: 'Tokens (est.)', num: true, sort: (i) => i.tokens, cell: (i) => barCell(i.tokens, maxTok, fmtTokens(i.tokens), categoryColor(categoryOf(i.kind))) },
        ],
        { initial: 'tokens', onRow: (i) => showRaw(r.id, i), limit: 100 },
      ),
    );
  };
  const filterSeg = seg(
    [
      { key: 'all', label: 'Everything in context' },
      { key: 'added', label: 'Added this turn' },
    ],
    filter,
    (k) => {
      filter = k;
      filterSeg.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String((i === 0 ? 'all' : 'added') === k)));
      drawItems();
      disposeTree();
      tree = contextTreemap(treeEl, a.items, (it) => showRaw(r.id, it), filter === 'added');
    },
  );
  const catSel = h(
    'select',
    {
      'aria-label': 'Category',
      onchange: (e: Event) => {
        category = (e.target as HTMLSelectElement).value;
        drawItems();
      },
    },
    h('option', { value: '' }, 'All kinds'),
    ...byCat.map((x) => h('option', { value: x.c.key }, x.c.label)),
  );
  let tree: ReturnType<typeof contextTreemap> | undefined;
  const disposeTree = () => tree?.dispose();

  const nav = h(
    'div',
    { style: { display: 'flex', gap: '6px' } },
    h('button', { class: 'btn', disabled: d.thread.prev ? null : 'disabled', onclick: () => d.thread.prev && go(reqHref(d.thread.prev)) }, '← Previous'),
    h('button', { class: 'btn', disabled: d.thread.next ? null : 'disabled', onclick: () => d.thread.next && go(reqHref(d.thread.next)) }, 'Next →'),
  );

  const outMax = Math.max(...a.output.map((o) => o.tokens), 0);
  main.replaceChildren(
    h(
      'div',
      { class: 'tiles' },
      tile('In context', fmtTokens(total), `${fmtPct(total / r.contextLimit)} of ${fmtTokens(r.contextLimit)} · measured`, true),
      tile('Added this turn', fmtTokens(a.addedTokens), d.thread.index ? 'new since the previous request' : 'first request of this thread'),
      tile('Cache read / write', `${fmtTokens(r.usage.cacheRead)} / ${fmtTokens(r.usage.cacheWrite5m + r.usage.cacheWrite1h)}`, `${fmtTokens(r.usage.input)} uncached`),
      tile('Output', fmtTokens(r.usage.output), r.usage.thinking ? `${fmtTokens(r.usage.thinking)} thinking` : r.stopReason ? `stop: ${r.stopReason}` : ''),
      tile('Cost', fmtUSD(r.cost), `${r.model} · ${fmtDateTime(r.ts)}`),
    ),
    h(
      'div',
      { class: 'note' },
      `Totals are measured by the API. Per-item tokens are estimated from text length at ${a.charsPerToken.toFixed(2)} characters per token (calibrated on this thread) and always add up to the measured total. ` +
        `"System prompt + tools" (${fmtTokens(a.baselineTokens)}) is measured once on the thread's first request. ` +
        (a.unattributedTokens ? `"Not in transcript" (${fmtTokens(a.unattributedTokens)}) is context growth no transcript line explains, usually tool schemas loaded mid-session.` : ''),
    ),
    card('What was in the context', `${a.items.length} line items`, [nav], compBar, compLegend, treeEl),
    card(
      'Line items',
      'Click a row to read its content',
      [filterSeg, catSel, ...exportButtons(`request-${r.id}-context`, () => a.items.map((i) => ({ position: a.items.indexOf(i), kind: i.kind, category: categoryOf(i.kind).label, label: i.label, detail: i.detail ?? '', chars: i.chars, tokens: i.tokens, addedThisTurn: i.added, addedAt: i.uuid ? new Date(i.ts).toISOString() : '' })))],
      itemsHolder,
    ),
    card(
      'This request’s response',
      `${fmtTokens(r.usage.output)} output tokens`,
      [],
      table(a.output, [
        { key: 'kind', label: 'Kind', cell: (o) => h('span', {}, h('span', { class: 'key', style: { background: categoryColor(categoryOf(o.kind)) } }), categoryOf(o.kind).label) },
        { key: 'label', label: 'Item', cls: 'title', cell: (o) => h('div', {}, h('span', { class: 't' }, o.label), o.detail ? h('span', { class: 'muted t' }, o.detail) : null) },
        { key: 'tokens', label: 'Tokens (est.)', num: true, cell: (o) => barCell(o.tokens, outMax, fmtTokens(o.tokens), categoryColor(categoryOf(o.kind))) },
      ], { onRow: (o) => showRaw(r.id, { ...o, added: false, ts: r.ts } as ContextItem) }),
    ),
  );
  drawItems();
  tree = contextTreemap(treeEl, a.items, (it) => showRaw(r.id, it));
}

/* ---------- raw content drawer ---------- */

let drawer: HTMLElement | undefined;
function closeRaw() {
  drawer?.remove();
  drawer = undefined;
}
async function showRaw(requestId: string, item: ContextItem) {
  closeRaw();
  const pre = h('pre', {}, 'Loading…');
  drawer = h(
    'aside',
    { class: 'raw', role: 'dialog', 'aria-label': 'Item content' },
    h('header', {}, h('span', { class: 't', title: item.label }, `${categoryOf(item.kind).label}: ${item.label}`), h('span', { class: 'muted' }, `${fmtTokens(item.tokens)} tokens`), h('button', { class: 'btn', onclick: closeRaw }, 'Close')),
    pre,
  );
  document.body.append(drawer);
  if (!item.uuid) {
    pre.textContent =
      item.kind === 'baseline'
        ? 'The system prompt and tool definitions are sent with every request but never written to the transcript.\n\nThis figure is measured on the first request of the thread: measured input minus the estimated size of everything the transcript does contain.'
        : 'This is context growth that no transcript line accounts for. The most common cause is tool schemas loaded mid-session (ToolSearch, MCP servers connecting, skills), which join the tool list rather than the conversation. It is attributed to the step where the measurement first outgrew the visible content.';
    return;
  }
  try {
    const res = await api<{ text: string }>('raw', { request: requestId, uuid: item.uuid, block: String(item.block) });
    pre.textContent = res.text || '(empty)';
  } catch (e) {
    pre.textContent = String(e);
  }
}
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeRaw());

/* ---------- render loop ---------- */

async function render() {
  const token = ++renderToken;
  closeRaw();
  const route = parseRoute();
  main.classList.add('loading');
  try {
    disposeAll();
    if (route.view === 'overview') await overview(token);
    else if (route.view === 'day') await dayView(token, route.id!);
    else if (route.view === 'session') await sessionView(token, route.id!, route.params.get('day') ?? undefined);
    else await requestView(token, route.id!, route.params);
  } catch (e) {
    if (token === renderToken) main.replaceChildren(h('div', { class: 'empty err' }, `Could not load: ${String(e)}`));
  } finally {
    if (token === renderToken) {
      main.classList.remove('loading');
      window.scrollTo({ top: 0 });
    }
  }
}

shell();
window.addEventListener('hashchange', render);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render());
render();
