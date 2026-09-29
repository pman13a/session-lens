import './style.css';
import { api, saveFile, type AccountState, type BillingMode, type CompositionPoint, type UsageView, type ContextItem, type RequestDetail, type RequestRow, type SessionDetail, type SessionRow, type Summary } from './api';
import { CATEGORIES, categoryColor, categoryOf, COMPONENTS, compositionChart, contextChart, contextTreemap, costChart, cssVar, dailyChart, disposeAll, usageChart, usageColors } from './charts';
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

/* ---------- billing: how usage becomes money for the logged-in account ---------- */

let acct: AccountState | undefined;
const MODE_LABEL: Record<BillingMode, string> = {
  api: 'Pay per token (API)',
  subscription: 'Subscription (Pro/Max)',
  team: 'Team / Enterprise',
};

/** On a subscription the dollars are what the usage *would* cost on the API, not a bill. */
function costWord(): string {
  return acct?.mode === 'subscription' ? 'API value' : 'Cost';
}

async function setBilling(patch: Record<string, unknown>) {
  acct = await api<AccountState>('settings', {}, patch);
  render();
}

let billingSlot: HTMLElement;
function drawBilling() {
  if (!billingSlot) return;
  if (!acct) {
    billingSlot.replaceChildren();
    return;
  }
  const sel = h(
    'select',
    { 'aria-label': 'Billing', title: 'How cost is shown. Auto follows the account Claude Code is logged in with.', onchange: (e: Event) => setBilling({ billing: (e.target as HTMLSelectElement).value }) },
    h('option', { value: 'auto', selected: acct.overridden ? null : 'selected' }, `Auto: ${acct.account.label}`),
    ...(['api', 'subscription', 'team'] as BillingMode[]).map((m) => h('option', { value: m, selected: acct!.overridden && acct!.mode === m ? 'selected' : null }, MODE_LABEL[m])),
  );
  billingSlot.replaceChildren(sel, h('button', { class: 'btn', onclick: openPlanDrawer, title: 'Plan price, monthly limit, billing period' }, 'Plan…'));
}

function rangeParams(): { from?: string; to?: string; project?: string } {
  const r = RANGES.find((x) => x.key === state.range);
  return { from: r?.days ? daysAgo(r.days - 1) : undefined, project: state.project || undefined };
}

/* ---------- routing ---------- */

interface Route {
  view: 'overview' | 'day' | 'session' | 'request' | 'usage';
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
  if (view === 'usage') return { view: 'usage', params };
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
  billingSlot = h('span', { class: 'filters' });
  drawBilling();
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
        h(
          'div',
          { class: 'seg', role: 'tablist', 'aria-label': 'View' },
          h('button', { role: 'tab', 'aria-pressed': String(parseRoute().view !== 'usage'), onclick: () => go('#/') }, 'Explorer'),
          h('button', { role: 'tab', 'aria-pressed': String(parseRoute().view === 'usage'), onclick: () => go('#/usage') }, 'Usage limits'),
        ),
        // The Usage limits page has its own range control (UTC, like Claude's page), so hide the Explorer's.
        h('div', { class: 'filters' }, parseRoute().view === 'usage' ? null : rangeSeg, projectSel, billingSlot),
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

/* ---------- billing tiles ---------- */

function rangeDays(sum: Summary): number {
  const r = RANGES.find((x) => x.key === state.range);
  if (r?.days) return r.days;
  if (!sum.range.first || !sum.range.last) return 1;
  return Math.round((Date.parse(sum.range.last) - Date.parse(sum.range.first)) / 86_400_000) + 1;
}

function heroCostTile(cost: number, sum: Summary) {
  const mode = acct?.mode ?? 'api';
  const disc = sum.discount ? ` after ${fmtPct(sum.discount)} discount` : '';
  if (mode === 'subscription') {
    const price = acct?.settings.planPrice;
    const days = rangeDays(sum);
    const fee = price ? (price * days) / 30 : 0;
    const sub = price ? `${(cost / fee).toFixed(1)}× the ${fmtUSD(fee)} of plan fee for ${days === 1 ? 'this day' : `these ${days} days`}` : 'what this usage would cost on the API';
    return tile('API-equivalent value', fmtUSD(cost), sub, true);
  }
  if (mode === 'team') return tile('Usage at API rates', fmtUSD(cost), `billed per token on Team / Enterprise${disc}`, true);
  return tile('Spend', fmtUSD(cost), sum.discount ? `at API list prices${disc}` : 'at API list prices', true);
}

/** Where this billing period stands: spend against a limit, or value against the plan fee. */
function periodCard(): Node | undefined {
  if (!acct) return undefined;
  const p = acct.period;
  const head = `${fmtDay(p.start)} – ${fmtDay(p.end)} · day ${p.daysElapsed} of ${p.days}`;
  const setBtn = h('button', { class: 'btn', onclick: openPlanDrawer }, 'Plan…');
  if (acct.mode === 'subscription') {
    const price = acct.settings.planPrice;
    return card(
      'This billing period',
      head,
      [setBtn],
      h(
        'div',
        { class: 'tiles', style: { marginBottom: '8px' } },
        tile('API-equivalent value so far', fmtUSD(p.cost), `on pace for ${fmtUSD(p.projected)}`),
        price ? tile('Versus your plan', `${(p.cost / price).toFixed(1)}×`, `${fmtUSD(price)}/mo plan`) : tile('Versus your plan', '—', 'set your plan price under Plan…'),
      ),
      h('div', { class: 'note', style: { marginBottom: '0' } }, 'Pro and Max limits are 5-hour and weekly usage windows, not dollars. The exact percentage left is only shown on claude.ai under Settings → Usage; transcripts do not record it.'),
    );
  }
  const limit = acct.settings.monthlyLimit;
  if (!limit)
    return card('This billing period', head, [setBtn], h('div', { class: 'muted' }, `${fmtUSD(p.cost)} so far, on pace for ${fmtUSD(p.projected)}. Set a monthly limit under Plan… to track it.`));
  const pct = p.cost / limit;
  const cls = pct >= 0.9 ? 'meter crit' : pct >= 0.7 ? 'meter warn' : 'meter';
  return card(
    'This billing period',
    head,
    [setBtn],
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
      h('b', { style: { fontSize: '20px' } }, `${fmtUSD(p.cost)} of ${fmtUSD(limit)}`),
      h('span', { class: cls, style: { width: '240px', height: '10px', borderRadius: '5px' } }, h('div', { style: { width: `${Math.min(pct, 1) * 100}%` } })),
      h('span', {}, fmtPct(pct)),
      h('span', { class: 'muted' }, `on pace for ${fmtUSD(p.projected)} by ${fmtDay(p.end)}${p.projected > limit ? ' · over the limit' : ''}`),
    ),
  );
}

