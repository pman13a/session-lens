#!/usr/bin/env node

// apps/server/src/cli.ts
import { spawn } from "node:child_process";
import { existsSync as existsSync2 } from "node:fs";
import { dirname as dirname6, join as join6 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// packages/core/dist/types.js
var ROLE_LABEL = {
  prompt: "Your prompts",
  iteration: "Claude iterating on tool results",
  answer: "Final answers to you",
  subagent: "Subagents",
  auto: "Automatic (background tasks, compaction)"
};

// packages/core/dist/pricing.js
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
function bundledPricing() {
  return loadBundled();
}
function deriveCache(input) {
  return { cacheWrite5m: input * 1.25, cacheWrite1h: input * 2, cacheRead: input * 0.1 };
}
var bundled;
function loadBundled() {
  if (bundled)
    return bundled;
  const here2 = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here2, "pricing.json"), join(here2, "../../../config/pricing.json")]) {
    try {
      bundled = JSON.parse(readFileSync(p, "utf8"));
      return bundled;
    } catch {
    }
  }
  throw new Error("pricing.json not found");
}
function normalizeModel(model) {
  return model.replace(/\[.*?\]$/, "").replace(/-\d{8}$/, "").replace(/^anthropic\./, "");
}
var Pricer = class {
  models;
  fallback;
  webSearch;
  usGeo;
  discount;
  cache = /* @__PURE__ */ new Map();
  /** Per model id: which layer its effective price came from. */
  sources = {};
  constructor(settings = {}, file = loadBundled()) {
    this.models = { ...file.models };
    for (const id of Object.keys(file.models))
      this.sources[id] = "bundled";
    for (const [id, p] of Object.entries(settings.published?.models ?? {})) {
      this.models[id] = { ...this.models[id] ?? { ...file.fallback }, ...p };
      this.sources[id] = "anthropic";
    }
    for (const [id, p] of Object.entries(settings.prices ?? {})) {
      const base = this.models[id] ?? (p.input != null ? { ...file.fallback, ...deriveCache(p.input) } : { ...file.fallback });
      this.models[id] = { ...base, ...p };
      this.sources[id] = "custom";
    }
    this.fallback = file.fallback;
    this.webSearch = file.webSearchPerRequest;
    this.usGeo = file.usGeoMultiplier ?? 1.1;
    this.discount = clampDiscount(settings.discount) ?? 0;
    this.modelDiscounts = Object.entries(settings.modelDiscounts ?? {}).map(([k, v]) => [normalizeModel(k), clampDiscount(v)]).filter((e) => e[1] !== void 0).sort((a, b) => b[0].length - a[0].length);
  }
  modelDiscounts;
  /** 1 − the discount that applies to this model (a per-model rate beats the default). */
  discountFactor(model) {
    const id = normalizeModel(model);
    const hit = this.modelDiscounts.find(([k]) => id === k || id.startsWith(k + "-"));
    return 1 - (hit ? hit[1] : this.discount);
  }
  /**
   * List-price dollars per component. Includes compaction iterations, fast-mode rates (cache prices
   * scale with input) and the US-only inference multiplier, all of which stack.
   */
  listParts(model, u) {
    const p = this.price(model);
    const fin = u.fast && p.fast ? p.fast.input / p.input : 1;
    const fout = u.fast && p.fast ? p.fast.output / p.output : 1;
    const geo = u.usOnly ? this.usGeo : 1;
    const t = { input: u.input, cacheWrite5m: u.cacheWrite5m, cacheWrite1h: u.cacheWrite1h, cacheRead: u.cacheRead, output: u.output };
    if (u.compaction)
      for (const k of Object.keys(t))
        t[k] += u.compaction[k];
    const inK = fin * geo / 1e6;
    return {
      input: t.input * p.input * inK + u.webSearches * this.webSearch,
      cacheWrite: (t.cacheWrite5m * p.cacheWrite5m + t.cacheWrite1h * p.cacheWrite1h) * inK,
      cacheRead: t.cacheRead * p.cacheRead * inK,
      output: t.output * p.output * fout * geo / 1e6
    };
  }
  /** Cost at list price, before any discount: what Claude Code's own tally reports. */
  listCost(model, u) {
    const x = this.listParts(model, u);
    return x.input + x.cacheWrite + x.cacheRead + x.output;
  }
  /** Longest-prefix match, so `claude-opus-4-1` falls to `claude-opus-4` and `claude-opus-5-5` beats `claude-opus-5`. */
  price(model) {
    const hit = this.cache.get(model);
    if (hit)
      return hit;
    const id = normalizeModel(model);
    let best;
    for (const key of Object.keys(this.models)) {
      if ((id === key || id.startsWith(key + "-")) && (!best || key.length > best.length))
        best = key;
    }
    const p = best ? this.models[best] : this.fallback;
    this.cache.set(model, p);
    return p;
  }
  /** Every model id with a price, and where it came from. */
  table() {
    return Object.entries(this.models).map(([id, price]) => ({ id, price, source: this.sources[id] ?? "bundled" })).sort((a, b) => a.id.localeCompare(b.id));
  }
  /** The id key that prices this model (longest prefix), if any. */
  keyFor(model) {
    const id = normalizeModel(model);
    let best;
    for (const key of Object.keys(this.models))
      if ((id === key || id.startsWith(key + "-")) && (!best || key.length > best.length))
        best = key;
    return best;
  }
  isKnown(model) {
    const id = normalizeModel(model);
    return Object.keys(this.models).some((k) => id === k || id.startsWith(k + "-"));
  }
  /** Dollars per usage component, discount applied. Web searches ride with input. */
  costParts(model, u) {
    const x = this.listParts(model, u);
    const k = this.discountFactor(model);
    return { input: x.input * k, cacheWrite: x.cacheWrite * k, cacheRead: x.cacheRead * k, output: x.output * k };
  }
  cost(model, u) {
    return this.listCost(model, u) * this.discountFactor(model);
  }
};
function clampDiscount(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 0.95 ? v : void 0;
}

