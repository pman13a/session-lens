import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BillingMode, Settings } from './types.js';

export interface AccountInfo {
  /** Where the answer came from: the Claude Code CLI, its config file, or nothing. */
  source: 'claude-cli' | 'config' | 'none';
  loggedIn: boolean;
  /** claude.ai | api_key | api_key_helper | oauth_token | third_party | none */
  authMethod?: string;
  /** firstParty | bedrock | vertex | foundry | gateway */
  apiProvider?: string;
  /** pro | max | team | enterprise, when logged in with claude.ai */
  subscriptionType?: string | null;
  orgName?: string | null;
  email?: string | null;
  detected: BillingMode;
  label: string;
  /** e.g. default_claude_max_5x: tells Max 5× from Max 20× (claude auth status does not). */
  rateLimitTier?: string;
  /** Monthly fee implied by the plan, when it can be told: Pro $20, Max 5× $100, Max 20× $200. */
  impliedPlanPrice?: number;
}

/**
 * The billing shape from ~/.claude.json's `oauthAccount`: organizationType and rate-limit tier only.
 * The same object holds the email and account ids; they are not read.
 */
export function readPlanTier(): { organizationType?: string; rateLimitTier?: string } {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.split(',')[0]?.trim();
  for (const p of [configDir ? join(configDir, '.claude.json') : '', join(homedir(), '.claude.json')].filter(Boolean)) {
    try {
      const o = JSON.parse(readFileSync(p, 'utf8'))?.oauthAccount;
      if (!o || typeof o !== 'object') continue;
      const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
      return { organizationType: str(o.organizationType), rateLimitTier: str(o.organizationRateLimitTier) ?? str(o.userRateLimitTier) };
    } catch {
      /* next */
    }
  }
  return {};
}

export function planPriceFor(subscriptionType?: string | null, tier?: string): number | undefined {
  const t = (tier ?? '').toLowerCase();
  if (/max.*20x|20x/.test(t)) return 200;
  if (/max.*5x|5x/.test(t)) return 100;
  const sub = (subscriptionType ?? '').toLowerCase();
  if (sub === 'pro' || /claude_pro/.test(t)) return 20;
  return undefined;
}

export const DEFAULT_SETTINGS_PATH = join(homedir(), '.session-lens', 'settings.json');

/** Map what Claude Code reports about the login to how usage is billed. */
export function billingFor(a: Pick<AccountInfo, 'authMethod' | 'apiProvider' | 'subscriptionType' | 'orgName'>): { mode: BillingMode; label: string } {
  const provider = a.apiProvider ?? 'firstParty';
  if (provider !== 'firstParty' && provider !== 'gateway') return { mode: 'api', label: `${provider} (pay per token)` };
  if (a.authMethod === 'api_key' || a.authMethod === 'api_key_helper') return { mode: 'api', label: 'API key (pay per token)' };
  const sub = a.subscriptionType?.toLowerCase();
  const org = a.orgName ? ` · ${a.orgName}` : '';
  if (sub === 'team' || sub === 'enterprise') return { mode: 'team', label: `${sub === 'team' ? 'Team' : 'Enterprise'}${org}` };
  if (sub === 'pro' || sub === 'max') return { mode: 'subscription', label: `${sub === 'pro' ? 'Pro' : 'Max'} plan` };
  if (a.authMethod === 'claude.ai' || a.authMethod === 'oauth_token') return { mode: 'subscription', label: 'Claude subscription (plan not reported)' };
  return { mode: 'api', label: 'Not logged in' };
}

/**
 * Ask the Claude Code CLI who is logged in (`claude auth status --json`). It reports the plan without
 * exposing credentials. Falls back to ~/.claude.json, which only says whether a claude.ai login exists.
 */
export function detectAccount(run: (cmd: string, args: string[]) => string | undefined = runCli): AccountInfo {
  const out = run('claude', ['auth', 'status', '--json']);
  if (out) {
    try {
      const j = JSON.parse(out.slice(out.indexOf('{')));
      const base = {
        loggedIn: !!j.loggedIn,
        authMethod: j.authMethod,
        apiProvider: j.apiProvider,
        subscriptionType: j.subscriptionType ?? null,
        orgName: j.orgName ?? null,
        email: j.email ?? null,
      };
      const b = billingFor(base);
      const tier = readPlanTier();
      const price = b.mode === 'subscription' ? planPriceFor(base.subscriptionType, tier.rateLimitTier) : undefined;
      const label = price === 200 ? 'Max 20× plan' : price === 100 ? 'Max 5× plan' : b.label;
      return { source: 'claude-cli', ...base, detected: b.mode, label, rateLimitTier: tier.rateLimitTier, impliedPlanPrice: price };
    } catch {
      /* fall through */
    }
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR?.split(',')[0]?.trim();
  for (const p of [configDir ? join(configDir, '.claude.json') : '', join(homedir(), '.claude.json')].filter(Boolean)) {
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf8'));
      const acct = cfg.oauthAccount;
      const authMethod = process.env.ANTHROPIC_API_KEY || cfg.primaryApiKey ? 'api_key' : acct ? 'claude.ai' : 'none';
      const base = { loggedIn: authMethod !== 'none', authMethod, subscriptionType: null, orgName: acct?.organizationName ?? null, email: acct?.emailAddress ?? null };
      const b = billingFor(base);
      return { source: 'config', ...base, detected: b.mode, label: b.label };
    } catch {
      /* next */
    }
  }
  return { source: 'none', loggedIn: false, detected: 'api', label: 'No Claude Code login found' };
}