/* ---------- plan settings drawer ---------- */

function openPlanDrawer() {
  if (!acct) return;
  closeRaw();
  const a = acct.account;
  const st = acct.settings;
  const field = (label: string, input: HTMLElement, hint?: string) =>
    h('label', { style: { display: 'grid', gap: '4px', marginBottom: '14px' } }, h('span', { style: { fontWeight: '600' } }, label), input, hint ? h('span', { class: 'muted', style: { fontSize: '12px' } }, hint) : null);
  const billing = h(
    'select',
    {},
    h('option', { value: 'auto', selected: st.billing === 'auto' ? 'selected' : null }, `Auto: ${a.label}`),
    ...(['api', 'subscription', 'team'] as BillingMode[]).map((m) => h('option', { value: m, selected: st.billing === m ? 'selected' : null }, MODE_LABEL[m])),
  );
  const num = (v: number | null | undefined, attrs: Record<string, string> = {}) => h('input', { type: 'number', value: v == null ? '' : String(v), min: '0', step: 'any', ...attrs }) as HTMLInputElement;
  const price = num(st.planPrice, { placeholder: 'e.g. 20, 100 or 200' });
  const limit = num(st.monthlyLimit, { placeholder: 'e.g. 500' });
  const startDay = num(st.periodStartDay, { min: '1', max: '28', step: '1' });
  const discount = num(st.discount ? Math.round(st.discount * 100) : null, { max: '100', step: '1', placeholder: '0' });
  const status = h('span', { class: 'muted' });
  const read = (i: HTMLInputElement) => (i.value.trim() === '' ? null : Number(i.value));
  const save = async () => {
    const d = read(discount);
    try {
      acct = await api<AccountState>('settings', {}, {
        billing: billing.value,
        planPrice: read(price),
        monthlyLimit: read(limit),
        periodStartDay: read(startDay),
        discount: d == null ? null : d / 100,
      });
      closeRaw();
      shell();
      render();
    } catch (e) {
      status.textContent = String(e);
    }
  };
  const detected = [
    `Detected: ${a.label}`,
    a.orgName ? `Organization: ${a.orgName}` : '',
    a.email ? `Account: ${a.email}` : '',
    a.source === 'claude-cli' ? 'Source: claude auth status' : a.source === 'config' ? 'Source: ~/.claude.json (plan not reported)' : 'Source: no Claude Code login found',
  ].filter(Boolean);
  drawer = h(
    'aside',
    { class: 'raw', role: 'dialog', 'aria-label': 'Plan settings' },
    h('header', {}, h('span', { class: 't' }, 'Plan & billing'), h('button', { class: 'btn', onclick: closeRaw }, 'Close')),
    h(
      'div',
      { style: { padding: '16px', overflow: 'auto', flex: '1' } },
      h('div', { class: 'note' }, ...detected.flatMap((l, i) => (i ? [h('br'), l] : [l]))),
      field('Billing', billing, 'Auto follows the account Claude Code is logged in with. Pick one to override it.'),
      field('Plan price ($ per month)', price, 'Pro and Max: compares API-equivalent value with what you pay.'),
      field('Monthly limit ($)', limit, 'Team / Enterprise allowance, or your own API budget.'),
      field('Billing period starts on day', startDay),
      field('Discount (%)', discount, 'Negotiated rate off API list prices, if any.'),
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, h('button', { class: 'btn', onclick: save, style: { fontWeight: '600' } }, 'Save'), status),
      h('p', { class: 'muted', style: { fontSize: '12px' } }, 'Saved to ~/.session-lens/settings.json and shared by the browser, VS Code and desktop versions.'),
    ),
  );
  document.body.append(drawer);
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
      heroCostTile(t.cost, sum),
      tile('Sessions', fmtInt(t.sessions), `${fmtInt(t.requests)} requests`),
      tile('Input tokens', fmtTokens(inTokens), `${fmtPct(inTokens ? t.cacheRead / inTokens : 0)} served from cache`),
      tile('Output tokens', fmtTokens(t.output)),
      tile('Days active', String(sum.days.length), sum.range.first ? `data from ${fmtDay(sum.range.first)}` : 'no data'),
    ),
  );
  const period = periodCard();
  if (period) kids.push(period);
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
        { key: 'cost', label: costWord(), num: true, sort: (d) => d.cost, cell: (d) => fmtUSD(d.cost) },
      ],
      { onRow: (d) => go(`#/day/${d.day}`), initial: 'day' },
    );
  const modeSeg = seg(
    [
      { key: 'cost', label: costWord() },
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
      state.dailyMode === 'cost' ? `${costWord()} by day` : 'Tokens by day',
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
        { key: 'cost', label: costWord(), num: true, sort: (r) => r.cost, cell: (r) => barCell(r.cost, maxCost, fmtUSD(r.cost)) },
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
      tile(acct?.mode === 'subscription' ? 'API-equivalent value' : 'Cost', fmtUSD(t.cost), fmtDay(day), true),
      tile('Sessions', fmtInt(t.sessions), `${fmtInt(t.requests)} requests`),
      tile('Input tokens', fmtTokens(inTokens), `${fmtPct(inTokens ? t.cacheRead / inTokens : 0)} from cache`),
      tile('Output tokens', fmtTokens(t.output)),
    ),
    sessionsCard(sess.sessions, `Sessions on ${fmtDay(day)}`, day),
  );
}

