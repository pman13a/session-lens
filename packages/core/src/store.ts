import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DEFAULT_SETTINGS_PATH } from './account.js';
import { parseTranscript, type AgentMeta } from './parse.js';
import { Pricer } from './pricing.js';
import type { FileIndex, Rec, Request, Session, Settings } from './types.js';

export function defaultRoots(): string[] {
  const env = process.env.CLAUDE_CONFIG_DIR;
  const roots = (env ? env.split(',') : [join(homedir(), '.claude'), join(homedir(), '.config', 'claude')]).map((r) =>
    join(r.trim(), 'projects'),
  );
  return roots.filter((r) => existsSync(r));
}

export function loadSettings(path = DEFAULT_SETTINGS_PATH): Settings {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Settings;
  } catch {
    return {};
  }
}

function listTranscripts(root: string): string[] {
  const out: string[] = [];
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return out;
  }
  for (const p of projects) {
    const pdir = join(root, p);
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(pdir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(join(pdir, e.name));
      else if (e.isDirectory()) {
        const sub = join(pdir, e.name, 'subagents');
        try {
          for (const f of readdirSync(sub)) if (f.endsWith('.jsonl')) out.push(join(sub, f));
        } catch {
          /* no subagents */
        }
      }
    }
  }
  return out;
}

/** `-home-user-my-repo` → `my-repo`; prefer the real cwd when a record carried one. */
export function projectName(file: FileIndex, projectDir: string): string {
  if (file.cwd) return basename(file.cwd) || file.cwd;
  return projectDir.replace(/^-/, '').split('-').filter(Boolean).pop() ?? projectDir;
}

/**
 * The in-memory index over every transcript. Refresh re-parses only files whose size or mtime changed,
 * then rebuilds the request/session maps (cheap: no file IO).
 */
export class Store {
  readonly roots: string[];
  pricer: Pricer;
  settings: Settings;
  files = new Map<string, FileIndex>();
  requests = new Map<string, Request>();
  sessions = new Map<string, Session>();
  /** uuid → record, per file, for chain walks. */
  private byUuid = new Map<string, Map<string, Rec>>();
  private lastScan = 0;
  /** Bumped on every rebuild so derived caches know to recompute. */
  version = 0;

  /** Where settings changes from the UI are saved; shared by every shell. */
  readonly settingsPath: string;

  constructor(opts: { roots?: string[]; settings?: Settings; settingsPath?: string } = {}) {
    this.roots = opts.roots ?? defaultRoots();
    this.settingsPath = opts.settingsPath ?? DEFAULT_SETTINGS_PATH;
    this.settings = opts.settings ?? loadSettings(this.settingsPath);
    this.pricer = new Pricer(this.settings);
  }

  setSettings(settings: Settings) {
    this.settings = settings;
    this.pricer = new Pricer(settings);
    this.rebuild();
  }

  /** Re-scan at most once per `minIntervalMs`. Returns true when anything changed. */
  refresh(minIntervalMs = 2000): boolean {
    const now = Date.now();
    if (now - this.lastScan < minIntervalMs && this.files.size) return false;
    this.lastScan = now;
    let changed = false;
    const present = new Set<string>();
    for (const root of this.roots) {
      for (const path of listTranscripts(root)) {
        present.add(path);
        let st;
        try {
          st = statSync(path);
        } catch {
          continue;
        }
        const old = this.files.get(path);
        if (old && old.size === st.size && old.mtimeMs === st.mtimeMs) continue;
        const text = readFileSync(path, 'utf8');
        let meta: AgentMeta | undefined;
        const metaPath = path.replace(/\.jsonl$/, '.meta.json');
        if (existsSync(metaPath)) {
          try {
            meta = JSON.parse(readFileSync(metaPath, 'utf8'));
          } catch {
            /* ignore */
          }
        }
        const idx = parseTranscript(path, text, st, meta);
        this.files.set(path, idx);
        this.byUuid.set(path, new Map(idx.records.map((r) => [r.uuid, r])));
        changed = true;
      }
    }
    for (const path of [...this.files.keys()]) {
      if (!present.has(path)) {
        this.files.delete(path);
        this.byUuid.delete(path);
        changed = true;
      }
    }
    if (changed || !this.sessions.size) this.rebuild();
    return changed;
  }

  record(file: string, uuid: string): Rec | undefined {
    return this.byUuid.get(file)?.get(uuid);
  }