// packages/core/dist/published.js
var PRICING_PAGE = "https://platform.claude.com/docs/en/about-claude/pricing";
function modelIdFromName(name) {
  const m = /^Claude\s+([A-Za-z]+)\s+(\d+)(?:\.(\d+))?$/.exec(name.trim());
  if (!m)
    return void 0;
  const family = m[1].toLowerCase();
  const version = m[3] ? `${m[2]}-${m[3]}` : m[2];
  return Number(m[2]) < 4 ? `claude-${version}-${family}` : `claude-${family}-${version}`;
}
var money = (cell) => {
  const m = /\$\s*([\d,]+(?:\.\d+)?)/.exec(cell);
  return m ? Number(m[1].replace(/,/g, "")) : void 0;
};
function parsePricingMarkdown(md) {
  const start2 = md.search(/^##\s+Model pricing\s*$/m);
  if (start2 < 0)
    return [];
  const lines = md.slice(start2).split("\n");
  const out = [];
  let header;
  for (const line of lines.slice(1)) {
    if (/^##\s/.test(line))
      break;
    if (!line.startsWith("|")) {
      if (out.length)
        break;
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (!header) {
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c)))
      continue;
    const col = (re) => header.findIndex((h) => re.test(h));
    const iName = col(/^model/);
    const vals = {
      input: money(cells[col(/base input/)] ?? ""),
      cacheWrite5m: money(cells[col(/5m cache/)] ?? ""),
      cacheWrite1h: money(cells[col(/1h cache/)] ?? ""),
      cacheRead: money(cells[col(/cache hits|cache read/)] ?? ""),
      output: money(cells[col(/^output/)] ?? "")
    };
    const rawName = cells[iName] ?? "";
    const note = /\(([^)]*?)\]?\(/.exec(rawName)?.[1]?.replace(/^\[/, "");
    const name = rawName.replace(/\s*\(.*$/, "").trim();
    const id = modelIdFromName(name);
    const { input, cacheWrite5m, cacheWrite1h, cacheRead, output } = vals;
    if (!id || input === void 0 || cacheWrite5m === void 0 || cacheWrite1h === void 0 || cacheRead === void 0 || output === void 0)
      continue;
    out.push({ id, name, input, cacheWrite5m, cacheWrite1h, cacheRead, output, note });
  }
  return out;
}
async function fetchPublishedPricing(fetchImpl = fetch) {
  const url2 = `${PRICING_PAGE}.md`;
  const res = await fetchImpl(url2, { headers: { accept: "text/markdown" } });
  if (!res.ok)
    throw new Error(`Anthropic's pricing page answered ${res.status}`);
  const models = parsePricingMarkdown(await res.text());
  if (!models.length)
    throw new Error("Could not find the model price table on the pricing page; it may have changed shape.");
  return { models, fetchedAt: (/* @__PURE__ */ new Date()).toISOString(), url: PRICING_PAGE };
}
function comparePrices(published, effective) {
  const FIELDS = ["input", "cacheWrite5m", "cacheWrite1h", "cacheRead", "output"];
  return published.map((p) => {
    const cur = effective(p.id);
    const changed = cur.known ? FIELDS.filter((f) => Math.abs(cur.price[f] - p[f]) > 1e-9) : [...FIELDS];
    return { ...p, status: !cur.known ? "new" : changed.length ? "changed" : "same", changed, current: cur.known ? cur.price : void 0 };
  });
}

// packages/core/dist/parse.js
import { basename, dirname as dirname2 } from "node:path";
var IMAGE_CHARS = 6e3;
function textOf(content) {
  if (content == null)
    return "";
  if (typeof content === "string")
    return content;
  if (Array.isArray(content))
    return content.map((c) => typeof c === "string" ? c : c?.text ?? "").join("\n");
  return typeof content.text === "string" ? content.text : "";
}
function oneLine(s, n) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "\u2026" : t;
}
function toolDetail(name, input) {
  if (!input || typeof input !== "object")
    return void 0;
  const pick = input.file_path ?? input.notebook_path ?? input.path ?? input.url ?? input.pattern ?? input.query ?? input.description ?? input.command ?? input.prompt ?? input.skill ?? Object.values(input).find((v) => typeof v === "string");
  return typeof pick === "string" ? oneLine(pick, 120) : void 0;
}
function tokens(u) {
  const cc = u?.cache_creation;
  const write = u?.cache_creation_input_tokens ?? 0;
  const w1h = cc?.ephemeral_1h_input_tokens ?? 0;
  const w5m = cc ? cc.ephemeral_5m_input_tokens ?? Math.max(write - w1h, 0) : write;
  return { input: u?.input_tokens ?? 0, cacheWrite5m: w5m, cacheWrite1h: w1h, cacheRead: u?.cache_read_input_tokens ?? 0, output: u?.output_tokens ?? 0 };
}
function parseUsage(u) {
  const out = {
    ...tokens(u),
    thinking: u?.output_tokens_details?.thinking_tokens ?? 0,
    webSearches: u?.server_tool_use?.web_search_requests ?? 0
  };
  if (u?.speed === "fast")
    out.fast = true;
  if (u?.inference_geo === "us")
    out.usOnly = true;
  if (Array.isArray(u?.iterations)) {
    for (const it of u.iterations) {
      if (it?.type !== "compaction")
        continue;
      const t = tokens(it);
      const c = out.compaction ??= { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
      c.input += t.input;
      c.cacheWrite5m += t.cacheWrite5m;
      c.cacheWrite1h += t.cacheWrite1h;
      c.cacheRead += t.cacheRead;
      c.output += t.output;
    }
  }
  return out;
}
function userPieces(d, toolNames) {
  const c = d.message?.content;
  const pieces = [];
  const human = d.origin?.kind === "human" || d.turnOrigin === "human";
  const kindForText = d.isCompactSummary ? "compact_summary" : d.isMeta || !human ? "meta" : "prompt";
  if (typeof c === "string") {
    pieces.push({ kind: kindForText, label: oneLine(c, 80) || "(empty)", chars: c.length, block: 0 });
    return pieces;
  }
  if (!Array.isArray(c))
    return pieces;
  c.forEach((b, i) => {
    if (b?.type === "text") {
      pieces.push({ kind: kindForText, label: oneLine(b.text ?? "", 80), chars: (b.text ?? "").length, block: i });
    } else if (b?.type === "tool_result") {
      const src = toolNames.get(b.tool_use_id);
      const inner = b.content;
      let chars = 0;
      let images = 0;
      if (typeof inner === "string")
        chars = inner.length;
      else if (Array.isArray(inner))
        for (const x of inner) {
          if (x?.type === "image")
            images++;
          else
            chars += (x?.text ?? JSON.stringify(x)).length;
        }
      pieces.push({
        kind: "tool_result",
        label: src?.name ?? "tool result",
        detail: src?.detail,
        chars: chars + images * IMAGE_CHARS,
        block: i,
        toolUseId: b.tool_use_id,
        toolName: src?.name
      });
    } else if (b?.type === "image") {
      pieces.push({ kind: "image", label: "image", chars: IMAGE_CHARS, block: i });
    } else if (b?.type === "document") {
      const len = JSON.stringify(b.source ?? {}).length;
      pieces.push({ kind: "attachment", label: "document", chars: len, block: i });
    }
  });
  return pieces;
}
function assistantPieces(d, toolNames) {
  const c = d.message?.content;
  if (!Array.isArray(c))
    return [];
  const pieces = [];
  c.forEach((b, i) => {
    if (b?.type === "text") {
      pieces.push({ kind: "text", label: oneLine(b.text ?? "", 80) || "(empty)", chars: (b.text ?? "").length, block: i });
    } else if (b?.type === "thinking" || b?.type === "redacted_thinking") {
      const t = b.thinking ?? "";
      pieces.push({ kind: "thinking", label: t ? oneLine(t, 80) : "thinking (not displayed)", chars: t.length, block: i });
    } else if (b?.type === "tool_use" || b?.type === "server_tool_use") {
      const detail = toolDetail(b.name, b.input);
      toolNames.set(b.id, { name: b.name, detail });
      pieces.push({
        kind: "tool_use",
        label: b.name,
        detail,
        chars: (b.name?.length ?? 0) + JSON.stringify(b.input ?? {}).length,
        block: i,
        toolUseId: b.id,
        toolName: b.name
      });
    } else if (typeof b?.type === "string" && b.type.endsWith("_tool_result")) {
      pieces.push({ kind: "tool_result", label: b.type, chars: JSON.stringify(b.content ?? "").length, block: i });
    }
  });
  return pieces;
}
function attachmentPieces(d) {
  const r = d.rendered;
  if (!Array.isArray(r) || r.length === 0)
    return [];
  const text = r.map((x) => x?.content ?? "").join("\n");
  if (!text)
    return [];
  const type = d.attachment?.type ?? "attachment";
  return [{ kind: "attachment", label: type, detail: oneLine(text.replace(/<\/?system-reminder>/g, ""), 100), chars: text.length, block: 0 }];
}
function skillsIn(d, rec) {
  const out = [];
  if (rec.type === "assistant") {
    for (const p of rec.pieces)
      if (p.kind === "tool_use" && p.label === "Skill" && p.detail)
        out.push(p.detail);
  } else if (rec.type === "user") {
    const text = textOf(d.message?.content);
    for (const m of text.matchAll(/<command-name>\/?([^<\s]+)<\/command-name>/g))
      out.push(m[1]);
  }
  return out;
}
function locate(path) {
  const name = basename(path, ".jsonl");
  if (basename(dirname2(path)) === "subagents") {
    return { sessionId: basename(dirname2(dirname2(path))), agentId: name.replace(/^agent-/, "") };
  }
  return { sessionId: name };
}
var TranscriptParser = class {
  idx;
  toolNames = /* @__PURE__ */ new Map();
  seen = /* @__PURE__ */ new Set();
  firstPrompt;
  titled = false;
  constructor(path, stat, meta) {
    const loc = locate(path);
    this.idx = {
      path,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sessionId: loc.sessionId,
      agentId: loc.agentId,
      agentType: meta?.agentType,
      agentDescription: meta?.description,
      agentToolUseId: meta?.toolUseId,
      firstTs: 0,
      lastTs: 0,
      records: []
    };
  }
  /** One complete JSONL line and where it sits in the file (bytes). */
  feed(raw, offset, len) {
    const idx = this.idx;
    if (!raw.trim())
      return;
    let d;
    try {
      d = JSON.parse(raw);
    } catch {
      return;
    }
    const type = d.type;
    if (type === "ai-title" && d.aiTitle) {
      idx.title = d.aiTitle;
      this.titled = true;
    } else if (type === "custom-title" && d.customTitle) {
      idx.title = d.customTitle;
      this.titled = true;
    } else if (type === "summary" && d.summary && !this.titled) {
      idx.title = d.summary;
      this.titled = true;
    } else if (type === "cost-state" && typeof d.totalCostUSD === "number") {
      idx.reportedCostUSD = d.totalCostUSD;
      idx.costCheckpoint = { totalUSD: d.totalCostUSD, recordCount: idx.records.length, ts: idx.lastTs };
      (idx.costCheckpoints ??= []).push(idx.costCheckpoint);
    }
    if (type !== "user" && type !== "assistant" && type !== "attachment" && type !== "system")
      return;
    if (!d.uuid || this.seen.has(d.uuid))
      return;
    this.seen.add(d.uuid);
    const ts = Date.parse(d.timestamp);
    if (!Number.isFinite(ts))
      return;
    if (!idx.cwd && d.cwd)
      idx.cwd = d.cwd;
    idx.firstTs = idx.firstTs ? Math.min(idx.firstTs, ts) : ts;
    idx.lastTs = Math.max(idx.lastTs, ts);
    const rec = {
      uuid: d.uuid,
      parentUuid: d.parentUuid ?? null,
      type,
      ts,
      offset,
      len,
      promptId: d.promptId,
      entrypoint: d.entrypoint,
      pieces: []
    };
    if (type === "user") {
      rec.isMeta = !!d.isMeta;
      rec.isHuman = d.origin?.kind === "human" || d.turnOrigin === "human";
      if (typeof d.origin?.kind === "string")
        rec.origin = d.origin.kind;
      if (typeof d.permissionMode === "string")
        rec.permissionMode = d.permissionMode;
      rec.pieces = userPieces(d, this.toolNames);
      if (!this.firstPrompt && rec.isHuman && !rec.isMeta) {
        this.firstPrompt = textOf(d.message?.content);
        if (!this.titled && this.firstPrompt)
          idx.title = oneLine(this.firstPrompt, 90);
      }
    } else if (type === "assistant") {
      const m = d.message ?? {};
      rec.model = m.model;
      rec.requestId = d.requestId ?? (m.model === "<synthetic>" ? void 0 : m.id);
      if (m.usage && m.model !== "<synthetic>")
        rec.usage = parseUsage(m.usage);
      rec.pieces = assistantPieces(d, this.toolNames);
      rec.stopReason = m.stop_reason ?? void 0;
    } else if (type === "attachment") {
      rec.pieces = attachmentPieces(d);
    }
    const skills = skillsIn(d, rec);
    if (skills.length)
      rec.skills = skills;
    idx.records.push(rec);
  }
};
function blockText(line, block) {
  const d = JSON.parse(line);
  if (d.type === "attachment")
    return (d.rendered ?? []).map((x) => x?.content ?? "").join("\n");
  const c = d.message?.content;
  if (typeof c === "string")
    return c;
  const b = Array.isArray(c) ? c[block] : void 0;
  if (!b)
    return "";
  switch (b.type) {
    case "text":
      return b.text ?? "";
    case "thinking":
      return b.thinking || "(thinking content is not stored in the transcript)";
    case "redacted_thinking":
      return "(redacted thinking)";
    case "tool_use":
    case "server_tool_use":
      return `${b.name}
${JSON.stringify(b.input, null, 2)}`;
    case "tool_result":
      return typeof b.content === "string" ? b.content : (b.content ?? []).map((x) => x?.type === "image" ? "[image]" : x?.text ?? JSON.stringify(x)).join("\n");
    case "image":
      return "[image]";
    default:
      return JSON.stringify(b, null, 2);
  }
}

// packages/core/dist/store.js
import { EventEmitter } from "node:events";
import { closeSync, existsSync, openSync, readdirSync, readFileSync as readFileSync3, readSync, statSync, watch } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { basename as basename2, dirname as dirname4, join as join3 } from "node:path";

// packages/core/dist/account.js
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync as readFileSync2, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname as dirname3, join as join2 } from "node:path";
function readPlanTier() {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.split(",")[0]?.trim();
  for (const p of [configDir ? join2(configDir, ".claude.json") : "", join2(homedir(), ".claude.json")].filter(Boolean)) {
    try {
      const o = JSON.parse(readFileSync2(p, "utf8"))?.oauthAccount;
      if (!o || typeof o !== "object")
        continue;
      const str = (v) => typeof v === "string" && v ? v : void 0;
      return { organizationType: str(o.organizationType), rateLimitTier: str(o.organizationRateLimitTier) ?? str(o.userRateLimitTier) };
    } catch {
    }
  }
  return {};
}
function planPriceFor(subscriptionType, tier) {
  const t = (tier ?? "").toLowerCase();
  if (/max.*20x|20x/.test(t))
    return 200;
  if (/max.*5x|5x/.test(t))
    return 100;
  const sub = (subscriptionType ?? "").toLowerCase();
  if (sub === "pro" || /claude_pro/.test(t))
    return 20;
  return void 0;
}
var DEFAULT_SETTINGS_PATH = join2(homedir(), ".session-lens", "settings.json");
function billingFor(a) {
  const provider = a.apiProvider ?? "firstParty";
  if (provider !== "firstParty" && provider !== "gateway")
    return { mode: "api", label: `${provider} (pay per token)` };
  if (a.authMethod === "api_key" || a.authMethod === "api_key_helper")
    return { mode: "api", label: "API key (pay per token)" };
  const sub = a.subscriptionType?.toLowerCase();
  const org = a.orgName ? ` \xB7 ${a.orgName}` : "";
  if (sub === "team" || sub === "enterprise")
    return { mode: "team", label: `${sub === "team" ? "Team" : "Enterprise"}${org}` };
  if (sub === "pro" || sub === "max")
    return { mode: "subscription", label: `${sub === "pro" ? "Pro" : "Max"} plan` };
  if (a.authMethod === "claude.ai" || a.authMethod === "oauth_token")
    return { mode: "subscription", label: "Claude subscription (plan not reported)" };
  return { mode: "api", label: "Not logged in" };
}
function detectAccount(run = runCli) {
  const out = run("claude", ["auth", "status", "--json"]);
  if (out) {
    try {
      const j = JSON.parse(out.slice(out.indexOf("{")));
      const base = {
        loggedIn: !!j.loggedIn,
        authMethod: j.authMethod,
        apiProvider: j.apiProvider,
        subscriptionType: j.subscriptionType ?? null,
        orgName: j.orgName ?? null,
        email: j.email ?? null
      };
      const b = billingFor(base);
      const tier = readPlanTier();
      const price = b.mode === "subscription" ? planPriceFor(base.subscriptionType, tier.rateLimitTier) : void 0;
      const label = price === 200 ? "Max 20\xD7 plan" : price === 100 ? "Max 5\xD7 plan" : b.label;
      return { source: "claude-cli", ...base, detected: b.mode, label, rateLimitTier: tier.rateLimitTier, impliedPlanPrice: price };
    } catch {
    }
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR?.split(",")[0]?.trim();
  for (const p of [configDir ? join2(configDir, ".claude.json") : "", join2(homedir(), ".claude.json")].filter(Boolean)) {
    try {
      const cfg = JSON.parse(readFileSync2(p, "utf8"));
      const acct = cfg.oauthAccount;
      const authMethod = process.env.ANTHROPIC_API_KEY || cfg.primaryApiKey ? "api_key" : acct ? "claude.ai" : "none";
      const base = { loggedIn: authMethod !== "none", authMethod, subscriptionType: null, orgName: acct?.organizationName ?? null, email: acct?.emailAddress ?? null };
      const b = billingFor(base);
      return { source: "config", ...base, detected: b.mode, label: b.label };
    } catch {
    }
  }
  return { source: "none", loggedIn: false, detected: "api", label: "No Claude Code login found" };
}
function runCli(cmd, args2) {
  try {
    const r = spawnSync(cmd, args2, { encoding: "utf8", timeout: 8e3, shell: process.platform === "win32", windowsHide: true });
    return r.status === 0 || r.stdout?.includes("{") ? r.stdout : void 0;
  } catch {
    return void 0;
  }
}
var cached;
function account(maxAgeMs = 10 * 6e4) {
  if (!cached || Date.now() - cached.at > maxAgeMs)
    cached = { at: Date.now(), info: detectAccount() };
  return cached.info;
}
var MODES = ["api", "subscription", "team"];
function sanitizeSettings(patch) {
  const out = {};
  const num = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : void 0;
  if ("billing" in patch) {
    const b = patch.billing;
    out.billing = b === "auto" || b == null ? void 0 : MODES.includes(b) ? b : void 0;
  }
  if ("planPrice" in patch)
    out.planPrice = patch.planPrice == null ? void 0 : num(patch.planPrice, 0, 1e5);
  if ("monthlyLimit" in patch)
    out.monthlyLimit = patch.monthlyLimit == null ? void 0 : num(patch.monthlyLimit, 0, 1e7);
  if ("periodStartDay" in patch)
    out.periodStartDay = patch.periodStartDay == null ? void 0 : num(patch.periodStartDay, 1, 28);
  if ("prices" in patch && patch.prices && typeof patch.prices === "object") {
    const clean = {};
    for (const [id, v] of Object.entries(patch.prices)) {
      if (!/^[a-z0-9][a-z0-9.\-]*$/i.test(id) || !v || typeof v !== "object")
        continue;
      const e = {};
      for (const f of ["input", "output", "cacheWrite5m", "cacheWrite1h", "cacheRead"]) {
        const n = num(v[f], 0, 1e3);
        if (n !== void 0)
          e[f] = n;
      }
      const ctx = num(v.context, 1e3, 1e8);
      if (ctx !== void 0)
        e.context = Math.round(ctx);
      if (Object.keys(e).length)
        clean[id] = e;
    }
    out.prices = clean;
  }
  if ("timeZone" in patch) {
    const tz = patch.timeZone;
    let valid = false;
    if (typeof tz === "string" && tz)
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        valid = true;
      } catch {
      }
    out.timeZone = valid ? tz : void 0;
  }
  if ("discount" in patch)
    out.discount = patch.discount == null ? void 0 : num(patch.discount, 0, 0.95);
  if ("modelDiscounts" in patch) {
    const md = patch.modelDiscounts;
    if (md == null)
      out.modelDiscounts = void 0;
    else if (typeof md === "object") {
      const clean = {};
      for (const [k, v] of Object.entries(md)) {
        const d = num(v, 0, 0.95);
        if (/^[a-z0-9.\-]+$/i.test(k) && d !== void 0)
          clean[k] = d;
      }
      out.modelDiscounts = Object.keys(clean).length ? clean : void 0;
    }
  }
  return out;
}
function writeFileAtomic(path, data) {
  mkdirSync(dirname3(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
function billingPeriod(now, startDay = 1) {
  const d = Math.min(Math.max(Math.round(startDay), 1), 28);
  let start2 = new Date(now.getFullYear(), now.getMonth(), d);
  if (start2 > now)
    start2 = new Date(now.getFullYear(), now.getMonth() - 1, d);
  const end = new Date(start2.getFullYear(), start2.getMonth() + 1, d);
  const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  const day = 864e5;
  return {
    start: iso(start2),
    end: iso(new Date(end.getTime() - day)),
    days: Math.round((end.getTime() - start2.getTime()) / day),
    daysElapsed: Math.floor((now.getTime() - start2.getTime()) / day) + 1
  };
}

// packages/core/dist/store.js
function configDirs() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env)
    return env.split(",").map((d) => d.trim()).filter(Boolean);
  const xdg = process.env.XDG_CONFIG_HOME ? join3(process.env.XDG_CONFIG_HOME, "claude") : void 0;
  return [...new Set([xdg, join3(homedir2(), ".claude"), join3(homedir2(), ".config", "claude")].filter((d) => !!d))];
}
function defaultRoots() {
  return configDirs().map((d) => join3(d, "projects")).filter((r) => existsSync(r));
}
function loadSettings(path = DEFAULT_SETTINGS_PATH) {
  try {
    return JSON.parse(readFileSync3(path, "utf8"));
  } catch {
    return {};
  }
}
function listTranscripts(root) {
  const out = [];
  let projects;
  try {
    projects = readdirSync(root);
  } catch {
    return out;
  }
  for (const p of projects) {
    const pdir = join3(root, p);
    let entries;
    try {
      entries = readdirSync(pdir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".jsonl"))
        out.push(join3(pdir, e.name));
      else if (e.isDirectory()) {
        const sub = join3(pdir, e.name, "subagents");
        try {
          for (const f of readdirSync(sub))
            if (f.endsWith(".jsonl"))
              out.push(join3(sub, f));
        } catch {
        }
      }
    }
  }
  return out;
}
function projectName(file, projectDir) {
  if (file.cwd)
    return basename2(file.cwd) || file.cwd;
  return projectDir.replace(/^-/, "").split("-").filter(Boolean).pop() ?? projectDir;
}
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}
function readLiveSessions(configDir) {
  const dir = join3(configDir, "sessions");
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".json"))
      continue;
    try {
      const j = JSON.parse(readFileSync3(join3(dir, f), "utf8"));
      if (typeof j?.pid !== "number" || typeof j?.sessionId !== "string" || !isProcessAlive(j.pid))
        continue;
      out.push({ pid: j.pid, sessionId: j.sessionId, entrypoint: j.entrypoint, name: j.name, cwd: j.cwd });
    } catch {
    }
  }
  return out;
}
function retentionDays(configDir) {
  try {
    const v = JSON.parse(readFileSync3(join3(configDir, "settings.json"), "utf8"))?.cleanupPeriodDays;
    if (typeof v === "number" && Number.isFinite(v) && v > 0)
      return v;
  } catch {
  }
  return 30;
}
var CHUNK = 2 * 1024 * 1024;
var Store = class extends EventEmitter {
  roots;
  pricer;
  settings;
  files = /* @__PURE__ */ new Map();
  requests = /* @__PURE__ */ new Map();
  sessions = /* @__PURE__ */ new Map();
  live = /* @__PURE__ */ new Map();
  /** uuid → record, per file, for chain walks. */
  byUuid = /* @__PURE__ */ new Map();
  cursors = /* @__PURE__ */ new Map();
  lastScan = 0;
  /** Bumped on every rebuild so derived caches know to recompute. */
  version = 0;
  /** Bumped on anything a view should redraw for (data, live sessions, settings, reference figures). */
  changeId = 0;
  /** Where settings changes from the UI are saved; shared by every shell. */
  settingsPath;
  settingsMtime = 0;
  referenceMtime = 0;
  watchers = [];
  pollTimer;
  debounce;
  constructor(opts = {}) {
    super();
    this.roots = opts.roots ?? defaultRoots();
    this.settingsPath = opts.settingsPath ?? DEFAULT_SETTINGS_PATH;
    this.settings = opts.settings ?? loadSettings(this.settingsPath);
    this.settingsMtime = opts.settings ? Infinity : mtime(this.settingsPath);
    this.referenceMtime = mtime(join3(dirname4(this.settingsPath), "reference.json"));
    this.pricer = new Pricer(this.settings);
  }
  /** Config directories behind the roots: where the live-session registry and Claude Code's settings live. */
  get configDirs() {
    return [...new Set(this.roots.map((r) => dirname4(r)))];
  }
  /** Oldest day Claude Code is still keeping transcripts for (local), given its cleanup setting. */
  get retention() {
    const days = Math.min(...this.configDirs.map(retentionDays), 3e4);
    return { days, since: Date.now() - days * 864e5 };
  }
  setSettings(settings) {
    this.settings = settings;
    this.pricer = new Pricer(settings);
    this.rebuild();
    this.bump();
  }
  /** Save a settings patch atomically, so another shell never reads a half-written file. */
  writeSettings(next) {
    writeFileAtomic(this.settingsPath, JSON.stringify(next, null, 2) + "\n");
    this.settingsMtime = mtime(this.settingsPath);
    this.setSettings(next);
  }
  bump() {
    this.changeId++;
    this.emit("change", { changeId: this.changeId, version: this.version });
  }
  /** Follow every source live until close(). Safe to call once. */
  watch(pollMs = 2e3) {
    if (this.pollTimer)
      return this;
    const kick = () => this.schedule();
    const targets = [...this.roots, ...this.configDirs.map((d) => join3(d, "sessions")), dirname4(this.settingsPath)];
    for (const t of targets) {
      try {
        const w = watch(t, { recursive: t !== dirname4(this.settingsPath) }, kick);
        w.on("error", () => w.close());
        this.watchers.push(w);
      } catch {
      }
    }
    this.pollTimer = setInterval(kick, pollMs);
    this.pollTimer.unref?.();
    this.tick();
    return this;
  }
  close() {
    for (const w of this.watchers)
      w.close();
    this.watchers = [];
    if (this.pollTimer)
      clearInterval(this.pollTimer);
    if (this.debounce)
      clearTimeout(this.debounce);
    this.pollTimer = void 0;
  }
  schedule() {
    if (this.debounce)
      return;
    this.debounce = setTimeout(() => {
      this.debounce = void 0;
      this.tick();
    }, 250);
    this.debounce.unref?.();
  }
  /** One pass over every source; emits 'change' if anything moved. */
  tick() {
    let changed = false;
    let data = false;
    const sm = mtime(this.settingsPath);
    if (this.settingsMtime !== Infinity && sm !== this.settingsMtime) {
      this.settingsMtime = sm;
      this.settings = loadSettings(this.settingsPath);
      this.pricer = new Pricer(this.settings);
      this.lastScan = 0;
      this.refresh(0, true);
      changed = true;
    }
    const rm = mtime(join3(dirname4(this.settingsPath), "reference.json"));
    if (rm !== this.referenceMtime) {
      this.referenceMtime = rm;
      changed = true;
    }
    if (this.refresh(0))
      data = true;
    if (this.refreshLive())
      changed = true;
    if (changed && !data)
      this.bump();
    return changed || data;
  }
  refreshLive() {
    const next = /* @__PURE__ */ new Map();
    for (const d of this.configDirs)
      for (const l of readLiveSessions(d))
        next.set(l.sessionId, l);
    const same = next.size === this.live.size && [...next.keys()].every((k) => this.live.get(k)?.pid === next.get(k).pid);
    this.live = next;
    return !same;
  }
  /** Read what was appended since the last pass (at most once per `minIntervalMs`). True if anything changed. */
  refresh(minIntervalMs = 2e3, force = false) {
    const now = Date.now();
    if (!force && now - this.lastScan < minIntervalMs && this.files.size)
      return false;
    this.lastScan = now;
    let changed = false;
    const present = /* @__PURE__ */ new Set();
    for (const root of this.roots) {
      for (const path of listTranscripts(root)) {
        present.add(path);
        if (this.follow(path))
          changed = true;
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
    if (changed || force || !this.sessions.size)
      this.rebuild();
    if (changed)
      this.bump();
    return changed;
  }
  /** Feed a file's new complete lines to its parser. Starts over if the file shrank or was replaced. */
  follow(path) {
    let st;
    try {
      st = statSync(path);
    } catch {
      return false;
    }
    let cur = this.cursors.get(path);
    if (cur && (st.size < cur.offset || st.ino !== cur.ino))
      cur = void 0;
    if (cur && st.size === cur.offset)
      return false;
    if (!cur) {
      let meta;
      const metaPath = path.replace(/\.jsonl$/, ".meta.json");
      if (existsSync(metaPath)) {
        try {
          meta = JSON.parse(readFileSync3(metaPath, "utf8"));
        } catch {
        }
      }
      cur = { parser: new TranscriptParser(path, st, meta), offset: 0, carry: Buffer.alloc(0), ino: st.ino };
      this.cursors.set(path, cur);
      this.files.set(path, cur.parser.idx);
      this.byUuid.set(path, /* @__PURE__ */ new Map());
    }
    const before = cur.parser.idx.records.length;
    const map = this.byUuid.get(path);
    let fd;
    try {
      fd = openSync(path, "r");
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, st.size - cur.offset));
      while (cur.offset < st.size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, st.size - cur.offset), cur.offset);
        if (n <= 0)
          break;
        const data = cur.carry.length ? Buffer.concat([cur.carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        const base = cur.offset - cur.carry.length;
        let start2 = 0;
        for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, start2)) {
          cur.parser.feed(data.toString("utf8", start2, i), base + start2, i - start2);
          start2 = i + 1;
        }
        cur.carry = Buffer.from(data.subarray(start2));
        cur.offset += n;
      }
    } catch {
    } finally {
      if (fd !== void 0)
        closeSync(fd);
    }
    const idx = cur.parser.idx;
    idx.size = st.size;
    idx.mtimeMs = st.mtimeMs;
    for (let i = before; i < idx.records.length; i++)
      map.set(idx.records[i].uuid, idx.records[i]);
    return true;
  }
  record(file, uuid) {
    return this.byUuid.get(file)?.get(uuid);
  }
  /** Walk parentUuid links from `uuid` (exclusive) back to the root or a compaction boundary. */
  chain(file, fromUuid) {
    const map = this.byUuid.get(file);
    if (!map)
      return [];
    const out = [];
    const guard = /* @__PURE__ */ new Set();
    let cur = map.get(fromUuid)?.parentUuid ?? null;
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      const r = map.get(cur);
      if (!r)
        break;
      out.push(r);
      cur = r.parentUuid;
    }
    return out.reverse();
  }
  /** Rebuild sessions and requests from the parsed files. Request ids are deduplicated across ALL files. */
  rebuild() {
    this.version++;
    this.requests.clear();
    this.sessions.clear();
    const files = [...this.files.values()].sort((a, b) => a.firstTs - b.firstTs || Number(!!a.agentId) - Number(!!b.agentId) || a.lastTs - b.lastTs || a.mtimeMs - b.mtimeMs);
    const position = /* @__PURE__ */ new Map();
    for (const f of files) {
      const projectDir = basename2(f.agentId ? join3(f.path, "../../..") : join3(f.path, ".."));
      let s = this.sessions.get(f.sessionId);
      if (!s) {
        s = {
          id: f.sessionId,
          project: projectName(f, projectDir),
          cwd: f.cwd,
          title: f.title ?? "(untitled)",
          firstTs: f.firstTs,
          lastTs: f.lastTs,
          files: [],
          requestIds: [],
          subagents: [],
          sideCost: 0
        };
        this.sessions.set(f.sessionId, s);
      }
      s.files.push(f.path);
      if (!f.agentId) {
        s.mainFile = f.path;
        if (f.title)
          s.title = f.title;
        if (f.cwd) {
          s.cwd = f.cwd;
          s.project = projectName(f, projectDir);
        }
        if (f.reportedCostUSD != null)
          s.reportedCostUSD = f.reportedCostUSD;
      }
      s.firstTs = Math.min(s.firstTs || f.firstTs, f.firstTs);
      s.lastTs = Math.max(s.lastTs, f.lastTs);
      const sub = f.agentId ? { agentId: f.agentId, agentType: f.agentType, description: f.agentDescription, toolUseId: f.agentToolUseId, requestIds: [] } : void 0;
      if (sub)
        s.subagents.push(sub);
      const promptOf = /* @__PURE__ */ new Map();
      const nearestPrompt = (r) => {
        let cur = r;
        const walked = [];
        while (cur) {
          if (promptOf.has(cur.uuid)) {
            const p = promptOf.get(cur.uuid);
            for (const w of walked)
              promptOf.set(w.uuid, p);
            return p;
          }
          walked.push(cur);
          if (cur.type === "user" && cur.promptId) {
            for (const w of walked)
              promptOf.set(w.uuid, cur.promptId);
            return cur.promptId;
          }
          cur = cur.parentUuid ? this.record(f.path, cur.parentUuid) : void 0;
        }
        for (const w of walked)
          promptOf.set(w.uuid, void 0);
        return void 0;
      };
      f.records.forEach((r, ri) => {
        if (r.type !== "assistant" || !r.requestId || !r.usage || !r.model)
          return;
        const existing = this.requests.get(r.requestId);
        if (existing) {
          if (existing.file === f.path) {
            existing.uuids.push(r.uuid);
            for (const p of r.pieces)
              if (p.kind === "tool_use" && !existing.tools.includes(p.label))
                existing.tools.push(p.label);
            existing.usage = r.usage;
            existing.stopReason = r.stopReason ?? existing.stopReason;
          }
          return;
        }
        const price = this.pricer.price(r.model);
        const req = {
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
          contextLimit: /\[1m\]$/.test(r.model) ? 1e6 : price.context,
          firstUuid: r.uuid,
          uuids: [r.uuid],
          promptId: nearestPrompt(r),
          tools: r.pieces.filter((p) => p.kind === "tool_use").map((p) => p.label),
          stopReason: r.stopReason,
          entrypoint: r.entrypoint,
          role: f.agentId ? "subagent" : "iteration"
        };
        position.set(req.id, ri);
        this.requests.set(req.id, req);
        (sub ? sub.requestIds : s.requestIds).push(req.id);
      });
    }
    for (const req of this.requests.values()) {
      const u = req.usage;
      req.priced = this.pricer.isKnown(req.model);
      req.cost = req.priced ? this.pricer.cost(req.model, u) : 0;
      req.contextTokens = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
    }
    for (const s of this.sessions.values())
      this.assignRoles(s);
    for (const [id, s] of this.sessions) {
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
  assignRoles(s) {
    const main = s.requestIds.map((id) => this.requests.get(id)).filter(Boolean);
    const legacy = /* @__PURE__ */ new Map();
    const isLegacy = (file) => {
      if (!legacy.has(file))
        legacy.set(file, !(this.files.get(file)?.records.some((r) => r.origin) ?? false));
      return legacy.get(file);
    };
    for (const r of main) {
      const t = this.triggerOf(r, isLegacy(r.file));
      r.role = t.role;
      r.trigger = t.trigger;
    }
    for (const r of main)
      if (r.role === "iteration" && !r.tools.length)
        r.role = "answer";
    for (const a of s.subagents) {
      if (!a.toolUseId)
        continue;
      a.launchedBy = main.find((r) => r.uuids.some((u) => this.record(r.file, u)?.pieces.some((p) => p.toolUseId === a.toolUseId)))?.id;
    }
  }
  triggerOf(r, legacy) {
    let cur = this.record(r.file, r.firstUuid);
    cur = cur?.parentUuid ? this.record(r.file, cur.parentUuid) : void 0;
    for (let hops = 0; cur && hops < 500; hops++) {
      if (cur.type === "assistant" && cur.requestId !== r.id)
        return { role: "auto" };
      if (cur.type === "user") {
        const results = cur.pieces.filter((p) => p.kind === "tool_result");
        if (results.length)
          return { role: "iteration", trigger: [...new Set(results.map((p) => p.toolName ?? p.label))] };
        if (cur.isHuman)
          return { role: "prompt" };
        if (cur.origin)
          return { role: "auto", trigger: [cur.origin] };
        if (cur.pieces.some((p) => p.kind === "compact_summary"))
          return { role: "auto", trigger: ["compaction"] };
        if (legacy && !cur.isMeta && cur.pieces.some((p) => p.kind === "meta" || p.kind === "prompt"))
          return { role: "prompt" };
      }
      cur = cur.parentUuid ? this.record(r.file, cur.parentUuid) : void 0;
    }
    return { role: "auto" };
  }
  /**
   * Claude Code writes its own running cost (`cost-state`) into the transcript now and then. It includes
   * calls it never writes as records: title generation, safety checks, fetch summaries. The total
   * restarts every time the app restarts, so a long session is several runs: split the checkpoints where
   * the total drops, and compare each run's last figure with the records of that run. The difference is
   * that run's side calls, spread over its requests so days and totals include it.
   */
  reconcile(s, position) {
    const f = s.mainFile ? this.files.get(s.mainFile) : void 0;
    const cps = f?.costCheckpoints ?? (f?.costCheckpoint ? [f.costCheckpoint] : []);
    if (!f || !cps.length)
      return;
    const ends = cps.filter((cp, i) => i === cps.length - 1 || cps[i + 1].totalUSD < cp.totalUSD - 1e-9);
    const all = this.sessionRequests(s);
    let claudeCode = 0;
    let transcript = 0;
    let side = 0;
    let checked = 0;
    ends.forEach((cp, k) => {
      const prev = k ? ends[k - 1] : void 0;
      const from = prev?.recordCount ?? 0;
      const fromTs = prev?.ts ?? -Infinity;
      const run = all.filter((r) => r.agentId ? r.ts > fromTs && r.ts <= cp.ts : (position.get(r.id) ?? -1) >= from && (position.get(r.id) ?? Infinity) < cp.recordCount && r.file === f.path);
      if (!run.length || run.some((r) => !r.priced))
        return;
      const list = run.reduce((a, r) => a + this.pricer.listCost(r.model, r.usage), 0);
      const gap = cp.totalUSD - list;
      claudeCode += cp.totalUSD;
      transcript += list;
      checked++;
      if (gap <= 5e-3 || gap > list * 0.25)
        return;
      const runSide = gap * this.pricer.discountFactor(run[0].model);
      side += runSide;
      const total = run.reduce((a, r) => a + r.cost, 0) || 1;
      for (const r of run)
        r.side += runSide * r.cost / total;
    });
    if (!checked)
      return;
    s.sideCost = side;
    s.checkpoint = { claudeCodeUSD: claudeCode, transcriptUSD: transcript, ts: cps[cps.length - 1].ts, runs: ends.length, checkedRuns: checked };
  }
  /** All requests of a session: main thread plus every subagent. */
  sessionRequests(s) {
    const ids = [...s.requestIds, ...s.subagents.flatMap((a) => a.requestIds)];
    return ids.map((id) => this.requests.get(id)).filter(Boolean).sort((a, b) => a.ts - b.ts);
  }
  /** The raw JSONL line of a record, read by byte range: no need to load the whole file. */
  readRecord(file, rec) {
    let fd;
    try {
      fd = openSync(file, "r");
      const buf = Buffer.alloc(rec.len);
      readSync(fd, buf, 0, rec.len, rec.offset);
      return buf.toString("utf8");
    } catch {
      return "";
    } finally {
      if (fd !== void 0)
        closeSync(fd);
    }
  }
};
function mtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

// packages/core/dist/attribution.js
var SUBAGENT_TOOLS = /* @__PURE__ */ new Set(["Agent", "Task"]);
function originOf(kind, rec, toolName) {
  switch (kind) {
    case "prompt":
      return "you";
    case "text":
    case "thinking":
    case "tool_use":
      return "claude";
    case "tool_result":
      return toolName && SUBAGENT_TOOLS.has(toolName) ? "subagent" : "tool";
    case "image":
      return rec?.isHuman ? "you" : "tool";
    default:
      return "system";
  }
}
var DEFAULT_CHARS_PER_TOKEN = 3;
function piecesOf(recs) {
  const out = [];
  for (const rec of recs)
    for (const piece of rec.pieces)
      out.push({ rec, piece });
  return out;
}
function apportion(total, weights) {
  const sum2 = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum2 <= 0)
    return weights.map(() => 0);
  const raw = weights.map((w) => w / sum2 * total);
  const out = raw.map(Math.floor);
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--)
    out[order[k][1]]++;
  return out;
}
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function threadRequests(store2, req) {
  const s = store2.sessions.get(req.sessionId);
  if (!s)
    return [req];
  const ids = req.agentId ? s.subagents.find((a) => a.agentId === req.agentId)?.requestIds ?? [] : s.requestIds;
  return ids.map((id) => store2.requests.get(id)).filter(Boolean).sort((a, b) => a.ts - b.ts);
}
var profileCache = /* @__PURE__ */ new WeakMap();
function cacheFor(all, store2) {
  let m = all.get(store2);
  if (!m)
    all.set(store2, m = /* @__PURE__ */ new Map());
  return m;
}
function threadProfile(store2, req) {
  const thread = threadRequests(store2, req);
  const key = `${store2.version}:${req.sessionId}:${req.agentId ?? ""}`;
  const profiles = cacheFor(profileCache, store2);
  const hit = profiles.get(key);
  if (hit && hit.index.has(req.id))
    return hit;
  const steps = thread.map((r, i) => {
    let chars = 0;
    for (const rec of store2.chain(r.file, r.firstUuid))
      for (const p of rec.pieces)
        chars += p.chars;
    return { id: r.id, ts: r.ts, measured: r.contextTokens, chars, after: i > 0 ? thread[i - 1].tools : [] };
  });
  const ratios = [];
  for (let i = 1; i < steps.length; i++) {
    const dm = steps[i].measured - steps[i - 1].measured;
    const dc = steps[i].chars - steps[i - 1].chars;
    if (dm > 200 && dc > 500) {
      const r = dc / dm;
      if (r > 0.8 && r < 8)
        ratios.push(r);
    }
  }
  const charsPerToken = ratios.length >= 3 ? median(ratios) : DEFAULT_CHARS_PER_TOKEN;
  const first = steps[0];
  const baseline = first ? Math.max(0, Math.round(first.measured - first.chars / charsPerToken)) : 0;
  const profile = { charsPerToken, baseline, steps, index: new Map(steps.map((s, i) => [s.id, i])) };
  for (const k of profiles.keys())
    if (!k.startsWith(`${store2.version}:`))
      profiles.delete(k);
  profiles.set(key, profile);
  return profile;
}
function attribute(store2, requestId, opts = {}) {
  const req = store2.requests.get(requestId);
  if (!req)
    return void 0;
  const prof = threadProfile(store2, req);
  const pos = prof.index.get(req.id) ?? 0;
  const cpt = prof.charsPerToken;
  const chain = store2.chain(req.file, req.firstUuid);
  const pieces = piecesOf(chain);
  const total = req.contextTokens;
  const baseline = Math.min(prof.baseline, total);
  const chars = pieces.reduce((a, p) => a + p.piece.chars, 0);
  const room = total - baseline;
  const visibleTokens = Math.min(Math.round(chars / cpt), room);
  const unattributed = room - visibleTokens;
  const alloc = apportion(visibleTokens, pieces.map((p) => p.piece.chars));
  const prevStep = pos > 0 ? prof.steps[pos - 1] : void 0;
  const prevIds = /* @__PURE__ */ new Set();
  if (prevStep && opts.diff !== false) {
    const prev = store2.requests.get(prevStep.id);
    for (const { rec, piece } of piecesOf(store2.chain(prev.file, prev.firstUuid)))
      prevIds.add(`${rec.uuid}:${piece.block}`);
  }
  const items = [
    {
      id: "baseline",
      uuid: "",
      block: 0,
      kind: "baseline",
      label: "System prompt + tool definitions",
      detail: "Not written to the transcript; measured once on the first request of this thread",
      chars: 0,
      tokens: baseline,
      added: pos === 0,
      ts: prof.steps[0]?.ts ?? req.ts,
      origin: "system"
    }
  ];
  if (unattributed > 0) {
    const floor = Math.max(500, total * 5e-3);
    const named = [];
    for (let i = 1; i <= pos; i++) {
      const s = prof.steps[i];
      const p = prof.steps[i - 1];
      const jump = s.measured - p.measured - (s.chars - p.chars) / cpt;
      if (jump >= floor)
        named.push({ step: s, tokens: jump });
    }
    const namedSum = named.reduce((a, n) => a + n.tokens, 0);
    const namedAlloc = apportion(Math.min(Math.round(namedSum), unattributed), named.map((n) => n.tokens));
    named.forEach((n, i) => {
      if (!namedAlloc[i])
        return;
      items.push({
        id: `unattributed:${n.step.id}`,
        uuid: "",
        block: 0,
        kind: "unattributed",
        label: n.step.after.length ? `Not in transcript: appeared after ${n.step.after.join(", ")}` : "Not in transcript: appeared at this step",
        detail: "Tool schemas loaded mid-session (ToolSearch, MCP, skills), hidden thinking, or tokenizer variance",
        chars: 0,
        tokens: namedAlloc[i],
        added: n.step.id === req.id,
        ts: n.step.ts,
        origin: "system"
      });
    });
    const rest = unattributed - namedAlloc.reduce((a, b) => a + b, 0);
    if (rest > 0)
      items.push({
        id: "unattributed:rest",
        uuid: "",
        block: 0,
        kind: "unattributed",
        label: named.length ? "Not in transcript: estimation variance" : "Not in transcript",
        detail: "Hidden content and chars-per-token variance spread over many requests",
        chars: 0,
        tokens: rest,
        added: pos === 0,
        ts: req.ts,
        origin: "system"
      });
  }
  pieces.forEach(({ rec, piece }, i) => {
    const id = `${rec.uuid}:${piece.block}`;
    items.push({
      id,
      uuid: rec.uuid,
      block: piece.block,
      kind: piece.kind,
      label: piece.label,
      detail: piece.detail,
      chars: piece.chars,
      tokens: alloc[i],
      added: prevStep ? !prevIds.has(id) : true,
      ts: rec.ts,
      toolName: piece.toolName,
      origin: originOf(piece.kind, rec, piece.toolName)
    });
  });
  const outRecs = req.uuids.map((u) => store2.record(req.file, u)).filter((r) => !!r);
  const outPieces = piecesOf(outRecs);
  const outAlloc = new Array(outPieces.length).fill(0);
  const thinkingIdx = outPieces.flatMap((p, i) => p.piece.kind === "thinking" ? [i] : []);
  const restIdx = outPieces.flatMap((p, i) => p.piece.kind === "thinking" ? [] : [i]);
  const thinkTokens = thinkingIdx.length ? Math.min(req.usage.thinking, req.usage.output) : 0;
  apportion(thinkTokens, thinkingIdx.map(() => 1)).forEach((t, k) => outAlloc[thinkingIdx[k]] = t);
  apportion(req.usage.output - thinkTokens, restIdx.map((i) => outPieces[i].piece.chars || 1)).forEach((t, k) => outAlloc[restIdx[k]] = t);
  const output = outPieces.map(({ rec, piece }, i) => ({
    id: `${rec.uuid}:${piece.block}`,
    uuid: rec.uuid,
    block: piece.block,
    kind: piece.kind,
    label: piece.label,
    detail: piece.detail,
    chars: piece.chars,
    tokens: outAlloc[i]
  }));
  return {
    requestId: req.id,
    measuredInput: total,
    baselineTokens: baseline,
    unattributedTokens: unattributed,
    items,
    output,
    previousRequestId: prevStep?.id,
    addedTokens: items.filter((i) => i.added).reduce((a, i) => a + i.tokens, 0),
    charsPerToken: cpt
  };
}
var compositionCache = /* @__PURE__ */ new WeakMap();
function sessionComposition(store2, sessionId) {
  const key = `${store2.version}:${sessionId}`;
  const compositions = cacheFor(compositionCache, store2);
  const hit = compositions.get(key);
  if (hit)
    return hit;
  const s = store2.sessions.get(sessionId);
  if (!s)
    return [];
  const out = [];
  for (const req of store2.sessionRequests(s)) {
    const a = attribute(store2, req.id, { diff: false });
    if (!a)
      continue;
    const byKind = {};
    const byOrigin = {};
    for (const i of a.items) {
      byKind[i.kind] = (byKind[i.kind] ?? 0) + i.tokens;
      byOrigin[i.origin] = (byOrigin[i.origin] ?? 0) + i.tokens;
    }
    out.push({ id: req.id, ts: req.ts, agentId: req.agentId, total: a.measuredInput, contextLimit: req.contextLimit, byKind, byOrigin, role: req.role });
  }
  for (const k of compositions.keys())
    if (!k.startsWith(`${store2.version}:`))
      compositions.delete(k);
  compositions.set(key, out);
  return out;
}