/* ---------- level 3: one session ---------- */

function compositionCard(points: CompositionPoint[], d: SessionDetail, open: (id: string) => void): Node {
  const chartEl = h('div', { class: 'chart tall' });
  let thread = '';
  let mode = store.get('compMode', 'tokens') as 'tokens' | 'share';
  const legendHolder = h('div');
  const draw = () => {
    const pts = points.filter((p) => (p.agentId ?? '') === thread);
    const present = CATEGORIES.filter((c) => pts.some((p) => (c.kinds as readonly string[]).some((k) => (p.byKind as Record<string, number>)[k] > 0)));
    legendHolder.replaceChildren(legend(present.map((c) => ({ label: c.label, color: categoryColor(c) }))));
    const old = (chartEl as unknown as { _chart?: { dispose(): void } })._chart;
    old?.dispose();
    (chartEl as unknown as { _chart?: unknown })._chart = pts.length ? compositionChart(chartEl, pts, mode, open) : undefined;
    if (!pts.length) chartEl.replaceChildren(h('div', { class: 'empty' }, 'No requests on this thread'));
  };
  const modeSeg = seg(
    [
      { key: 'tokens', label: 'Tokens' },
      { key: 'share', label: '% of context' },
    ],
    mode,
    (k) => {
      mode = k;
      store.set('compMode', k);
      modeSeg.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String((i === 0 ? 'tokens' : 'share') === k)));
      draw();
    },
  );
  const actions: Node[] = [modeSeg];
  if (d.subagents.length)
    actions.unshift(
      h(
        'select',
        {
          'aria-label': 'Thread',
          onchange: (e: Event) => {
            thread = (e.target as HTMLSelectElement).value;
            draw();
          },
        },
        h('option', { value: '' }, 'Main thread'),
        ...d.subagents.map((a) => h('option', { value: a.agentId }, `Subagent: ${a.agentType ?? 'agent'} · ${a.description ?? a.agentId}`)),
      ),
    );
  const el = card('What filled the context over time', 'Each request’s context split by kind. Click a point to open that request.', actions, legendHolder, chartEl);
  queueMicrotask(draw);
  return el;
}