  /** Walk parentUuid links from `uuid` (exclusive) back to the root or a compaction boundary. */
  chain(file: string, fromUuid: string): Rec[] {
    const map = this.byUuid.get(file);
    if (!map) return [];
    const out: Rec[] = [];
    const guard = new Set<string>();
    let cur = map.get(fromUuid)?.parentUuid ?? null;
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      const r = map.get(cur);
      if (!r) break;
      out.push(r);
      cur = r.parentUuid;
    }
    return out.reverse();
  }

  /** Rebuild sessions and requests from the parsed files. Request ids are deduplicated across ALL files. */
  private rebuild() {
    this.version++;
    this.requests.clear();
    this.sessions.clear();
    // Oldest file first: a forked or resumed session copies its parent's history (timestamps included)
    // into a new file, so the first file to carry a request id is its real owner. On a tie the parent is
    // the one that ends first, since the fork carries on past it. Main transcripts before subagents.
    const files = [...this.files.values()].sort(
      (a, b) => a.firstTs - b.firstTs || Number(!!a.agentId) - Number(!!b.agentId) || a.lastTs - b.lastTs || a.mtimeMs - b.mtimeMs,
    );
    for (const f of files) {
      const projectDir = basename(f.agentId ? join(f.path, '../../..') : join(f.path, '..'));
      let s = this.sessions.get(f.sessionId);
      if (!s) {
        s = {
          id: f.sessionId,
          project: projectName(f, projectDir),
          cwd: f.cwd,
          title: f.title ?? '(untitled)',
          firstTs: f.firstTs,
          lastTs: f.lastTs,
          files: [],
          requestIds: [],
          subagents: [],
        };
        this.sessions.set(f.sessionId, s);
      }
      s.files.push(f.path);
      if (!f.agentId) {
        s.mainFile = f.path;
        if (f.title) s.title = f.title;
        if (f.cwd) {
          s.cwd = f.cwd;
          s.project = projectName(f, projectDir);
        }
        if (f.reportedCostUSD != null) s.reportedCostUSD = f.reportedCostUSD;
      }
      s.firstTs = Math.min(s.firstTs || f.firstTs, f.firstTs);
      s.lastTs = Math.max(s.lastTs, f.lastTs);
      const sub = f.agentId
        ? { agentId: f.agentId, agentType: f.agentType, description: f.agentDescription, toolUseId: f.agentToolUseId, requestIds: [] as string[] }
        : undefined;
      if (sub) s.subagents.push(sub);

      // Group this file's assistant records by request id; one response is written as several records.
      const promptOf = new Map<string, string | undefined>();
      const nearestPrompt = (r: Rec): string | undefined => {
        let cur: Rec | undefined = r;
        const walked: Rec[] = [];
        while (cur) {
          if (promptOf.has(cur.uuid)) {
            const p = promptOf.get(cur.uuid);
            for (const w of walked) promptOf.set(w.uuid, p);
            return p;
          }
          walked.push(cur);
          if (cur.type === 'user' && cur.promptId) {
            for (const w of walked) promptOf.set(w.uuid, cur.promptId);
            return cur.promptId;
          }
          cur = cur.parentUuid ? this.record(f.path, cur.parentUuid) : undefined;
        }
        for (const w of walked) promptOf.set(w.uuid, undefined);
        return undefined;
      };
      for (const r of f.records) {
        if (r.type !== 'assistant' || !r.requestId || !r.usage || !r.model) continue;
        const existing = this.requests.get(r.requestId);
        if (existing) {
          if (existing.file === f.path) {
            existing.uuids.push(r.uuid);
            for (const p of r.pieces) if (p.kind === 'tool_use' && !existing.tools.includes(p.label)) existing.tools.push(p.label);
            existing.usage = r.usage; // identical across a split response; the last is final
            existing.stopReason = r.stopReason ?? existing.stopReason;
          }
          continue; // copied into a later file by a fork/resume: already counted
        }
        const price = this.pricer.price(r.model);
        const u = r.usage;
        const req: Request = {
          id: r.requestId,
          sessionId: f.sessionId,
          agentId: f.agentId,
          file: f.path,
          ts: r.ts,
          model: r.model,
          usage: u,
          cost: 0,
          contextTokens: 0,
          contextLimit: /\[1m\]$/.test(r.model) ? 1_000_000 : price.context,
          firstUuid: r.uuid,
          uuids: [r.uuid],
          promptId: nearestPrompt(r),
          tools: r.pieces.filter((p) => p.kind === 'tool_use').map((p) => p.label),
          stopReason: r.stopReason,
        };
        this.requests.set(req.id, req);
        (sub ? sub.requestIds : s.requestIds).push(req.id);
      }
    }
    for (const req of this.requests.values()) {
      const u = req.usage;
      req.cost = this.pricer.cost(req.model, u);
      req.contextTokens = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
    }
    // A session whose every file was a fork copy has nothing of its own left; drop it.
    for (const [id, s] of this.sessions) {
      if (!s.requestIds.length && s.subagents.every((a) => !a.requestIds.length)) this.sessions.delete(id);
    }
  }

  /** All requests of a session: main thread plus every subagent. */
  sessionRequests(s: Session): Request[] {
    const ids = [...s.requestIds, ...s.subagents.flatMap((a) => a.requestIds)];
    return ids.map((id) => this.requests.get(id)!).filter(Boolean).sort((a, b) => a.ts - b.ts);
  }

  readLine(file: string, line: number): string {
    const lines = readFileSync(file, 'utf8').split('\n');
    return lines[line] ?? '';
  }
}
