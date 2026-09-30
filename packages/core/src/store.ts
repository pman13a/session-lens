import { EventEmitter } from 'node:events';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DEFAULT_SETTINGS_PATH, writeFileAtomic } from './account.js';
import { TranscriptParser, type AgentMeta } from './parse.js';
import { Pricer } from './pricing.js';
import type { FileIndex, Rec, Request, Session, Settings } from './types.js';

/**
 * Claude Code's config directories, resolved the way Claude Code resolves them:
 * CLAUDE_CONFIG_DIR (comma-separated), else $XDG_CONFIG_HOME/claude, ~/.claude and ~/.config/claude.
 */
export function configDirs(): string[] {
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env) return env.split(',').map((d) => d.trim()).filter(Boolean);
  const xdg = process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'claude') : undefined;
  return [...new Set([xdg, join(homedir(), '.claude'), join(homedir(), '.config', 'claude')].filter((d): d is string => !!d))];
}

export function defaultRoots(): string[] {
  return configDirs()
    .map((d) => join(d, 'projects'))
    .filter((r) => existsSync(r));
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

/** A running Claude Code process, from `<configDir>/sessions/<pid>.json`. */
export interface LiveSession {
  pid: number;
  sessionId: string;
  entrypoint?: string;
  name?: string;
  cwd?: string;
}

/** Signal 0 checks existence without delivering anything; EPERM still means alive. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** Live sessions Claude Code registers for every surface. Only `*.json` is read; `*.key` files are left alone. */
export function readLiveSessions(configDir: string): LiveSession[] {
  const dir = join(configDir, 'sessions');
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out: LiveSession[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (typeof j?.pid !== 'number' || typeof j?.sessionId !== 'string' || !isProcessAlive(j.pid)) continue;
      out.push({ pid: j.pid, sessionId: j.sessionId, entrypoint: j.entrypoint, name: j.name, cwd: j.cwd });
    } catch {
      /* half-written or gone */
    }
  }
  return out;
}

/** Claude Code deletes transcripts older than `cleanupPeriodDays` (30 by default). */
export function retentionDays(configDir: string): number {
  try {
    const v = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))?.cleanupPeriodDays;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  } catch {
    /* default */
  }
  return 30;
}

/** Where a file has been read to; only complete lines are consumed. */
interface Cursor {
  parser: TranscriptParser;
  offset: number;
  carry: Buffer;
  ino: number;
}

const CHUNK = 2 * 1024 * 1024;

/**
 * The index over every transcript.
 *
 * Files are followed, not re-read: each keeps a byte cursor, and a refresh reads only what was appended,
 * in 2 MB windows so a 100 MB transcript never lands in memory at once. `watch()` makes it live: fs.watch
 * on the transcript roots, the live-session registry and the settings file, backed by a stat poll (fs.watch
 * drops events on macOS and on network or virtualised filesystems). Each change emits `'change'`.
 */
export class Store extends EventEmitter {
  readonly roots: string[];
  pricer: Pricer;
  settings: Settings;
  files = new Map<string, FileIndex>();
  requests = new Map<string, Request>();
  sessions = new Map<string, Session>();
  live = new Map<string, LiveSession>();
  /** uuid → record, per file, for chain walks. */
  private byUuid = new Map<string, Map<string, Rec>>();
  private cursors = new Map<string, Cursor>();
  private lastScan = 0;
  /** Bumped on every rebuild so derived caches know to recompute. */
  version = 0;
  /** Bumped on anything a view should redraw for (data, live sessions, settings, reference figures). */
  changeId = 0;

  /** Where settings changes from the UI are saved; shared by every shell. */
  readonly settingsPath: string;
  private settingsMtime = 0;
  private referenceMtime = 0;
  private watchers: FSWatcher[] = [];
  private pollTimer?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;

  constructor(opts: { roots?: string[]; settings?: Settings; settingsPath?: string } = {}) {
    super();
    this.roots = opts.roots ?? defaultRoots();
    this.settingsPath = opts.settingsPath ?? DEFAULT_SETTINGS_PATH;
    this.settings = opts.settings ?? loadSettings(this.settingsPath);
    this.settingsMtime = opts.settings ? Infinity : mtime(this.settingsPath);
    this.referenceMtime = mtime(join(dirname(this.settingsPath), 'reference.json'));
    this.pricer = new Pricer(this.settings);
  }