async function sessionView(token: number, id: string, day?: string) {
  const [d, comp] = await Promise.all([api<SessionDetail>('session', { id }), api<{ points: CompositionPoint[] }>('composition', { id })]);
  if (token !== renderToken) return;
  const s = d.session;
  const reqs = d.requests;
  const dayQ = day ? `&day=${day}` : '';
  setCrumbs([{ label: 'Overview', href: '#/' }, ...(day ? [{ label: fmtDay(day), href: `#/day/${day}` }] : []), { label: s.title }]);
  const open = (rid: string) => go(`#/request/${encodeURIComponent(rid)}?session=${encodeURIComponent(s.id)}${dayQ}`);
  // Largest context by tokens (a small subagent can have a higher % of a smaller window).
  const peak = reqs.reduce((a, r) => (r.contextTokens > a.contextTokens ? r : a), reqs[0]);
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
    { key: 'cost', label: costWord(), num: true, cell: (r) => fmtUSD(r.cost) },
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
      tile(acct?.mode === 'subscription' ? 'Session API value' : 'Session cost', fmtUSD(s.cost), s.reportedCostUSD != null ? `Claude Code last logged ${fmtUSD(s.reportedCostUSD)}` : s.project, true),
      tile('Requests', fmtInt(reqs.length), `${d.turns.length} prompts · ${d.subagents.length} subagents`),
      tile('Duration', fmtDuration(s.lastTs - s.firstTs), fmtDateTime(s.firstTs)),
      tile('Peak context', peak ? fmtTokens(peak.contextTokens) : '—', peak ? `${fmtPct(peak.contextTokens / peak.contextLimit)} of ${fmtTokens(peak.contextLimit)}` : ''),
      tile('Cache read / write', `${fmtTokens(u.read)} / ${fmtTokens(u.write)}`, `${fmtTokens(u.out)} output`),
    ),
    compositionCard(comp.points, d, open),
    h(
      'div',
      { class: 'grid2' },
      card('Context size per request', 'Tokens the model saw on each call. Click a point to break it down.', [], legend([{ label: 'Main thread', color: cssVar('--series-1') }, ...(d.subagents.length ? [{ label: 'Subagents', color: cssVar('--series-2') }] : [])]), ctxEl),
      card(`${costWord()} per request`, 'Stacked by token type. Click a bar to break it down.', [], legend(COMPONENTS.map((c) => ({ label: c.label, color: cssVar(`--series-${c.slot}`) }))), costEl),
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
          { key: 'cost', label: costWord(), num: true, cell: (a) => fmtUSD(a.cost) },
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
      tile(costWord(), fmtUSD(r.cost), `${r.model} · ${fmtDateTime(r.ts)}`),
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


/* ---------- Usage limits: a 1:1 counterpart of Claude's own usage page, for checking this tool ---------- */

type UsageRange = 'period' | 'last-period' | '7d' | '30d' | 'custom';
const usageState = {
  range: store.get('u.range', 'period') as UsageRange,
  from: store.get('u.from', ''),
  to: store.get('u.to', ''),
  group: store.get('u.group', 'product') as UsageView['group'],
  interval: store.get('u.interval', 'day') as UsageView['interval'],
};

const utcToday = () => new Date().toISOString().slice(0, 10);
const utcAdd = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
const utcLabel = (d: string, withYear = false) =>
  new Date(d + 'T00:00:00Z').toLocaleDateString([], { month: 'long', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });

function usageRangeParams(period?: { start: string }): { from?: string; to?: string } {
  const today = utcToday();
  switch (usageState.range) {
    case '7d':
      return { from: utcAdd(today, -6), to: today };
    case '30d':
      return { from: utcAdd(today, -29), to: today };
    case 'last-period': {
      if (!period) return {};
      const end = utcAdd(period.start, -1);
      const d = new Date(period.start + 'T00:00:00Z');
      const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, d.getUTCDate())).toISOString().slice(0, 10);
      return { from: start, to: end };
    }
    case 'custom':
      return usageState.from && usageState.to ? { from: usageState.from, to: usageState.to } : {};
    default:
      return {}; // the current spend period through today
  }
}

function rangeText(from: string, to: string) {
  const f = new Date(from + 'T00:00:00Z');
  const t = new Date(to + 'T00:00:00Z');
  if (f.getUTCFullYear() === t.getUTCFullYear() && f.getUTCMonth() === t.getUTCMonth()) return `${utcLabel(from)} – ${t.getUTCDate()}`;
  return `${utcLabel(from)} – ${utcLabel(to)}`;
}

