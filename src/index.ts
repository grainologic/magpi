import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_DIR_NAME,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import * as cache from "./cache.js";
import * as cachedb from "./cachedb.js";
import { elideFetchPreviews } from "./prune.js";
import {
  cacheRoot,
  globalCacheRoot,
  globalConfigPath,
  invalidConfigPaths,
  loadConfig,
  projectCacheRoot,
  projectConfigPath,
  saveConfig,
  setConfigDirName,
} from "./config.js";
import { assertPublicTarget, type FetchMode } from "./handlers/handler.js";
import { listHandlers, registerHandler, resolveHandler } from "./handlers/registry.js";
import { formatResults, webSearch } from "./search.js";

// Keep preview small: the full text is on disk, pi's read tool pages the rest.
const PREVIEW_LINES = 150;
const PREVIEW_BYTES = 8 * 1024;

function normalizeUrl(raw: string): URL {
  let s = raw.trim().replace(/^@/, ""); // some models prefix paths/urls with @
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  return new URL(s);
}

export default function (pi: ExtensionAPI) {
  setConfigDirName(CONFIG_DIR_NAME);

  interface StatusCtx {
    cwd: string;
    hasUI: boolean;
    isProjectTrusted(): boolean;
    ui: { setStatus(id: string, text: string): void };
  }

  // Terse persistent footer: "magpi ▸G12 L3 · 40MB": entries per cache,
  // ▸ marks the write scope, total size last. The cache is real disk; keep
  // its weight visible. Refreshed only when storage actually changes.
  function updateStatus(ctx: StatusCtx) {
    if (!ctx.hasUI) return;
    const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    const g = cache.stats(globalCacheRoot());
    const l = cache.stats(projectCacheRoot(ctx.cwd));
    const sel = cfg.cacheScope === "project" ? "L" : "G";
    const part = (tag: string, entries: number) => `${sel === tag ? "▸" : ""}${tag}${entries}`;
    ctx.ui.setStatus("magpi", `magpi ${part("G", g.entries)} ${part("L", l.entries)} · ${formatSize(g.bytes + l.bytes)}`);
  }

  const bothRoots = (cwd: string, cfg: ReturnType<typeof loadConfig>) => {
    const writeRoot = cacheRoot(cwd, cfg);
    return [writeRoot, writeRoot === globalCacheRoot() ? projectCacheRoot(cwd) : globalCacheRoot()];
  };

  pi.on("session_start", (_event, ctx) => {
    const trusted = ctx.isProjectTrusted();
    for (const p of invalidConfigPaths(ctx.cwd, trusted)) {
      if (ctx.hasUI) ctx.ui.notify(`magpi: invalid JSON in ${p}; using defaults`, "error");
    }
    for (const root of bothRoots(ctx.cwd, loadConfig(ctx.cwd, trusted))) {
      if (cache.heal(root) === "rebuilt" && ctx.hasUI) ctx.ui.notify(`magpi: search index rebuilt for ${root}`, "info");
    }
    updateStatus(ctx);
  });

  pi.on("session_shutdown", () => cachedb.closeAll());

  // Context thrift: old fetch previews are dead weight; the full text is on
  // disk. Before each LLM call, replace all but the newest previews with a
  // one-line pointer to the cached file.
  pi.on("context", (event) => ({ messages: elideFetchPreviews(event.messages as never[]) }));

  // If the user's prompt contains URLs that are already cached and fresh,
  // tell the model where they live; it skips the fetch round-trip entirely.
  pi.on("before_agent_start", (event, ctx) => {
    const urls = [...new Set(event.prompt.match(/https?:\/\/[^\s)\]}>"']+/g) ?? [])].slice(0, 8);
    if (urls.length === 0) return;
    const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    const roots = bothRoots(ctx.cwd, cfg);
    const hits: string[] = [];
    for (const raw of urls) {
      try {
        const href = cache.canonicalize(new URL(raw));
        // A full entry answers a light lookup, so one probe covers both modes.
        const e = cache.lookupAny(roots, href, "light", cfg.ttlHours);
        if (e) hits.push(`${raw} -> ${e.contentPath}${e.treePath ? ` (+ files: ${e.treePath})` : ""}`);
      } catch {
        // not a parseable URL; skip
      }
    }
    if (hits.length === 0) return;
    return {
      message: {
        customType: "magpi-cache-hint",
        content: `magpi: these URLs are already cached. Read the paths instead of refetching:\n${hits.join("\n")}`,
        display: false,
      },
    };
  });

  // Other extensions extend MagPi over pi's shared event bus:
  //   pi.events.emit("magpi:register-handler", defineHandler({...}))
  pi.events.on("magpi:register-handler", (handler: unknown) => {
    registerHandler(handler as never);
  });

  async function fetchToCache(
    rawUrl: string,
    mode: FetchMode,
    refresh: boolean | undefined,
    ctx: StatusCtx,
    signal?: AbortSignal,
    onUpdate?: (partial: { content: Array<{ type: "text"; text: string }> }) => void,
  ) {
    // Canonical form (no fragments/tracking params, sorted query) is both
    // the cache key and the URL fetched, so variants of one page share an entry.
    const url = new URL(cache.canonicalize(normalizeUrl(rawUrl)));
    const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    const roots = bothRoots(ctx.cwd, cfg);

    // Reads union both caches (write scope first); writes land in roots[0] only.
    let entry = refresh ? undefined : cache.lookupAny(roots, url.href, mode, cfg.ttlHours);
    let fromCache = true;
    let stale = false;

    if (!entry) {
      fromCache = false;
      if (!cfg.allowPrivateNetwork) await assertPublicTarget(url);
      const handler = resolveHandler(url);
      onUpdate?.({ content: [{ type: "text", text: `Fetching via ${handler.name}...` }] });
      try {
        const entryDir = cache.entryDir(roots[0], url.href);
        const result = await handler.fetch(url, {
          mode,
          entryDir,
          signal,
          exec: (cmd, args, opts) => pi.exec(cmd, args, opts),
        });
        entry = cache.store(roots[0], url.href, mode, {
          handler: handler.name,
          kind: result.kind,
          title: result.title,
          content: result.content,
          hasTree: result.hasTree ?? false,
        });
        if (cfg.maxCacheMB > 0) cache.evictToBudget(roots[0], cfg.maxCacheMB * 1024 * 1024);
        updateStatus(ctx);
      } catch (err) {
        // Silent offline resilience: an any-age cached copy beats an error.
        const old = cache.lookupAny(roots, url.href, mode, Infinity);
        if (!old) throw err;
        entry = old;
        fromCache = true;
        stale = true;
      }
    }
    return { entry, fromCache, stale };
  }

  /** Parallel fan-out over fetchToCache: one code path for batch fetch and search's fetch_top. */
  async function fetchMany(
    targets: string[],
    mode: FetchMode,
    refresh: boolean | undefined,
    ctx: StatusCtx,
    signal?: AbortSignal,
    onUpdate?: (partial: { content: Array<{ type: "text"; text: string }> }) => void,
  ) {
    let done = 0;
    const settled = await Promise.allSettled(
      targets.map(async (t) => {
        try {
          return await fetchToCache(t, mode, refresh, ctx, signal);
        } finally {
          onUpdate?.({ content: [{ type: "text", text: `fetched ${++done}/${targets.length}` }] });
        }
      }),
    );
    return settled.map((s, i) =>
      s.status === "fulfilled"
        ? { ok: true as const, url: targets[i], contentPath: s.value.entry.contentPath, treePath: s.value.entry.treePath }
        : { ok: false as const, url: targets[i], error: String((s.reason as Error)?.message ?? s.reason) },
    );
  }

  pi.registerTool({
    name: "magpi_fetch",
    label: "Web Fetch",
    description:
      "Fetch URLs with smart extraction and a persistent disk cache. Specialized handling for GitHub/GitLab (README or full clone; issues/PRs), package registries (npm, PyPI, crates.io, Go, RubyGems, Packagist, Hex, Maven: metadata or full package download), Wikipedia/Wikidata, Stack Overflow/Stack Exchange (Q + top answers), Reddit threads, arXiv papers, and generic webpages (readable markdown). Single url returns a preview plus the cached file path; read/grep that path for the rest instead of refetching. Pass urls (array) to batch-fetch up to 5 in parallel (paths only). Falls back to a stale cached copy if the network is down.",
    promptSnippet: "Fetch any URL (webpage, repo, package, wiki) with smart extraction and disk caching",
    promptGuidelines: [
      "Use magpi_fetch whenever the user shares a URL or web content is needed; it caches to disk; read/grep the returned cache path for more detail instead of calling magpi_fetch again.",
      "Use magpi_fetch with mode 'full' only when you need actual source files (clones a repo or downloads a package into the cache).",
    ],
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "URL to fetch (scheme optional, https assumed)" })),
      urls: Type.Optional(
        Type.Array(Type.String(), { description: "Batch mode: fetch up to 5 URLs in parallel; returns cache paths only" }),
      ),
      mode: Type.Optional(
        StringEnum(["light", "full"] as const, {
          description: "light (default): readme/extract/metadata. full: clone repo or download+extract package.",
        }),
      ),
      refresh: Type.Optional(Type.Boolean({ description: "Bypass the cache and refetch" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const targets = [...(params.url ? [params.url] : []), ...(params.urls ?? [])].slice(0, 5);
      if (targets.length === 0) throw new Error("Provide url or urls");
      const mode: FetchMode = params.mode ?? "light";

      if (targets.length > 1) {
        const batch = await fetchMany(targets, mode, params.refresh, ctx, signal, onUpdate);
        const lines = batch.map((b) =>
          b.ok
            ? `✓ ${b.url}\n   -> ${b.contentPath}${b.treePath ? `\n   -> ${b.treePath} (files)` : ""}`
            : `✗ ${b.url}: ${b.error}`,
        );
        lines.push("\nRead/grep the paths above for content.");
        return { content: [{ type: "text", text: lines.join("\n") }], details: { batch } };
      }

      const { entry, fromCache, stale } = await fetchToCache(targets[0], mode, params.refresh, ctx, signal, onUpdate);
      const content = readFileSync(entry.contentPath, "utf8");
      const t = truncateHead(content, { maxLines: PREVIEW_LINES, maxBytes: PREVIEW_BYTES });

      const footer = [
        "",
        "---",
        `magpi: ${entry.meta.kind} via ${entry.meta.handler}` +
          (fromCache
            ? ` | cached ${entry.ageHours < 1 ? `${Math.round(entry.ageHours * 60)}m` : `${entry.ageHours.toFixed(1)}h`} ago (${entry.meta.fetchedAt})${stale ? " | STALE: network unavailable, serving old copy" : ""}`
            : ` | fetched ${entry.meta.fetchedAt}`),
        `full text: ${entry.contentPath} (${formatSize(entry.meta.contentBytes)})` +
          (t.truncated ? " (preview truncated; read the file for the rest)" : ""),
        entry.treePath ? `files: ${entry.treePath} (use ls/read/grep there)` : "",
      ]
        .filter(Boolean)
        .join("\n");

      return {
        content: [{ type: "text", text: t.content + footer }],
        details: {
          url: entry.meta.url,
          mode,
          handler: entry.meta.handler,
          kind: entry.meta.kind,
          title: entry.meta.title,
          fetchedAt: entry.meta.fetchedAt,
          fromCache,
          stale,
          contentBytes: entry.meta.contentBytes,
          contentPath: entry.contentPath,
          treePath: entry.treePath,
        },
      };
    },
    // Display-only (never touches session content or LLM context): a calm
    // one-liner collapsed, full preview on expand.
    renderCall(args, theme) {
      const a = (args ?? {}) as { url?: string; urls?: string[]; mode?: string };
      const target = a.url ?? (Array.isArray(a.urls) ? `${a.urls.length} urls` : "");
      return new Text(
        theme.fg("toolTitle", theme.bold("magpi_fetch ")) +
          theme.fg("muted", `${target}${a.mode === "full" ? " (full)" : ""}`),
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        const msg = (result?.content?.[0] as { text?: string } | undefined)?.text ?? "fetching...";
        return new Text(theme.fg("warning", msg), 0, 0);
      }
      const d = (result.details ?? {}) as Record<string, any>;
      let line: string;
      if (Array.isArray(d.batch)) {
        line = theme.fg("success", `✓ ${d.batch.filter((b: any) => b.ok).length}/${d.batch.length} fetched to cache`);
      } else {
        const src = d.fromCache ? (d.stale ? "stale cache" : "cache") : "fetched";
        line =
          theme.fg("success", "✓ ") +
          theme.fg("muted", `${d.kind ?? "?"} via ${d.handler ?? "?"} · ${src}${d.contentBytes ? ` · ${formatSize(d.contentBytes)}` : ""}`);
      }
      if (expanded) {
        const raw = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
        line += "\n" + theme.fg("dim", raw);
      }
      return new Text(line, 0, 0);
    },
  });

  pi.registerTool({
    name: "magpi_cached",
    label: "Cached Web Content",
    description:
      "List or full-text search web content already cached on disk by magpi_fetch (persists across sessions). Without arguments, lists entries: URL, kind, age, local file path; read/grep those paths directly instead of refetching. With query, runs ranked full-text search over all cached content and returns snippets plus paths, answering 'did we ever fetch anything about X?'. filter narrows the listing by substring match on URL or kind.",
    promptSnippet: "List or full-text search locally cached web content (URLs -> file paths)",
    promptGuidelines: [
      "Use magpi_cached to check what web content is already cached before fetching or searching; cached entries persist across sessions and can be read/grepped directly at their paths. Pass query to full-text search cached content by topic.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Full-text search over cached content; returns ranked snippets + paths" })),
      filter: Type.Optional(Type.String({ description: "Substring to match against URL or kind (e.g. a domain) when listing" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const roots: Array<[string, string]> = [
        ["G", globalCacheRoot()],
        ["L", projectCacheRoot(ctx.cwd)],
      ];
      if (params.query) {
        const hits = cache.searchContent(roots.map(([, r]) => r), params.query, 10);
        if (hits && hits.length > 0) {
          const lines = hits.map(
            (h, i) => `${i + 1}. ${h.title || h.url}\n   ${h.url}\n   ${h.snippet.replace(/\s+/g, " ")}\n   -> ${h.contentPath}`,
          );
          lines.push("\nRead/grep the paths for full content. >> << marks the matched terms.");
          return { content: [{ type: "text", text: lines.join("\n") }], details: { query: params.query, hits: hits.length } };
        }
        if (hits) {
          return {
            content: [{ type: "text", text: `Nothing cached matches "${params.query}". magpi_fetch or magpi_search the web instead.` }],
            details: { query: params.query, hits: 0 },
          };
        }
        // no index on this Node version; fall through to substring listing
        params.filter = params.filter ?? params.query;
      }
      const needle = params.filter?.toLowerCase();
      const entries = roots
        .flatMap(([scope, root]) => cache.listEntries(root).map((e) => ({ scope, e })))
        .filter(({ e }) => !needle || e.meta.url.toLowerCase().includes(needle) || e.meta.kind.includes(needle))
        .sort((a, b) => a.e.ageHours - b.e.ageHours);
      if (entries.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No cached entries${needle ? ` matching "${params.filter}"` : ""}. Roots: global ${roots[0][1]}, local ${roots[1][1]}`,
            },
          ],
          details: { roots: Object.fromEntries(roots), count: 0 },
        };
      }
      const MAX = 50;
      const lines = entries.slice(0, MAX).map(({ scope, e }) => {
        const age = e.ageHours < 1 ? `${Math.round(e.ageHours * 60)}m` : `${e.ageHours.toFixed(1)}h`;
        return `${scope} ${age.padStart(6)}  ${e.meta.kind.padEnd(12)} ${e.meta.url}\n          -> ${e.contentPath}${e.treePath ? `\n          -> ${e.treePath} (files)` : ""}`;
      });
      if (entries.length > MAX) lines.push(`... and ${entries.length - MAX} more (use filter to narrow)`);
      lines.push(`\nG = global cache (${roots[0][1]}), L = project-local cache (${roots[1][1]}): both grep/ls-able, host-grouped`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { roots: Object.fromEntries(roots), count: entries.length },
      };
    },
  });

  // magpi_search registers at session_start, when every extension has loaded:
  // if another search tool is active, magpi_search self-demotes to a fallback
  // in its description/guidelines (pi has no tool-priority mechanism, so the
  // prompt text is the lever). It stays registered either way, so the model
  // can still fall back to it when the preferred tool breaks.
  pi.on("session_start", () => {
    const active = new Set(pi.getActiveTools());
    const competitors = pi
      .getAllTools()
      .filter((t) => t.name !== "magpi_search" && /search/i.test(t.name) && active.has(t.name))
      .map((t) => t.name);
    registerSearchTool(competitors);
  });

  function registerSearchTool(competitors: string[]) {
    const deferring = competitors.length > 0;
    const rivals = competitors.join(", ");
    pi.registerTool({
      name: "magpi_search",
      label: "Web Search",
      description:
        (deferring
          ? `FALLBACK web search. Prefer ${rivals} for searches; use magpi_search only when ${rivals} is unavailable, failing, or rate-limited. `
          : "") +
        "Best-effort web search with no API keys: DuckDuckGo Lite, Wikipedia, and HN Algolia (all rate-limited free endpoints). Returns titles, URLs and snippets; follow up with magpi_fetch on promising URLs. If every source fails, ask the user to run the search and paste results.",
      promptSnippet: deferring
        ? `Fallback web search (prefer ${rivals}), no API keys`
        : "Best-effort web search (DDG Lite, Wikipedia, HN), no API keys",
      promptGuidelines: [
        deferring
          ? `Prefer ${rivals} for web searches; use magpi_search only if ${rivals} fails or is unavailable. Either way, magpi_fetch the promising URLs. If all search fails, ask the user to search and paste results; do not silently fall back to memory.`
          : "Use magpi_search for lookups instead of saying you cannot search; then magpi_fetch the promising URLs. If magpi_search fails or returns nothing useful, ask the user to search and paste results; do not silently fall back to memory.",
      ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      source: Type.Optional(
        StringEnum(["auto", "ddg", "wikipedia", "hn"] as const, {
          description: "auto (default) tries ddg, then wikipedia, then hn",
        }),
      ),
      fetch_top: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 5,
          description: "Also fetch the top N result URLs into the cache and return their paths (saves round-trips)",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const { results, errors } = await webSearch(params.query, params.source ?? "auto", signal, (s) =>
        onUpdate?.({ content: [{ type: "text", text: `searching ${s}...` }] }),
      );
      if (results.length > 0) {
        const note = errors.length ? `\n\n(sources skipped: ${errors.join("; ")})` : "";
        let fetchedNote = "";
        const top = results.slice(0, Math.min(params.fetch_top ?? 0, results.length));
        if (top.length > 0) {
          const fetched = await fetchMany(top.map((r) => r.url), "light", false, ctx, signal, onUpdate);
          fetchedNote =
            "\n\nfetched to cache:\n" +
            fetched
              .map((f) => (f.ok ? `${f.url}\n  -> ${f.contentPath}` : `${f.url}: failed (${f.error})`))
              .join("\n");
        }
        return {
          content: [{ type: "text", text: formatResults(results) + note + fetchedNote }],
          details: { query: params.query, results },
        };
      }

      // All sources down/rate-limited: ask the human, unashamedly.
      if (ctx.hasUI) {
        const pasted = await ctx.ui.input(
          "MagPi search fallback",
          `Automated search failed for "${params.query}" (${errors.join("; ")}). Paste search results or URLs (leave empty to skip):`,
        );
        if (pasted?.trim()) {
          return {
            content: [{ type: "text", text: `User-provided search results:\n${pasted.trim()}` }],
            details: { query: params.query, userProvided: true },
          };
        }
      }
      throw new Error(
        `All search sources failed (${errors.join("; ")}). Ask the user to search the web for "${params.query}" and share results or URLs.`,
      );
    },
    renderCall(args, theme) {
      const a = (args ?? {}) as { query?: string; source?: string };
      return new Text(
        theme.fg("toolTitle", theme.bold("magpi_search ")) +
          theme.fg("muted", `"${a.query ?? ""}"${a.source && a.source !== "auto" ? ` [${a.source}]` : ""}`),
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        const msg = (result?.content?.[0] as { text?: string } | undefined)?.text ?? "searching...";
        return new Text(theme.fg("warning", msg), 0, 0);
      }
      const d = (result.details ?? {}) as { results?: Array<{ source: string }> };
      const n = d.results?.length ?? 0;
      const sources = [...new Set((d.results ?? []).map((r) => r.source))].join(",");
      let line = theme.fg("success", "✓ ") + theme.fg("muted", `${n} results${sources ? ` [${sources}]` : ""}`);
      if (expanded) {
        const raw = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
        line += "\n" + theme.fg("dim", raw);
      }
      return new Text(line, 0, 0);
    },
    });
  }

  const SUBCOMMANDS = ["status", "cache stats", "cache clear", "cache prune", "scope global", "scope project", "ttl ", "max ", "reindex", "handlers"];

  pi.registerCommand("magpi", {
    description: "MagPi: status | cache stats|clear|prune | scope global|project | ttl <hours> | max <MB> | reindex | handlers",
    getArgumentCompletions: (prefix) => {
      const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const cfg = loadConfig(ctx.cwd, ctx.isProjectTrusted());
      const writeRoot = cacheRoot(ctx.cwd, cfg);
      const roots: Array<[string, string]> = [
        ["G", globalCacheRoot()],
        ["L", projectCacheRoot(ctx.cwd)],
      ];
      const [cmd, arg] = (args ?? "").trim().split(/\s+/);

      const notify = (lines: string[], level: "info" | "error" = "info") =>
        ctx.ui.notify(lines.join("\n"), level);

      switch (cmd || "status") {
        case "status": {
          notify([
            `MagPi | write scope: ${cfg.cacheScope} | ttl: ${cfg.ttlHours}h | max: ${cfg.maxCacheMB > 0 ? `${cfg.maxCacheMB}MB` : "off"}`,
            ...roots.map(([tag, root]) => {
              const s = cache.stats(root);
              return `${root === writeRoot ? "▸" : " "}${tag} ${s.entries} entries (${formatSize(s.bytes)}) | ${root}`;
            }),
            `handlers: ${listHandlers().map((h) => h.name).join(", ")}`,
          ]);
          return;
        }
        case "cache": {
          if (arg === "clear") {
            cache.clear(writeRoot);
            updateStatus(ctx);
            notify([`Cache cleared (${cfg.cacheScope}): ${writeRoot}`]);
          } else if (arg === "prune") {
            const removed = cache.prune(writeRoot, cfg.ttlHours);
            updateStatus(ctx);
            notify([`Pruned ${removed} expired entr${removed === 1 ? "y" : "ies"} from ${cfg.cacheScope} cache (older than ${cfg.ttlHours}h)`]);
          } else {
            const entries = roots
              .flatMap(([tag, root]) => cache.listEntries(root).map((e) => ({ tag, e })))
              .sort((a, b) => a.e.ageHours - b.e.ageHours);
            const total = entries.length;
            notify([
              ...roots.map(([tag, root]) => {
                const s = cache.stats(root);
                return `${root === writeRoot ? "▸" : " "}${tag} ${s.entries} entries (${formatSize(s.bytes)}) | ${root}`;
              }),
              ...entries.slice(0, 15).map(({ tag, e }) => `${tag} ${e.ageHours.toFixed(1)}h  ${e.meta.kind.padEnd(12)} ${e.meta.url}`),
              total > 15 ? `... and ${total - 15} more` : "",
            ].filter(Boolean));
          }
          return;
        }
        case "scope": {
          if (arg !== "global" && arg !== "project") {
            notify(["Usage: /magpi scope global|project"], "error");
            return;
          }
          // scope is a per-project concern; store it project-locally when trusted
          const target = ctx.isProjectTrusted() ? projectConfigPath(ctx.cwd) : globalConfigPath();
          saveConfig(target, { cacheScope: arg });
          updateStatus(ctx);
          notify([`Write scope set to ${arg} (in ${target}); reads always union both caches`]);
          return;
        }
        case "ttl": {
          const hours = Number(arg);
          if (!Number.isFinite(hours) || hours <= 0) {
            notify(["Usage: /magpi ttl <hours>"], "error");
            return;
          }
          saveConfig(globalConfigPath(), { ttlHours: hours });
          notify([`Cache TTL set to ${hours}h`]);
          return;
        }
        case "max": {
          const mb = Number(arg);
          if (!Number.isFinite(mb) || mb < 0) {
            notify(["Usage: /magpi max <MB> (0 = unlimited)"], "error");
            return;
          }
          saveConfig(globalConfigPath(), { maxCacheMB: mb });
          if (mb > 0) {
            const removed = cache.evictToBudget(writeRoot, mb * 1024 * 1024);
            updateStatus(ctx);
            notify([`Cache budget set to ${mb}MB${removed ? `; evicted ${removed} least-recently-used entr${removed === 1 ? "y" : "ies"}` : ""}`]);
          } else {
            notify(["Cache budget disabled"]);
          }
          return;
        }
        case "reindex": {
          const counts = roots.map(([tag, root]) => `${tag}: ${cache.reindexRoot(root)}`);
          updateStatus(ctx);
          notify([`Search index rebuilt from disk. Entries indexed: ${counts.join(", ")}`]);
          return;
        }
        case "handlers": {
          notify(listHandlers().map((h) => `${h.name}: ${h.description}`));
          return;
        }
        default:
          notify([`Unknown subcommand: ${cmd}`, "Try: status | cache stats|clear | scope | ttl | handlers"], "error");
      }
    },
  });
}