  /** Config directories behind the roots: where the live-session registry and Claude Code's settings live. */
  get configDirs(): string[] {
    return [...new Set(this.roots.map((r) => dirname(r)))];
  }

  /** Oldest day Claude Code is still keeping transcripts for (local), given its cleanup setting. */
  get retention(): { days: number; since: number } {
    const days = Math.min(...this.configDirs.map(retentionDays), 30_000);
    return { days, since: Date.now() - days * 86_400_000 };
  }

  setSettings(settings: Settings) {
    this.settings = settings;
    this.pricer = new Pricer(settings);
    this.rebuild();
    this.bump();
  }

  /** Save a settings patch atomically, so another shell never reads a half-written file. */
  writeSettings(next: Settings) {
    writeFileAtomic(this.settingsPath, JSON.stringify(next, null, 2) + '\n');
    this.settingsMtime = mtime(this.settingsPath);
    this.setSettings(next);
  }

  private bump() {
    this.changeId++;
    this.emit('change', { changeId: this.changeId, version: this.version });
  }

  /** Follow every source live until close(). Safe to call once. */
  watch(pollMs = 2000): this {
    if (this.pollTimer) return this;
    const kick = () => this.schedule();
    const targets = [...this.roots, ...this.configDirs.map((d) => join(d, 'sessions')), dirname(this.settingsPath)];
    for (const t of targets) {
      try {
        const w = watch(t, { recursive: t !== dirname(this.settingsPath) }, kick);
        w.on('error', () => w.close());
        this.watchers.push(w);
      } catch {
        /* missing, or recursive unsupported: the poll covers it */
      }
    }
    this.pollTimer = setInterval(kick, pollMs);
    this.pollTimer.unref?.();
    this.tick();
    return this;
  }