function signedPct(x: number | null): string {
  if (x == null || !Number.isFinite(x)) return '—';
  return `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
}

function signedUSD(x: number): string {
  return `${x > 0 ? '+' : x < 0 ? '−' : ''}${fmtUSD(Math.abs(x))}`;
}

let lastPeriodStart: { start: string } | undefined;

async function usageLimitsView(token: number) {
  const params = { ...usageRangeParams(lastPeriodStart), group: usageState.group, interval: usageState.interval, project: state.project || undefined };
  const v = await api<UsageView>('usage', params);
  if (token !== renderToken) return;
  lastPeriodStart = v.period;
  setCrumbs([{ label: 'Usage limits' }]);
  const plan = acct?.account.subscriptionType ? acct.account.subscriptionType.replace(/^./, (c) => c.toUpperCase()) : acct ? MODE_LABEL[acct.mode] : '';

  /* header: $X of $Y spent · resets … */
  const limit = v.period.limit;
  const spent = v.period.spent;
  const pct = limit ? spent / limit : 0;
  const resets = new Date(v.period.resetsAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const dash = v.reference.period;
  const barColor = pct >= 0.9 ? cssVar('--critical') : pct >= 0.7 ? cssVar('--warning') : cssVar('--accent');
  const header = h(
    'section',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('div', {}, h('h2', { style: { fontSize: '16px' } }, 'Your usage limits ', h('span', { class: 'muted', style: { fontWeight: '500' } }, plan)))),
    h(
      'div',
      { style: { display: 'flex', gap: '24px', alignItems: 'center', flexWrap: 'wrap' } },
      h(
        'div',
        { style: { minWidth: '260px', flex: '1' } },
        h('div', { style: { fontSize: '16px', fontWeight: '600' } }, limit ? `${fmtUSD(spent)} of ${fmtUSD(limit)} spent` : `${fmtUSD(spent)} spent`),
        h('div', { class: 'muted' }, `${limit ? 'Spend limit' : 'No spend limit set'} · Resets ${resets}`),
        h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '4px' } }, 'Session Lens estimate: Claude Code on this computer, this period (UTC).'),
        dash.spent != null
          ? h(
              'div',
              { style: { marginTop: '6px' } },
              h('b', {}, `Dashboard: ${fmtUSD(dash.spent)}${dash.limit ? ` of ${fmtUSD(dash.limit)}` : ''}`),
              h('span', { class: 'muted' }, ' · Session Lens is ', h('span', { style: { whiteSpace: 'nowrap' } }, signedUSD(spent - dash.spent)), ` (${fmtPct(dash.spent ? spent / dash.spent : 0)} of it, all products)`),
            )
          : null,
      ),
      limit
        ? h(
            'div',
            { style: { flex: '2', minWidth: '240px', display: 'flex', alignItems: 'center', gap: '16px' } },
            h('div', { style: { flex: '1', height: '8px', borderRadius: '4px', background: cssVar('--surface-2'), overflow: 'hidden' } }, h('div', { style: { width: `${Math.min(pct, 1) * 100}%`, height: '100%', background: barColor, borderRadius: '4px' } })),
            h('span', {}, `${Math.round(pct * 100)}% used`),
          )
        : h('button', { class: 'btn', onclick: openPlanDrawer }, 'Set spend limit'),
    ),
  );

  /* controls: Group by · Daily/Weekly · range */
  const persist = () => {
    store.set('u.range', usageState.range);
    store.set('u.from', usageState.from);
    store.set('u.to', usageState.to);
    store.set('u.group', usageState.group);
    store.set('u.interval', usageState.interval);
    render();
  };
  const groupSel = h(
    'select',
    { 'aria-label': 'Group by', onchange: (e: Event) => ((usageState.group = (e.target as HTMLSelectElement).value as UsageView['group']), persist()) },
    ...(
      [
        ['product', 'Product'],
        ['model', 'Model'],
        ['project', 'Project'],
        ['surface', 'Surface'],
      ] as const
    ).map(([k, l]) => h('option', { value: k, selected: usageState.group === k ? 'selected' : null }, `Group by ${l}`)),
  );
  const intervalSeg = seg(
    [
      { key: 'day', label: 'Daily' },
      { key: 'week', label: 'Weekly' },
    ],
    usageState.interval,
    (k) => ((usageState.interval = k as UsageView['interval']), persist()),
  );
  const rangeSel = h(
    'select',
    {
      'aria-label': 'Date range',
      onchange: (e: Event) => {
        usageState.range = (e.target as HTMLSelectElement).value as UsageRange;
        if (usageState.range === 'custom' && !usageState.from) [usageState.from, usageState.to] = [v.range.from, v.range.to];
        persist();
      },
    },
    h('option', { value: 'period', selected: usageState.range === 'period' ? 'selected' : null }, usageState.range === 'period' ? rangeText(v.range.from, v.range.to) : 'This period'),
    h('option', { value: 'last-period', selected: usageState.range === 'last-period' ? 'selected' : null }, 'Last period'),
    h('option', { value: '7d', selected: usageState.range === '7d' ? 'selected' : null }, 'Last 7 days'),
    h('option', { value: '30d', selected: usageState.range === '30d' ? 'selected' : null }, 'Last 30 days'),
    h('option', { value: 'custom', selected: usageState.range === 'custom' ? 'selected' : null }, 'Custom…'),
  );
  const custom =
    usageState.range === 'custom'
      ? [
          h('input', { type: 'date', value: usageState.from, 'aria-label': 'From (UTC)', onchange: (e: Event) => ((usageState.from = (e.target as HTMLInputElement).value), persist()) }),
          h('input', { type: 'date', value: usageState.to, 'aria-label': 'To (UTC)', onchange: (e: Event) => ((usageState.to = (e.target as HTMLInputElement).value), persist()) }),
        ]
      : [];
  const controls = h(
    'div',
    { class: 'filters', style: { marginBottom: '16px' } },
    groupSel,
    intervalSeg,
    h('div', { class: 'spacer' }),
    ...custom,
    rangeSel,
    h('button', { class: 'btn', onclick: () => openReferenceDrawer(v) }, 'Enter dashboard figures'),
  );

  /* chart */
  const noun = { product: 'product', model: 'model', project: 'project', surface: 'surface' }[v.group];
  const colors = usageColors(v);
  const chartEl = h('div', { class: 'chart' });
  const hasRefDays = Object.keys(v.reference.days).length > 0;
  const chartCard = card(
    `${v.interval === 'week' ? 'Weekly' : 'Daily'} spend by ${noun}`,
    'Dates in UTC',
    exportButtons(`usage-${v.range.from}-${v.range.to}`, () =>
      v.buckets.map((bk, i) => ({ [v.interval === 'week' ? 'week' : 'day']: bk, ...Object.fromEntries(v.series.map((s) => [s.label, +s.values[i].toFixed(4)])), ...(hasRefDays && v.interval === 'day' ? { dashboard: v.reference.days[bk] ?? '' } : {}) })),
    ),
    chartEl,
    legend([...v.series.map((s, i) => ({ label: s.label, color: colors[i] })), ...(hasRefDays ? [{ label: 'Dashboard (entered)', color: cssVar('--text-secondary') }] : [])]),
  );

  /* table: Product · Spend · % of total · vs prior period (+ Dashboard · Difference when entered) */
  const ref = v.reference.range;
  const hasRef = v.group === 'product' && Object.keys(ref).length > 0;
  type Row = UsageView['series'][number] & { color: string };
  const rows: Row[] = v.series.map((s, i) => ({ ...s, color: colors[i] })).filter((s) => v.group === 'product' || s.total > 0);
  const cols: Col<Row>[] = [
    { key: 'label', label: noun[0].toUpperCase() + noun.slice(1), cell: (r) => h('span', {}, h('span', { class: 'key', style: { background: r.color, borderRadius: '50%' } }), r.label) },
    { key: 'spend', label: 'Spend', num: true, sort: (r) => r.total, cell: (r) => (r.local ? fmtUSD(r.total) : h('span', { class: 'muted', title: 'Not recorded on this computer' }, 'not local')) },
    { key: 'share', label: '% of total', num: true, sort: (r) => r.share, cell: (r) => (r.local ? `${(r.share * 100).toFixed(1)}%` : '—') },
    { key: 'change', label: 'vs prior period', num: true, sort: (r) => r.change ?? -Infinity, cell: (r) => (r.local ? h('span', { title: `${fmtUSD(r.prior)} in ${rangeText(v.range.prior.from, v.range.prior.to)}` }, signedPct(r.change)) : '—') },
  ];
  if (hasRef)
    cols.push(
      { key: 'dash', label: 'Dashboard', num: true, cell: (r) => (ref[r.key as keyof typeof ref] != null ? fmtUSD(ref[r.key as keyof typeof ref]!) : h('span', { class: 'muted' }, '—')) },
      {
        key: 'diff',
        label: 'Difference',
        num: true,
        cell: (r) => {
          const d = ref[r.key as keyof typeof ref];
          if (d == null || !r.local) return h('span', { class: 'muted' }, '—');
          return h('span', { title: `${fmtPct(d ? r.total / d : 0)} of the dashboard` }, signedUSD(r.total - d));
        },
      },
    );
  const tableCard = card(
    '',
    null,
    [],
    table(rows, cols, { initial: v.group === 'product' ? undefined : 'spend' }),
    v.group === 'product' ? h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } }, 'Chat, Cowork and Claude in Chrome leave no local records; enter their dashboard figures to compare totals.') : null,
  );

  /* top skills */
  const skillsCard = card(
    'Top skills',
    `Through ${utcLabel(v.skillsThrough)} (yesterday, UTC)`,
    [],
    v.skills.length
      ? table(v.skills.slice(0, 15), [
          { key: 'name', label: 'Skill', cell: (x) => h('span', { class: 'mono' }, x.name) },
          { key: 'uses', label: 'Uses', num: true, cell: (x) => x.uses },
          { key: 'sessions', label: 'Sessions', num: true, cell: (x) => x.sessions },
        ])
      : h('div', { class: 'muted' }, 'No skills used in this range.'),
  );

  main.replaceChildren(header, controls, chartCard, tableCard, reconcileCard(v), skillsCard);
  if (v.series.some((s) => s.total > 0) || hasRefDays) usageChart(chartEl, v, (bk) => go(`#/day/${bk}`));
  else chartEl.replaceChildren(h('div', { class: 'empty' }, 'No Claude Code spend in this range.'));
}