// packages/core/dist/usage.js
import { readFileSync as readFileSync4 } from "node:fs";
import { dirname as dirname5, join as join4 } from "node:path";
var PRODUCTS = [
  { key: "claude_code", label: "Claude Code" },
  { key: "chat", label: "Chat" },
  { key: "cowork", label: "Cowork" },
  { key: "chrome", label: "Claude in Chrome" }
];
var SURFACES = {
  cli: "Terminal",
  "claude-vscode": "VS Code",
  vscode: "VS Code",
  jetbrains: "JetBrains",
  mcp: "MCP server",
  "claude-jetbrains": "JetBrains",
  "claude-desktop": "Desktop app",
  remote_mobile: "Remote / mobile",
  remote: "Remote",
  "sdk-cli": "Agent SDK",
  "sdk-ts": "Agent SDK",
  "sdk-py": "Agent SDK"
};
var surfaceLabel = (e) => e ? SURFACES[e] ?? e : "Unknown";
var DAY = 864e5;
var utcDay = (ts) => new Date(ts).toISOString().slice(0, 10);
var parseDay = (d) => Date.parse(d + "T00:00:00Z");
var addDays = (d, n) => utcDay(parseDay(d) + n * DAY);
var utcWeek = (d) => addDays(d, -((new Date(parseDay(d)).getUTCDay() + 6) % 7));
function utcPeriod(now, startDay = 1) {
  const n = new Date(now);
  const sd = Math.min(Math.max(Math.round(startDay), 1), 28);
  let start2 = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), sd);
  if (start2 > now)
    start2 = Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, sd);
  const s = new Date(start2);
  const end = Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, sd);
  return { start: utcDay(start2), end: utcDay(end - DAY), resetsAt: new Date(end).toISOString() };
}
function referencePath(settingsPath) {
  return join4(dirname5(settingsPath), "reference.json");
}
function loadReference(path) {
  try {
    return JSON.parse(readFileSync4(path, "utf8"));
  } catch {
    return {};
  }
}
var money2 = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.round(v * 100) / 100 : void 0;
function saveReference(path, patch) {
  const cur = loadReference(path);
  if (!patch || typeof patch !== "object")
    return cur;
  const p = patch;
  const isDay = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k);
  if (p.period && typeof p.period === "object") {
    const { start: start2, spent, limit } = p.period;
    if (typeof start2 === "string" && isDay(start2)) {
      cur.periods ??= {};
      const entry = { ...cur.periods[start2] ?? {} };
      if (spent !== void 0)
        spent === null ? delete entry.spent : entry.spent = money2(spent);
      if (limit !== void 0)
        limit === null ? delete entry.limit : entry.limit = money2(limit);
      cur.periods[start2] = entry;
    }
  }
  if (p.range && typeof p.range === "object") {
    const { key, values } = p.range;
    if (typeof key === "string" && /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/.test(key) && values && typeof values === "object") {
      cur.ranges ??= {};
      const entry = { ...cur.ranges[key] ?? {} };
      for (const { key: pk } of PRODUCTS) {
        if (!(pk in values))
          continue;
        const v = values[pk];
        if (v === null)
          delete entry[pk];
        else if (money2(v) !== void 0)
          entry[pk] = money2(v);
      }
      cur.ranges[key] = entry;
    }
  }
  if (p.days && typeof p.days === "object") {
    cur.days ??= {};
    for (const [k, v] of Object.entries(p.days)) {
      if (!isDay(k))
        continue;
      if (v === null)
        delete cur.days[k];
      else if (money2(v) !== void 0)
        cur.days[k] = money2(v);
    }
  }
  writeFileAtomic(path, JSON.stringify(cur, null, 2) + "\n");
  return cur;
}
function parseDailyPaste(text, year) {
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const out = {};
  const pad = (n) => String(n).padStart(2, "0");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line)
      continue;
    let y = year;
    let m;
    let d;
    let rest = line;
    let hit = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(line);
    if (hit)
      [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
    else if (hit = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/.exec(line)) {
      m = months.indexOf(hit[1].toLowerCase()) + 1 || void 0;
      d = Number(hit[2]);
      if (hit[3])
        y = Number(hit[3]);
    } else if (hit = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(line)) {
      [m, d] = [Number(hit[1]), Number(hit[2])];
      if (hit[3])
        y = hit[3].length === 2 ? 2e3 + Number(hit[3]) : Number(hit[3]);
    }
    if (!hit || !m || !d || m > 12 || d > 31)
      continue;
    rest = line.slice(hit[0].length);
    const nums = [...rest.matchAll(/\$?\s*(\d[\d,]*(?:\.\d+)?)/g)];
    const num = nums[nums.length - 1];
    if (!num)
      continue;
    const v = Number(num[1].replace(/,/g, ""));
    if (Number.isFinite(v))
      out[`${y}-${pad(m)}-${pad(d)}`] = Math.round(v * 100) / 100;
  }
  return out;
}
function keyOf(store2, r, group) {
  switch (group) {
    case "model": {
      const m = r.model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
      return { key: m, label: m };
    }
    case "project": {
      const p = store2.sessions.get(r.sessionId)?.project ?? "unknown";
      return { key: p, label: p };
    }
    case "surface":
      return { key: r.entrypoint ?? "unknown", label: surfaceLabel(r.entrypoint) };
    case "role":
      return { key: r.role, label: ROLE_LABEL[r.role] };
    default:
      return { key: "claude_code", label: "Claude Code" };
  }
}
function usageView(store2, q, now = Date.now()) {
  store2.refresh();
  const today = utcDay(now);
  const period = utcPeriod(now, store2.settings.periodStartDay ?? 1);
  const from = q.from ?? period.start;
  const to = q.to ?? today;
  const group = q.group ?? "product";
  const interval = q.interval ?? "day";
  const nDays = Math.round((parseDay(to) - parseDay(from)) / DAY) + 1;
  const priorTo = addDays(from, -1);
  const priorFrom = addDays(from, -nDays);
  const buckets = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const b = interval === "week" ? utcWeek(d) : d;
    if (buckets[buckets.length - 1] !== b)
      buckets.push(b);
  }
  const bucketIndex = new Map(buckets.map((b, i) => [b, i]));
  const series = /* @__PURE__ */ new Map();
  const ensure = (k) => {
    let s = series.get(k.key);
    if (!s) {
      s = { ...k, values: buckets.map(() => 0), total: 0, prior: 0, requests: 0 };
      series.set(k.key, s);
    }
    return s;
  };
  if (group === "product")
    for (const p of PRODUCTS)
      ensure(p);
  let periodSpent = 0;
  const billed = { compaction: { requests: 0, cost: 0 }, fast: { requests: 0, cost: 0 }, usOnly: { requests: 0, cost: 0 } };
  const skillUses = /* @__PURE__ */ new Map();
  const yesterday = addDays(today, -1);
  for (const r of store2.requests.values()) {
    const d = utcDay(r.ts);
    const c = r.cost + r.side;
    if (d >= period.start && d <= period.end)
      periodSpent += c;
    if (q.project && store2.sessions.get(r.sessionId)?.project !== q.project)
      continue;
    if (d >= from && d <= to) {
      const u = r.usage;
      if (u.compaction || u.fast || u.usOnly) {
        const plain = { ...u, compaction: void 0, fast: void 0, usOnly: void 0 };
        const withCompaction = { ...plain, compaction: u.compaction };
        const withFast = { ...withCompaction, fast: u.fast };
        const cost = (x) => r.priced ? store2.pricer.cost(r.model, x) : 0;
        if (u.compaction) {
          billed.compaction.requests++;
          billed.compaction.cost += cost(withCompaction) - cost(plain);
        }
        if (u.fast) {
          billed.fast.requests++;
          billed.fast.cost += cost(withFast) - cost(withCompaction);
        }
        if (u.usOnly) {
          billed.usOnly.requests++;
          billed.usOnly.cost += cost(u) - cost(withFast);
        }
      }
      const s = ensure(keyOf(store2, r, group));
      const i = bucketIndex.get(interval === "week" ? utcWeek(d) : d);
      if (i != null)
        s.values[i] += c;
      s.total += c;
      s.requests++;
    } else if (d >= priorFrom && d <= priorTo) {
      ensure(keyOf(store2, r, group)).prior += c;
    }
  }
  const seen = /* @__PURE__ */ new Set();
  for (const f of store2.files.values()) {
    const s = store2.sessions.get(f.sessionId);
    if (q.project && s?.project !== q.project)
      continue;
    for (const rec of f.records) {
      if (!rec.skills || seen.has(rec.uuid))
        continue;
      seen.add(rec.uuid);
      const d = utcDay(rec.ts);
      if (d < from || d > to || d > yesterday)
        continue;
      for (const name of rec.skills) {
        const e = skillUses.get(name) ?? { uses: 0, sessions: /* @__PURE__ */ new Set() };
        e.uses++;
        e.sessions.add(f.sessionId);
        skillUses.set(name, e);
      }
    }
  }
  const ref = loadReference(referencePath(store2.settingsPath));
  const rangeKey = `${from}..${to}`;
  const refDays = {};
  for (const [d, v] of Object.entries(ref.days ?? {}))
    if (d >= from && d <= to)
      refDays[d] = v;
  const refPeriod = ref.periods?.[period.start] ?? {};
  let oldest = Infinity;
  for (const r of store2.requests.values())
    if (r.ts < oldest)
      oldest = r.ts;
  const oldestDay = Number.isFinite(oldest) ? utcDay(oldest) : void 0;
  const ret = store2.retention;
  const keptSince = utcDay(now - ret.days * DAY);
  const priorIncomplete = !oldestDay || priorFrom < oldestDay || priorFrom < keptSince;
  const list = [...series.values()];
  if (group === "product")
    list.sort((a, b) => PRODUCTS.findIndex((p) => p.key === a.key) - PRODUCTS.findIndex((p) => p.key === b.key));
  else
    list.sort((a, b) => a.label.localeCompare(b.label));
  const total = list.reduce((a, s) => a + s.total, 0);
  return {
    range: { from, to, days: nDays, prior: { from: priorFrom, to: priorTo, incomplete: priorIncomplete }, timeZone: "UTC" },
    history: { oldestDay, keptSince, retentionDays: ret.days },
    group,
    interval,
    buckets,
    series: list.map((s) => ({
      key: s.key,
      label: s.label,
      values: s.values,
      total: s.total,
      share: total ? s.total / total : 0,
      prior: s.prior,
      change: priorIncomplete ? null : s.prior ? (s.total - s.prior) / s.prior : null,
      requests: s.requests,
      /** Products Claude Code never writes to disk: the dashboard is the only source for these. */
      local: group !== "product" || s.key === "claude_code"
    })),
    total,
    period: { ...period, spent: periodSpent, limit: store2.settings.monthlyLimit ?? refPeriod.limit ?? null },
    skills: [...skillUses.entries()].map(([name, e]) => ({ name, uses: e.uses, sessions: e.sessions.size })).sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name)),
    skillsThrough: yesterday < to ? yesterday : to,
    billed,
    reference: {
      period: refPeriod,
      range: ref.ranges?.[rangeKey] ?? {},
      rangeKey,
      days: refDays
    }
  };
}