  close() {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounce) clearTimeout(this.debounce);
    this.pollTimer = undefined;
  }

  private schedule() {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this.tick();
    }, 250);
    this.debounce.unref?.();
  }

  /** One pass over every source; emits 'change' if anything moved. */
  tick(): boolean {
    let changed = false;
    let data = false;
    // Settings edited by another shell (or by hand).
    const sm = mtime(this.settingsPath);
    if (this.settingsMtime !== Infinity && sm !== this.settingsMtime) {
      this.settingsMtime = sm;
      this.settings = loadSettings(this.settingsPath);
      this.pricer = new Pricer(this.settings);
      this.lastScan = 0;
      this.refresh(0, true);
      changed = true;
    }
    const rm = mtime(join(dirname(this.settingsPath), 'reference.json'));
    if (rm !== this.referenceMtime) {
      this.referenceMtime = rm;
      changed = true;
    }
    if (this.refresh(0)) data = true; // refresh() already announced it
    if (this.refreshLive()) changed = true;
    if (changed && !data) this.bump();
    return changed || data;
  }

  private refreshLive(): boolean {
    const next = new Map<string, LiveSession>();
    for (const d of this.configDirs) for (const l of readLiveSessions(d)) next.set(l.sessionId, l);
    const same = next.size === this.live.size && [...next.keys()].every((k) => this.live.get(k)?.pid === next.get(k)!.pid);
    this.live = next;
    return !same;
  }

  /** Read what was appended since the last pass (at most once per `minIntervalMs`). True if anything changed. */
  refresh(minIntervalMs = 2000, force = false): boolean {
    const now = Date.now();
    if (!force && now - this.lastScan < minIntervalMs && this.files.size) return false;
    this.lastScan = now;
    let changed = false;
    const present = new Set<string>();
    for (const root of this.roots) {
      for (const path of listTranscripts(root)) {
        present.add(path);
        if (this.follow(path)) changed = true;
      }
    }
    for (const path of [...this.files.keys()]) {
      if (!present.has(path)) {
        this.files.delete(path);
        this.byUuid.delete(path);
        this.cursors.delete(path);
        changed = true;
      }
    }
    if (changed || force || !this.sessions.size) this.rebuild();
    // Whoever notices new data first (the watcher or an API call) tells every listener.
    if (changed) this.bump();
    return changed;
  }

  /** Feed a file's new complete lines to its parser. Starts over if the file shrank or was replaced. */
  private follow(path: string): boolean {
    let st;
    try {
      st = statSync(path);
    } catch {
      return false;
    }
    let cur = this.cursors.get(path);
    if (cur && (st.size < cur.offset || st.ino !== cur.ino)) cur = undefined;
    if (cur && st.size === cur.offset) return false;
    if (!cur) {
      let meta: AgentMeta | undefined;
      const metaPath = path.replace(/\.jsonl$/, '.meta.json');
      if (existsSync(metaPath)) {
        try {
          meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        } catch {
          /* ignore */
        }
      }
      cur = { parser: new TranscriptParser(path, st, meta), offset: 0, carry: Buffer.alloc(0), ino: st.ino };
      this.cursors.set(path, cur);
      this.files.set(path, cur.parser.idx);
      this.byUuid.set(path, new Map());
    }
    const before = cur.parser.idx.records.length;
    const map = this.byUuid.get(path)!;
    let fd: number | undefined;
    try {
      fd = openSync(path, 'r');
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, st.size - cur.offset));
      while (cur.offset < st.size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, st.size - cur.offset), cur.offset);
        if (n <= 0) break;
        // Split on newline bytes, never mid-character: every emitted line is complete UTF-8.
        const data = cur.carry.length ? Buffer.concat([cur.carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        const base = cur.offset - cur.carry.length;
        let start = 0;
        for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, start)) {
          cur.parser.feed(data.toString('utf8', start, i), base + start, i - start);
          start = i + 1;
        }
        cur.carry = Buffer.from(data.subarray(start)); // a half-written last line waits for its newline
        cur.offset += n;
      }
    } catch {
      /* vanished mid-read: next pass */
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const idx = cur.parser.idx;
    idx.size = st.size;
    idx.mtimeMs = st.mtimeMs;
    for (let i = before; i < idx.records.length; i++) map.set(idx.records[i].uuid, idx.records[i]);
    return true;
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
    /** Position of each request's first record in its file, for reconciling against checkpoints. */
    const position = new Map<string, number>();
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
          sideCost: 0,
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
      f.records.forEach((r, ri) => {
        if (r.type !== 'assistant' || !r.requestId || !r.usage || !r.model) return;
        const existing = this.requests.get(r.requestId);
        if (existing) {
          if (existing.file === f.path) {
            existing.uuids.push(r.uuid);
            for (const p of r.pieces) if (p.kind === 'tool_use' && !existing.tools.includes(p.label)) existing.tools.push(p.label);
            existing.usage = r.usage; // identical across a split response; the last is final
            existing.stopReason = r.stopReason ?? existing.stopReason;
          }
          return; // copied into a later file by a fork/resume: already counted
        }
        const price = this.pricer.price(r.model);
        const req: Request = {
          id: r.requestId,
          sessionId: f.sessionId,
          agentId: f.agentId,
          file: f.path,
          ts: r.ts,
          model: r.model,
          usage: r.usage,
          cost: 0,
          side: 0,
          priced: true,
          contextTokens: 0,
          contextLimit: /\[1m\]$/.test(r.model) ? 1_000_000 : price.context,
          firstUuid: r.uuid,
          uuids: [r.uuid],
          promptId: nearestPrompt(r),
          tools: r.pieces.filter((p) => p.kind === 'tool_use').map((p) => p.label),
          stopReason: r.stopReason,
          entrypoint: r.entrypoint,
          role: f.agentId ? 'subagent' : 'iteration',
        };
        position.set(req.id, ri);
        this.requests.set(req.id, req);
        (sub ? sub.requestIds : s.requestIds).push(req.id);
      });
    }
    for (const req of this.requests.values()) {
      const u = req.usage;
      // Never guess a price: an unknown model is counted in tokens and left out of dollar totals.
      req.priced = this.pricer.isKnown(req.model);
      req.cost = req.priced ? this.pricer.cost(req.model, u) : 0;
      req.contextTokens = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
    }
    for (const s of this.sessions.values()) this.assignRoles(s);
    for (const [id, s] of this.sessions) {
      // A session whose every file was a fork copy has nothing of its own left; drop it.
      if (!s.requestIds.length && s.subagents.every((a) => !a.requestIds.length)) {
        this.sessions.delete(id);
        continue;
      }
      this.reconcile(s, position);
    }
  }

  /**
   * Tell your calls from Claude's own: walk back from each main-thread request to the user record that
   * made it happen. Your typed message → prompt; tool results → iteration; a background task or other
   * harness message → auto. An iteration that calls no tools ends the loop: that is the answer to you.
   */
  private assignRoles(s: Session) {
    const main = s.requestIds.map((id) => this.requests.get(id)!).filter(Boolean);
    // Transcripts older than `origin` tags: treat any plain typed text as yours.
    const legacy = new Map<string, boolean>();
    const isLegacy = (file: string) => {
      if (!legacy.has(file)) legacy.set(file, !(this.files.get(file)?.records.some((r) => r.origin) ?? false));
      return legacy.get(file)!;
    };
    for (const r of main) {
      const t = this.triggerOf(r, isLegacy(r.file));
      r.role = t.role;
      r.trigger = t.trigger;
    }
    // An iteration that calls no tools has nothing left to iterate on: it is the reply to you.
    for (const r of main) if (r.role === 'iteration' && !r.tools.length) r.role = 'answer';
    for (const a of s.subagents) {
      if (!a.toolUseId) continue;
      a.launchedBy = main.find((r) => r.uuids.some((u) => this.record(r.file, u)?.pieces.some((p) => p.toolUseId === a.toolUseId)))?.id;
    }
  }

  private triggerOf(r: Request, legacy: boolean): { role: Request['role']; trigger?: string[] } {
    let cur = this.record(r.file, r.firstUuid);
    cur = cur?.parentUuid ? this.record(r.file, cur.parentUuid) : undefined;
    for (let hops = 0; cur && hops < 500; hops++) {
      if (cur.type === 'assistant' && cur.requestId !== r.id) return { role: 'auto' }; // nothing from anyone in between
      if (cur.type === 'user') {
        const results = cur.pieces.filter((p) => p.kind === 'tool_result');
        if (results.length) return { role: 'iteration', trigger: [...new Set(results.map((p) => p.toolName ?? p.label))] };
        if (cur.isHuman) return { role: 'prompt' };
        if (cur.origin) return { role: 'auto', trigger: [cur.origin] };
        if (cur.pieces.some((p) => p.kind === 'compact_summary')) return { role: 'auto', trigger: ['compaction'] };
        if (legacy && !cur.isMeta && cur.pieces.some((p) => p.kind === 'meta' || p.kind === 'prompt')) return { role: 'prompt' };
        // Harness text that follows your message (a command's expansion, a skill body): keep walking to it.
      }
      cur = cur.parentUuid ? this.record(r.file, cur.parentUuid) : undefined;
    }
    return { role: 'auto' };
  }

  /**
   * Claude Code writes its own running cost (`cost-state`) into the transcript now and then. It includes
   * calls it never writes as records: title generation, safety checks, fetch summaries. At the last
   * checkpoint, the difference between that figure and what the records add up to is those side calls.
   * Spread it over the requests before the checkpoint so days and totals include it.
   */
  private reconcile(s: Session, position: Map<string, number>) {
    const f = s.mainFile ? this.files.get(s.mainFile) : undefined;
    const cp = f?.costCheckpoint;
    if (!cp) return;
    const before = this.sessionRequests(s).filter((r) => (r.agentId ? r.ts <= cp.ts : (position.get(r.id) ?? Infinity) < cp.recordCount));
    if (!before.length || before.some((r) => !r.priced)) return;
    const list = before.reduce((a, r) => a + this.pricer.listCost(r.model, r.usage), 0);
    const gap = cp.totalUSD - list;
    // Only a plausible gap is side calls; a large one means Claude Code priced differently.
    if (gap <= 0.005 || gap > list * 0.25) return;
    const factor = this.pricer.discountFactor(before[0].model);
    s.sideCost = gap * factor;
    s.checkpoint = { claudeCodeUSD: cp.totalUSD, transcriptUSD: list, ts: cp.ts };
    const total = before.reduce((a, r) => a + r.cost, 0) || 1;
    for (const r of before) r.side = (s.sideCost * r.cost) / total;
  }

  /** All requests of a session: main thread plus every subagent. */
  sessionRequests(s: Session): Request[] {
    const ids = [...s.requestIds, ...s.subagents.flatMap((a) => a.requestIds)];
    return ids.map((id) => this.requests.get(id)!).filter(Boolean).sort((a, b) => a.ts - b.ts);
  }

  /** The raw JSONL line of a record, read by byte range: no need to load the whole file. */
  readRecord(file: string, rec: Rec): string {
    let fd: number | undefined;
    try {
      fd = openSync(file, 'r');
      const buf = Buffer.alloc(rec.len);
      readSync(fd, buf, 0, rec.len, rec.offset);
      return buf.toString('utf8');
    } catch {
      return '';
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export { writeFileAtomic };