/** Where Session Lens and the dashboard disagree, split into signed terms that add up to the gap. */
function reconcileCard(v: UsageView): Node {
  const cc = v.series.find((s) => s.key === 'claude_code');
  const days = Object.entries(v.reference.days).sort(([a], [b]) => a.localeCompare(b));
  const ours = new Map<string, number>();
  if (cc) v.buckets.forEach((bk, i) => ours.set(bk, cc.values[i]));
  const refCC = v.reference.range.claude_code;
  const kids: Child[] = [];
  const causes = h(
    'ul',
    { style: { margin: '6px 0 0', paddingLeft: '18px', color: cssVar('--text-secondary'), fontSize: '13px' } },
    h('li', {}, 'Claude Code on the web and cloud sessions started from the app run in Anthropic’s cloud; their transcripts never reach this computer.'),
    h('li', {}, 'Other computers signed in to the same account (sync their ~/.claude/projects to include them).'),
    h('li', {}, 'Small internal calls Claude Code makes (e.g. summarising fetched pages) are billed but not written to transcripts.'),
    h('li', {}, 'Your organisation’s rates: set a discount or price overrides under Plan… if every day reads high or low by the same ratio.'),
  );
  if (!days.length && refCC == null && v.reference.period.spent == null) {
    return card(
      'Check against Claude’s dashboard',
      'Type in the numbers from claude.ai → Settings → Usage to test this tool against the source of truth',
      [h('button', { class: 'btn', onclick: () => openReferenceDrawer(v) }, 'Enter dashboard figures')],
      h('div', { class: 'muted' }, 'Session Lens only sees Claude Code sessions that ran on this computer. Expected sources of difference:'),
      causes,
    );
  }
  if (refCC != null && cc)
    kids.push(
      h(
        'div',
        { class: 'tiles', style: { marginBottom: '8px' } },
        tile('Dashboard: Claude Code', fmtUSD(refCC), rangeText(v.range.from, v.range.to)),
        tile('Session Lens: Claude Code', fmtUSD(cc.total), 'this computer'),
        tile('Difference', signedUSD(cc.total - refCC), refCC ? `${fmtPct(cc.total / refCC)} of the dashboard` : ''),
      ),
    );
  if (days.length && v.interval === 'day') {
    let missing = 0;
    let under = 0;
    let over = 0;
    const ratios: number[] = [];
    const rows = days.map(([d, dash]) => {
      const mine = ours.get(d) ?? 0;
      const diff = mine - dash;
      if (mine === 0 && dash > 0) missing += diff;
      else if (diff < 0) under += diff;
      else over += diff;
      if (mine > 0 && dash > 0) ratios.push(mine / dash);
      return { d, dash, mine, diff };
    });
    ratios.sort((a, b) => a - b);
    const med = ratios.length ? ratios[ratios.length >> 1] : undefined;
    const spread = ratios.length > 2 ? ratios[Math.floor(ratios.length * 0.8)] - ratios[Math.floor(ratios.length * 0.2)] : undefined;
    const verdict =
      med == null
        ? 'No day has spend on both sides yet.'
        : spread != null && spread < 0.1
          ? `On days both saw usage, Session Lens reads a steady ${med.toFixed(2)}× the dashboard: that points to a rate difference (discount or pricing), not missing data.`
          : `On days both saw usage, Session Lens reads ${med.toFixed(2)}× the dashboard (median); the ratio varies, which points to usage from other computers or the cloud on those days.`;
    kids.push(
      h(
        'div',
        { class: 'note' },
        `Across ${rows.length} entered days the gap is ${signedUSD(missing + under + over)}: `,
        h('b', {}, `${signedUSD(missing)}`),
        ' on days with no local usage, ',
        h('b', {}, `${signedUSD(under)}`),
        ' where local reads lower, ',
        h('b', {}, `${signedUSD(over)}`),
        ' where local reads higher. ',
        verdict,
        over > 0.01 ? ' A local reading above the dashboard is worth a look: it can mean double counting.' : '',
      ),
      table(rows, [
        { key: 'd', label: 'Day (UTC)', sort: (r) => r.d, cell: (r) => utcLabel(r.d, true) },
        { key: 'dash', label: 'Dashboard', num: true, sort: (r) => r.dash, cell: (r) => fmtUSD(r.dash) },
        { key: 'mine', label: 'Session Lens', num: true, sort: (r) => r.mine, cell: (r) => fmtUSD(r.mine) },
        { key: 'diff', label: 'Difference', num: true, sort: (r) => r.diff, cell: (r) => signedUSD(r.diff) },
        { key: 'ratio', label: 'Ratio', num: true, sort: (r) => (r.dash ? r.mine / r.dash : 0), cell: (r) => (r.dash && r.mine ? `${(r.mine / r.dash).toFixed(2)}×` : '—') },
      ], { initial: 'd', desc: false, onRow: (r) => go(`#/day/${r.d}`) }),
    );
  } else if (days.length) {
    kids.push(h('div', { class: 'muted' }, 'Switch to Daily to compare day by day.'));
  }
  kids.push(h('div', { class: 'muted', style: { marginTop: '10px' } }, 'Why the two can differ:'), causes);
  return card('Check against Claude’s dashboard', 'Numbers you entered from claude.ai → Settings → Usage, next to Session Lens', [h('button', { class: 'btn', onclick: () => openReferenceDrawer(v) }, 'Edit figures')], ...kids);
}