// packages/core/dist/api.js
function roleSplit(reqs) {
  const out = {};
  for (const r of reqs) {
    const e = out[r.role] ??= { requests: 0, cost: 0, output: 0 };
    e.requests++;
    e.cost += r.cost + r.side;
    e.output += r.usage.output;
  }
  return out;
}
function dayFormatter(timeZone) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return (ts) => f.format(ts);
}
function inRange(day, q) {
  return (!q.from || day >= q.from) && (!q.to || day <= q.to);
}
function shortModel(m) {
  return m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}
var Api = class {
  store;
  day;
  constructor(store2) {
    this.store = store2;
    this.day = dayFormatter(store2.settings.timeZone);
  }
  requestsIn(q) {
    this.store.refresh();
    const out = [];
    for (const r of this.store.requests.values()) {
      if (q.project && this.store.sessions.get(r.sessionId)?.project !== q.project)
        continue;
      if (inRange(this.day(r.ts), q))
        out.push(r);
    }
    return out;
  }
  summary(q) {
    const rows = /* @__PURE__ */ new Map();
    const reqs = this.requestsIn(q);
    for (const r of reqs) {
      const d = this.day(r.ts);
      let row = rows.get(d);
      if (!row) {
        row = { day: d, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, costParts: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, side: 0 }, requests: 0, sessions: 0, costByModel: {}, _sessions: /* @__PURE__ */ new Set() };
        rows.set(d, row);
      }
      row.input += r.usage.input;
      row.cacheWrite += r.usage.cacheWrite5m + r.usage.cacheWrite1h;
      row.cacheRead += r.usage.cacheRead;
      row.output += r.usage.output;
      row.cost += r.cost + r.side;
      row.costParts.side += r.side;
      const parts = this.store.pricer.costParts(r.model, r.usage);
      row.costParts.input += parts.input;
      row.costParts.cacheWrite += parts.cacheWrite;
      row.costParts.cacheRead += parts.cacheRead;
      row.costParts.output += parts.output;
      row.requests++;
      row._sessions.add(r.sessionId);
      const m = shortModel(r.model);
      row.costByModel[m] = (row.costByModel[m] ?? 0) + r.cost + r.side;
    }
    const days = [...rows.values()].sort((a, b) => a.day.localeCompare(b.day)).map(({ _sessions, ...row }) => ({ ...row, sessions: _sessions.size }));
    const totals = days.reduce((t, d) => ({
      input: t.input + d.input,
      cacheWrite: t.cacheWrite + d.cacheWrite,
      cacheRead: t.cacheRead + d.cacheRead,
      output: t.output + d.output,
      cost: t.cost + d.cost,
      requests: t.requests + d.requests
    }), { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, requests: 0 });
    const all = [...this.store.requests.values()];
    const allDays = all.map((r) => this.day(r.ts)).sort();
    return {
      days,
      totals: { ...totals, sessions: new Set(reqs.map((r) => r.sessionId)).size },
      projects: [...new Set([...this.store.sessions.values()].map((s) => s.project))].sort(),
      models: [...new Set(reqs.map((r) => shortModel(r.model)))].sort(),
      range: { first: allDays[0], last: allDays[allDays.length - 1] },
      discount: this.store.pricer.discount,
      unknownModels: [...new Set(all.filter((r) => !r.priced).map((r) => r.model))],
      unpricedRequests: reqs.filter((r) => !r.priced).length,
      sideCost: sum(reqs, (r) => r.side),
      byRole: roleSplit(reqs),
      history: this.history(),
      live: this.liveSessions()
    };
  }
  /** How far back transcripts go, and how far Claude Code keeps them (it deletes older ones). */
  history() {
    const ret = this.store.retention;
    let oldest = Infinity;
    for (const r of this.store.requests.values())
      if (r.ts < oldest)
        oldest = r.ts;
    return {
      oldestDay: Number.isFinite(oldest) ? this.day(oldest) : void 0,
      retentionDays: ret.days,
      keptSince: this.day(ret.since)
    };
  }
  /** Sessions whose Claude Code process is running right now, most recently active first. */
  liveSessions() {
    const out = [];
    for (const [id, l] of this.store.live) {
      const s = this.store.sessions.get(id);
      const reqs = s ? this.store.sessionRequests(s) : [];
      const main = reqs.filter((r) => !r.agentId);
      const last = main[main.length - 1];
      out.push({
        id,
        title: s?.title ?? l.name ?? "(new session)",
        project: s?.project,
        entrypoint: l.entrypoint,
        pid: l.pid,
        lastTs: s?.lastTs ?? 0,
        cost: sum(reqs, (r) => r.cost + r.side),
        contextTokens: last?.contextTokens ?? 0,
        contextLimit: last?.contextLimit ?? 0,
        requests: reqs.length
      });
    }
    return out.sort((a, b) => b.lastTs - a.lastTs);
  }
  sessions(q) {
    const byS = /* @__PURE__ */ new Map();
    for (const r of this.requestsIn(q)) {
      const list = byS.get(r.sessionId) ?? [];
      list.push(r);
      byS.set(r.sessionId, list);
    }
    const rows = [];
    for (const [id, reqs] of byS) {
      const s = this.store.sessions.get(id);
      if (!s)
        continue;
      const all = this.store.sessionRequests(s);
      const main = reqs.filter((r) => !r.agentId).sort((a, b) => a.ts - b.ts);
      let peak = 0;
      let peakPct = 0;
      for (const r of reqs) {
        if (r.contextTokens > peak) {
          peak = r.contextTokens;
          peakPct = r.contextTokens / r.contextLimit;
        }
      }
      rows.push({
        id,
        project: s.project,
        title: s.title,
        firstTs: Math.min(...reqs.map((r) => r.ts)),
        lastTs: Math.max(...reqs.map((r) => r.ts)),
        models: [...new Set(reqs.map((r) => shortModel(r.model)))],
        requests: reqs.length,
        subagents: new Set(reqs.filter((r) => r.agentId).map((r) => r.agentId)).size,
        input: sum(reqs, (r) => r.usage.input),
        cacheWrite: sum(reqs, (r) => r.usage.cacheWrite5m + r.usage.cacheWrite1h),
        cacheRead: sum(reqs, (r) => r.usage.cacheRead),
        output: sum(reqs, (r) => r.usage.output),
        cost: sum(reqs, (r) => r.cost + r.side),
        totalCost: sum(all, (r) => r.cost + r.side),
        live: this.store.live.has(id),
        peakContext: peak,
        peakContextPct: peakPct,
        spark: main.map((r) => r.contextTokens),
        byRole: roleSplit(reqs)
      });
    }
    rows.sort((a, b) => b.cost - a.cost);
    return { sessions: rows };
  }
  session(id) {
    this.store.refresh();
    const s = this.store.sessions.get(id);
    if (!s)
      return void 0;
    const reqs = this.store.sessionRequests(s);
    const turns = this.turns(s, reqs);
    return {
      session: {
        id: s.id,
        project: s.project,
        cwd: s.cwd,
        title: s.title,
        firstTs: s.firstTs,
        lastTs: s.lastTs,
        reportedCostUSD: s.reportedCostUSD,
        cost: sum(reqs, (r) => r.cost + r.side),
        sideCost: s.sideCost,
        checkpoint: s.checkpoint,
        live: this.store.live.has(s.id),
        unpriced: reqs.filter((r) => !r.priced).length,
        byRole: roleSplit(reqs)
      },
      requests: reqs.map((r) => ({
        id: r.id,
        ts: r.ts,
        day: this.day(r.ts),
        model: shortModel(r.model),
        agentId: r.agentId,
        usage: r.usage,
        cost: r.cost,
        priced: r.priced,
        side: r.side,
        costParts: this.store.pricer.costParts(r.model, r.usage),
        contextTokens: r.contextTokens,
        contextLimit: r.contextLimit,
        tools: r.tools,
        promptId: r.promptId,
        stopReason: r.stopReason,
        role: r.role,
        trigger: r.trigger
      })),
      turns,
      subagents: s.subagents.filter((a) => a.requestIds.length).map((a) => {
        const rs = a.requestIds.map((rid) => this.store.requests.get(rid)).filter(Boolean);
        return {
          agentId: a.agentId,
          agentType: a.agentType,
          description: a.description,
          toolUseId: a.toolUseId,
          launchedBy: a.launchedBy,
          requests: rs.length,
          cost: sum(rs, (r) => r.cost + r.side),
          firstTs: Math.min(...rs.map((r) => r.ts)),
          model: rs[0] ? shortModel(rs[0].model) : void 0
        };
      })
    };
  }
  /** A turn = one human prompt and every request (main + subagent) that answered it. */
  turns(s, reqs) {
    const file = s.mainFile;
    const prompts = /* @__PURE__ */ new Map();
    if (file) {
      const f = this.store.files.get(file);
      for (const r of f?.records ?? []) {
        if (r.type === "user" && r.promptId && r.isHuman && !prompts.has(r.promptId)) {
          const texts = r.pieces.filter((x) => x.kind === "prompt" || x.kind === "meta");
          if (!texts.length)
            continue;
          let full = "";
          try {
            const line = this.store.readRecord(file, r);
            full = texts.map((x) => blockText(line, x.block)).join("\n\n");
          } catch {
            full = texts.map((x) => x.label).join("\n\n");
          }
          const CAP = 8e3;
          if (full.length > CAP)
            full = full.slice(0, CAP) + `
\u2026 (${full.length - CAP} more characters)`;
          prompts.set(r.promptId, { text: texts[0].label, full, ts: r.ts, mode: r.permissionMode });
        }
      }
    }
    const agentPrompt = /* @__PURE__ */ new Map();
    for (const a of s.subagents) {
      const parent = s.requestIds.map((id) => this.store.requests.get(id)).find((r) => {
        const recs = r?.uuids.map((u) => this.store.record(r.file, u));
        return recs?.some((rec) => rec?.pieces.some((p) => p.toolUseId && p.toolUseId === a.toolUseId));
      });
      agentPrompt.set(a.agentId, parent?.promptId);
    }
    const groups = /* @__PURE__ */ new Map();
    for (const r of reqs) {
      const key = (r.agentId ? agentPrompt.get(r.agentId) : r.promptId) ?? "unknown";
      const g = groups.get(key) ?? [];
      g.push(r);
      groups.set(key, g);
    }
    return [...groups.entries()].map(([promptId, rs]) => ({
      promptId,
      text: prompts.get(promptId)?.text ?? (promptId === "unknown" ? "(no prompt found)" : "(prompt not in this file)"),
      fullText: prompts.get(promptId)?.full,
      mode: prompts.get(promptId)?.mode,
      // Models that answered, most-used first; subagent models listed separately.
      models: byCount(rs.filter((r) => !r.agentId).map((r) => shortModel(r.model))),
      subagentModels: byCount(rs.filter((r) => r.agentId).map((r) => shortModel(r.model))),
      ts: prompts.get(promptId)?.ts ?? rs[0].ts,
      requestIds: rs.map((r) => r.id),
      cost: sum(rs, (r) => r.cost + r.side),
      output: sum(rs, (r) => r.usage.output),
      byRole: roleSplit(rs)
    })).sort((a, b) => a.ts - b.ts);
  }
  request(id) {
    this.store.refresh();
    const r = this.store.requests.get(id);
    if (!r)
      return void 0;
    const a = attribute(this.store, id);
    const s = this.store.sessions.get(r.sessionId);
    const thread = threadRequests(this.store, r);
    const pos = thread.findIndex((x) => x.id === id);
    return {
      request: {
        id: r.id,
        ts: r.ts,
        model: shortModel(r.model),
        agentId: r.agentId,
        usage: r.usage,
        cost: r.cost,
        priced: r.priced,
        side: r.side,
        costParts: this.store.pricer.costParts(r.model, r.usage),
        contextTokens: r.contextTokens,
        contextLimit: r.contextLimit,
        tools: r.tools,
        stopReason: r.stopReason,
        role: r.role,
        trigger: r.trigger,
        launched: s?.subagents.filter((x) => x.launchedBy === r.id && x.requestIds.length).map((x) => {
          const rs = x.requestIds.map((rid) => this.store.requests.get(rid)).filter(Boolean);
          return { agentId: x.agentId, agentType: x.agentType, description: x.description, requests: rs.length, cost: sum(rs, (q) => q.cost + q.side), firstRequestId: rs.sort((a2, b) => a2.ts - b.ts)[0]?.id };
        }) ?? [],
        subagent: r.agentId ? (() => {
          const x = s?.subagents.find((a2) => a2.agentId === r.agentId);
          return x ? { agentType: x.agentType, description: x.description, launchedBy: x.launchedBy } : void 0;
        })() : void 0
      },
      session: s ? { id: s.id, title: s.title, project: s.project } : void 0,
      thread: { index: pos, count: thread.length, prev: thread[pos - 1]?.id, next: thread[pos + 1]?.id },
      attribution: a
    };
  }
  /** Raw text of one context item (a record uuid + block within the request's file). */
  raw(requestId, uuid, block) {
    const r = this.store.requests.get(requestId);
    if (!r)
      return void 0;
    const rec = this.store.record(r.file, uuid);
    if (!rec)
      return void 0;
    const text = blockText(this.store.readRecord(r.file, rec), block);
    const LIMIT = 2e5;
    return { text: text.length > LIMIT ? text.slice(0, LIMIT) + `
\u2026 (${text.length - LIMIT} more characters)` : text };
  }
  /** Detected login, saved overrides, and spend in the current billing period. */
  account(detect = account) {
    this.store.refresh();
    const info = detect();
    const st = this.store.settings;
    const mode = st.billing ?? info.detected;
    const period = billingPeriod(/* @__PURE__ */ new Date(), st.periodStartDay ?? 1);
    let cost = 0;
    for (const r of this.store.requests.values()) {
      const d = this.day(r.ts);
      if (d >= period.start && d <= period.end)
        cost += r.cost + r.side;
    }
    return {
      account: info,
      mode,
      overridden: st.billing != null,
      // The plan fee: what you typed under Plan…, else what the detected plan implies.
      planPrice: st.planPrice ?? info.impliedPlanPrice ?? null,
      planPriceSource: st.planPrice != null ? "settings" : info.impliedPlanPrice != null ? "plan" : null,
      settings: { billing: st.billing ?? "auto", planPrice: st.planPrice ?? null, monthlyLimit: st.monthlyLimit ?? null, periodStartDay: st.periodStartDay ?? 1, discount: st.discount ?? 0 },
      period: { ...period, cost, projected: period.daysElapsed ? cost / period.daysElapsed * period.days : cost }
    };
  }
  /** Save a settings patch from the UI to the shared settings file and re-price everything. */
  updateSettings(body) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      return { error: "expected a JSON object" };
    const raw = body;
    const patch = sanitizeSettings(raw);
    const next = { ...this.store.settings };
    if (raw.prices && typeof raw.prices === "object") {
      const merged = { ...this.store.settings.prices ?? {} };
      for (const [id, v] of Object.entries(raw.prices)) {
        if (v === null)
          delete merged[id];
        else if (patch.prices?.[id])
          merged[id] = { ...merged[id] ?? {}, ...patch.prices[id] };
      }
      patch.prices = Object.keys(merged).length ? merged : void 0;
    }
    for (const [k, v] of Object.entries(patch))
      v === void 0 ? delete next[k] : next[k] = v;
    this.store.writeSettings(next);
    this.day = dayFormatter(this.store.settings.timeZone);
    return this.account();
  }
  /** The price table: every priced model, where its price came from, and whether your data uses it. */
  pricing() {
    this.store.refresh();
    const file = bundledPricing();
    const usage = /* @__PURE__ */ new Map();
    const unpriced = /* @__PURE__ */ new Map();
    for (const r of this.store.requests.values()) {
      const key = this.store.pricer.keyFor(r.model);
      if (!key) {
        const u2 = unpriced.get(r.model) ?? { requests: 0, lastTs: 0 };
        u2.requests++;
        u2.lastTs = Math.max(u2.lastTs, r.ts);
        unpriced.set(r.model, u2);
        continue;
      }
      const u = usage.get(key) ?? { requests: 0, lastTs: 0, models: /* @__PURE__ */ new Set() };
      u.requests++;
      u.lastTs = Math.max(u.lastTs, r.ts);
      u.models.add(r.model);
      usage.set(key, u);
    }
    const st = this.store.settings;
    return {
      checkedAt: file.checkedAt,
      sourceUrl: file.sourceUrl,
      webSearchPerRequest: file.webSearchPerRequest,
      appliedFromAnthropic: st.published?.fetchedAt,
      models: this.store.pricer.table().map((m) => ({
        ...m,
        bundled: file.models[m.id],
        edited: st.prices?.[m.id] ?? null,
        usage: usage.has(m.id) ? { requests: usage.get(m.id).requests, lastTs: usage.get(m.id).lastTs, ids: [...usage.get(m.id).models] } : null
      })),
      unpriced: [...unpriced.entries()].map(([model, u]) => ({ model, ...u })),
      discount: st.discount ?? 0,
      modelDiscounts: st.modelDiscounts ?? {},
      defaults: deriveCache(1)
    };
  }
  /** Fetch Anthropic's pricing page and compare it with what is in effect. The only network request. */
  async checkPublished(fetchImpl) {
    const pub = await fetchPublishedPricing(fetchImpl);
    const pricer = this.store.pricer;
    const rows = comparePrices(pub.models, (id) => ({ price: pricer.price(id), known: pricer.isKnown(id) }));
    return { fetchedAt: pub.fetchedAt, url: pub.url, models: rows.map((r) => ({ ...r, source: pricer.sources[pricer.keyFor(r.id) ?? ""] ?? null })) };
  }
  /** Apply published prices (all, or the ones listed) as the "from Anthropic" layer. */
  applyPublished(body) {
    const b = body ?? {};
    if (!Array.isArray(b.models))
      return { error: "expected { models: [...] }" };
    const ok = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e3;
    const layer = { ...this.store.settings.published?.models ?? {} };
    for (const m of b.models) {
      if (!m || typeof m.id !== "string" || !/^[a-z0-9][a-z0-9.\-]*$/i.test(m.id))
        continue;
      if (![m.input, m.output, m.cacheWrite5m, m.cacheWrite1h, m.cacheRead].every(ok))
        continue;
      const context = this.store.pricer.price(m.id).context;
      layer[m.id] = { input: m.input, output: m.output, cacheWrite5m: m.cacheWrite5m, cacheWrite1h: m.cacheWrite1h, cacheRead: m.cacheRead, context };
    }
    const fetchedAt = typeof b.fetchedAt === "string" ? b.fetchedAt : (/* @__PURE__ */ new Date()).toISOString();
    const prices = { ...this.store.settings.prices ?? {} };
    for (const m of b.models) {
      const e = m && typeof m.id === "string" ? prices[m.id] : void 0;
      if (!e || !layer[m.id])
        continue;
      const rest = Object.fromEntries(Object.entries(e).filter(([k]) => k === "context"));
      if (Object.keys(rest).length)
        prices[m.id] = rest;
      else
        delete prices[m.id];
    }
    this.store.writeSettings({ ...this.store.settings, prices: Object.keys(prices).length ? prices : void 0, published: { fetchedAt, models: layer } });
    return this.pricing();
  }
  /** What Session Lens reads and where it keeps things, for the Settings page. */
  config() {
    const st = this.store.settings;
    return {
      roots: this.store.roots,
      configDirs: this.store.configDirs,
      retentionDays: this.store.retention.days,
      settingsPath: this.store.settingsPath,
      timeZone: st.timeZone ?? null,
      systemTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      transcripts: this.store.files.size,
      sessions: this.store.sessions.size,
      requests: this.store.requests.size,
      live: this.store.live.size
    };
  }
  /** One entry point for every shell: HTTP server, VS Code message bridge, Electron. May return a promise. */
  handle(path, params, body) {
    const q = { from: params.get("from") ?? void 0, to: params.get("to") ?? void 0, project: params.get("project") ?? void 0 };
    switch (path) {
      case "/api/summary":
        return this.summary(q);
      case "/api/sessions":
        return this.sessions(q);
      case "/api/session":
        return this.session(params.get("id") ?? "") ?? { error: "not found" };
      case "/api/request":
        return this.request(params.get("id") ?? "") ?? { error: "not found" };
      case "/api/account":
        return this.account();
      case "/api/pricing":
        return this.pricing();
      case "/api/pricing/check":
        return body === void 0 ? { error: "POST to check" } : this.checkPublished().catch((e) => ({ error: String(e?.message ?? e) }));
      case "/api/pricing/apply":
        return body === void 0 ? { error: "POST { models }" } : this.applyPublished(body);
      case "/api/config":
        return this.config();
      case "/api/settings":
        return body === void 0 ? { error: "POST a JSON object" } : this.updateSettings(body);
      case "/api/usage":
        return usageView(this.store, {
          from: params.get("from") ?? void 0,
          to: params.get("to") ?? void 0,
          group: params.get("group") ?? void 0,
          interval: params.get("interval") === "week" ? "week" : "day",
          project: params.get("project") ?? void 0
        });
      case "/api/reference": {
        if (body === void 0 || body === null || typeof body !== "object")
          return { error: "POST a JSON object" };
        const b = body;
        const patch = { ...b };
        if (typeof b.paste === "string") {
          const parsed = parseDailyPaste(b.paste, typeof b.year === "number" ? b.year : (/* @__PURE__ */ new Date()).getUTCFullYear());
          patch.days = { ...b.days ?? {}, ...parsed };
          delete patch.paste;
        }
        saveReference(referencePath(this.store.settingsPath), patch);
        return { ok: true };
      }
      case "/api/composition":
        this.store.refresh();
        return { points: sessionComposition(this.store, params.get("id") ?? "") };
      case "/api/raw":
        return this.raw(params.get("request") ?? "", params.get("uuid") ?? "", Number(params.get("block") ?? 0)) ?? { error: "not found" };
      default:
        return { error: `unknown endpoint ${path}` };
    }
  }
};
function byCount(xs) {
  const n = /* @__PURE__ */ new Map();
  for (const x of xs)
    n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([x]) => x);
}
function sum(xs, f) {
  let n = 0;
  for (const x of xs)
    n += f(x);
  return n;
}