function runCli(cmd: string, args: string[]): string | undefined {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000, shell: process.platform === 'win32', windowsHide: true });
    return r.status === 0 || r.stdout?.includes('{') ? r.stdout : undefined;
  } catch {
    return undefined;
  }
}

let cached: { at: number; info: AccountInfo } | undefined;
/** Detection spawns a process, so cache it for ten minutes. */
export function account(maxAgeMs = 10 * 60_000): AccountInfo {
  if (!cached || Date.now() - cached.at > maxAgeMs) cached = { at: Date.now(), info: detectAccount() };
  return cached.info;
}

const MODES: BillingMode[] = ['api', 'subscription', 'team'];

/** Validate a settings patch from the UI: only known keys, sane values. */
export function sanitizeSettings(patch: Record<string, unknown>): Partial<Settings> {
  const out: Partial<Settings> = {};
  const num = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined);
  if ('billing' in patch) {
    const b = patch.billing;
    out.billing = b === 'auto' || b == null ? undefined : MODES.includes(b as BillingMode) ? (b as BillingMode) : undefined;
  }
  if ('planPrice' in patch) out.planPrice = patch.planPrice == null ? undefined : num(patch.planPrice, 0, 100_000);
  if ('monthlyLimit' in patch) out.monthlyLimit = patch.monthlyLimit == null ? undefined : num(patch.monthlyLimit, 0, 10_000_000);
  if ('periodStartDay' in patch) out.periodStartDay = patch.periodStartDay == null ? undefined : num(patch.periodStartDay, 1, 28);
  if ('prices' in patch && patch.prices && typeof patch.prices === 'object') {
    const clean: Record<string, Partial<import('./types.js').Price>> = {};
    for (const [id, v] of Object.entries(patch.prices as Record<string, unknown>)) {
      if (!/^[a-z0-9][a-z0-9.\-]*$/i.test(id) || !v || typeof v !== 'object') continue;
      const e: Record<string, number> = {};
      for (const f of ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'] as const) {
        const n = num((v as Record<string, unknown>)[f], 0, 1000);
        if (n !== undefined) e[f] = n;
      }
      const ctx = num((v as Record<string, unknown>).context, 1000, 100_000_000);
      if (ctx !== undefined) e.context = Math.round(ctx);
      if (Object.keys(e).length) clean[id] = e;
    }
    out.prices = clean;
  }
  if ('timeZone' in patch) {
    const tz = patch.timeZone;
    let valid = false;
    if (typeof tz === 'string' && tz)
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        valid = true;
      } catch {
        /* not a zone */
      }
    out.timeZone = valid ? (tz as string) : undefined;
  }
  if ('discount' in patch) out.discount = patch.discount == null ? undefined : num(patch.discount, 0, 0.95);
  if ('modelDiscounts' in patch) {
    const md = patch.modelDiscounts;
    if (md == null) out.modelDiscounts = undefined;
    else if (typeof md === 'object') {
      const clean: Record<string, number> = {};
      for (const [k, v] of Object.entries(md as Record<string, unknown>)) {
        const d = num(v, 0, 0.95);
        if (/^[a-z0-9.\-]+$/i.test(k) && d !== undefined) clean[k] = d;
      }
      out.modelDiscounts = Object.keys(clean).length ? clean : undefined;
    }
  }
  return out;
}

/** Merge a patch into the settings file (keys set to undefined are removed) and return the result. */
export function saveSettings(path: string, current: Settings, patch: Partial<Settings>): Settings {
  const next: Settings = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (next as Record<string, unknown>)[k];
    else (next as Record<string, unknown>)[k] = v;
  }
  writeFileAtomic(path, JSON.stringify(next, null, 2) + '\n');
  return next;
}

/** Write to a temp file, then rename: another shell reading at that instant sees the old or the new file, never half. */
export function writeFileAtomic(path: string, data: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** The billing period containing `now`, starting on `startDay` of the month. Local dates, YYYY-MM-DD. */
export function billingPeriod(now: Date, startDay = 1): { start: string; end: string; daysElapsed: number; days: number } {
  const d = Math.min(Math.max(Math.round(startDay), 1), 28);
  let start = new Date(now.getFullYear(), now.getMonth(), d);
  if (start > now) start = new Date(now.getFullYear(), now.getMonth() - 1, d);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, d);
  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const day = 86_400_000;
  return {
    start: iso(start),
    end: iso(new Date(end.getTime() - day)),
    days: Math.round((end.getTime() - start.getTime()) / day),
    daysElapsed: Math.floor((now.getTime() - start.getTime()) / day) + 1,
  };
}