function openReferenceDrawer(v: UsageView) {
  closeRaw();
  const num = (val: number | undefined | null, placeholder = '') => h('input', { type: 'number', step: '0.01', min: '0', value: val == null ? '' : String(val), placeholder }) as HTMLInputElement;
  const read = (i: HTMLInputElement) => (i.value.trim() === '' ? null : Number(i.value));
  const field = (label: string, input: HTMLElement, hint?: string) =>
    h('label', { style: { display: 'grid', gap: '4px', marginBottom: '12px' } }, h('span', { style: { fontWeight: '600' } }, label), input, hint ? h('span', { class: 'muted', style: { fontSize: '12px' } }, hint) : null);
  const spent = num(v.reference.period.spent, 'e.g. 300.04');
  const limit = num(v.reference.period.limit ?? v.period.limit, 'e.g. 300.00');
  const prod = {
    claude_code: num(v.reference.range.claude_code),
    chat: num(v.reference.range.chat),
    cowork: num(v.reference.range.cowork),
    chrome: num(v.reference.range.chrome),
  };
  const existing = Object.entries(v.reference.days).map(([d, x]) => `${d} ${x.toFixed(2)}`).join('\n');
  const paste = h('textarea', { rows: '8', placeholder: 'One day per line, e.g.\n2026-09-01 58.20\nSep 3 22.10', style: { width: '100%', font: '12px var(--mono)', padding: '8px', borderRadius: '8px', border: `1px solid ${cssVar('--border')}`, background: cssVar('--surface-1'), color: 'inherit' } }) as HTMLTextAreaElement;
  paste.value = existing;
  const status = h('span', { class: 'muted' });
  const save = async () => {
    try {
      // Replace the range's days with what is in the box (so deleting a line removes it).
      const clear: Record<string, null> = {};
      for (const d of Object.keys(v.reference.days)) clear[d] = null;
      await api('reference', {}, {
        period: { start: v.period.start, spent: read(spent), limit: read(limit) },
        range: { key: v.reference.rangeKey, values: Object.fromEntries(Object.entries(prod).map(([k, i]) => [k, read(i)])) },
        days: clear,
        paste: paste.value,
        year: Number(v.range.to.slice(0, 4)),
      });
      if (read(limit) != null && acct && acct.settings.monthlyLimit == null) await api('settings', {}, { monthlyLimit: read(limit) });
      closeRaw();
      render();
    } catch (e) {
      status.textContent = String(e);
    }
  };
  drawer = h(
    'aside',
    { class: 'raw', role: 'dialog', 'aria-label': 'Dashboard figures' },
    h('header', {}, h('span', { class: 't' }, 'Dashboard figures'), h('button', { class: 'btn', onclick: closeRaw }, 'Close')),
    h(
      'div',
      { style: { padding: '16px', overflow: 'auto', flex: '1' } },
      h('div', { class: 'note' }, 'Copy these from claude.ai → Settings → Usage. They are stored only on this computer (~/.session-lens/reference.json) and used for the comparison.'),
      h('h3', { style: { fontSize: '13px', margin: '8px 0' } }, `Header, period starting ${utcLabel(v.period.start, true)}`),
      field('Spent ($)', spent, 'The “$X of $Y spent” figure.'),
      field('Spend limit ($)', limit),
      h('h3', { style: { fontSize: '13px', margin: '16px 0 8px' } }, `Product table, ${rangeText(v.range.from, v.range.to)} (set the same range on the dashboard)`),
      field('Claude Code', prod.claude_code),
      field('Chat', prod.chat),
      field('Cowork', prod.cowork),
      field('Claude in Chrome', prod.chrome),
      h('h3', { style: { fontSize: '13px', margin: '16px 0 8px' } }, 'Daily Claude Code spend (optional)'),
      field('Hover each bar on the dashboard and note its Claude Code value', paste, 'Any of: 2026-09-01 58.20 · Sep 1: $58.20 · 9/1, 58.20. Dates are UTC, as on the dashboard.'),
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, h('button', { class: 'btn', onclick: save, style: { fontWeight: '600' } }, 'Save'), status),
    ),
  );
  document.body.append(drawer);
}

/* ---------- render loop ---------- */

async function render() {
  const token = ++renderToken;
  closeRaw();
  const route = parseRoute();
  main.classList.add('loading');
  try {
    disposeAll();
    try {
      acct = await api<AccountState>('account');
    } catch {
      acct = undefined;
    }
    if (token !== renderToken) return;
    drawBilling();
    if (route.view === 'overview') await overview(token);
    else if (route.view === 'day') await dayView(token, route.id!);
    else if (route.view === 'session') await sessionView(token, route.id!, route.params.get('day') ?? undefined);
    else if (route.view === 'usage') await usageLimitsView(token);
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
window.addEventListener('hashchange', () => {
  shell();
  render();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render());
render();