// packages/core/dist/server.js
import { readFile } from "node:fs/promises";
import http from "node:http";
import { extname, join as join5, normalize } from "node:path";
var TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png"
};
function createServer(opts) {
  const owned = !opts.store;
  const store2 = opts.store ?? new Store();
  store2.refresh(0);
  if (opts.live !== false)
    store2.watch();
  const api = new Api(store2);
  const listeners = /* @__PURE__ */ new Set();
  const onChange = (e) => {
    for (const res of listeners)
      res.write(`event: change
data: ${JSON.stringify(e)}

`);
  };
  store2.on("change", onChange);
  const heartbeat = setInterval(() => {
    for (const res of listeners)
      res.write(": ping\n\n");
  }, 25e3);
  heartbeat.unref?.();
  const host = opts.host ?? "127.0.0.1";
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  const server = http.createServer(async (req, res) => {
    try {
      const hostname = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
      if (loopback && !["127.0.0.1", "localhost", "::1"].includes(hostname)) {
        res.writeHead(403).end();
        return;
      }
      const url2 = new URL(req.url ?? "/", "http://localhost");
      if (url2.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`retry: 2000
event: hello
data: ${JSON.stringify({ changeId: store2.changeId })}

`);
        listeners.add(res);
        req.on("close", () => listeners.delete(res));
        return;
      }
      if (url2.pathname.startsWith("/api/")) {
        let payload;
        if (req.method === "POST") {
          const origin = req.headers.origin;
          const originHost = origin ? new URL(origin).hostname.replace(/^\[|\]$/g, "") : void 0;
          if (!(req.headers["content-type"] ?? "").startsWith("application/json") || originHost && !["127.0.0.1", "localhost", "::1"].includes(originHost)) {
            res.writeHead(403).end();
            return;
          }
          let raw = "";
          for await (const chunk of req) {
            raw += chunk;
            if (raw.length > 65536) {
              res.writeHead(413).end();
              return;
            }
          }
          try {
            payload = JSON.parse(raw || "null");
          } catch {
            res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid JSON" }));
            return;
          }
        } else if (req.method !== "GET") {
          res.writeHead(405).end();
          return;
        }
        const body = JSON.stringify(await api.handle(url2.pathname, url2.searchParams, payload));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(body);
        return;
      }
      const rel = normalize(decodeURIComponent(url2.pathname)).replace(/^([/\\])+/, "");
      if (rel.includes("..")) {
        res.writeHead(400).end();
        return;
      }
      const file = join5(opts.uiDir, rel || "index.html");
      try {
        const data = await readFile(file);
        res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
        res.end(data);
      } catch {
        const data = await readFile(join5(opts.uiDir, "index.html"));
        res.writeHead(200, { "content-type": TYPES[".html"] });
        res.end(data);
      }
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.on("close", () => {
      clearInterval(heartbeat);
      store2.off("change", onChange);
      for (const res of listeners)
        res.end();
      if (owned)
        store2.close();
    });
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      const port2 = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({ server, url: `http://${host}:${port2}/`, api });
    });
  });
}

// apps/server/src/cli.ts
var args = process.argv.slice(2);
var flag = (name) => args.includes(`--${name}`);
var opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : void 0;
};
if (flag("help")) {
  console.log(`session-lens \u2014 Claude Code usage, day \u2192 session \u2192 request \u2192 context

  --port <n>        port to listen on (default 4317, 0 = any free port)
  --host <addr>     interface to bind (default 127.0.0.1)
  --projects <dir>  transcripts folder (default ~/.claude/projects; comma-separate several)
  --no-open         don't open a browser`);
  process.exit(0);
}
var here = dirname6(fileURLToPath2(import.meta.url));
var uiDir = [join6(here, "ui"), join6(here, "../../../packages/ui/dist")].find((d) => existsSync2(join6(d, "index.html")));
if (!uiDir) {
  console.error("Dashboard bundle not found. Run `npm run build` in the session-lens folder first.");
  process.exit(1);
}
var roots = opt("projects")?.split(",");
var store = new Store(roots ? { roots } : {});
if (!store.roots.length) {
  console.error("No Claude Code transcripts found (looked for ~/.claude/projects). Pass --projects <dir>.");
  process.exit(1);
}
var port = Number(opt("port") ?? 4317);
var start = (p) => createServer({ uiDir, store, port: p, host: opt("host") }).catch((e) => {
  if (e.code === "EADDRINUSE" && p !== 0) return createServer({ uiDir, store, port: 0, host: opt("host") });
  throw e;
});
var { url } = await start(port);
console.log(`Session Lens: ${url}  (${store.requests.size} requests across ${store.sessions.size} sessions)`);
if (!flag("no-open")) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const cargs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, cargs, { stdio: "ignore", detached: true }).on("error", () => {
  }).unref();
}
