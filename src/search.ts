import { parseHTML } from "linkedom";
import { decodeEntities } from "./html.js";
import { getJson, getText } from "./handlers/handler.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  source: string;
}

export type SearchSource = "ddg" | "wikipedia" | "hn";

/** Exported separately so the parser is testable offline. */
export function parseDdgLite(html: string): SearchResult[] {
  const { document } = parseHTML(html);
  const links = Array.from(document.querySelectorAll("a")).filter((a: any) => {
    const href = a.getAttribute("href") ?? "";
    return href.includes("uddg=") || /^https?:\/\//.test(href);
  });
  const snippets = Array.from(document.querySelectorAll("td.result-snippet")).map((td: any) =>
    (td.textContent ?? "").trim(),
  );
  const results: SearchResult[] = [];
  for (const a of links as any[]) {
    let href: string = a.getAttribute("href") ?? "";
    const m = href.match(/uddg=([^&]+)/);
    if (m) href = decodeURIComponent(m[1]);
    if (!/^https?:\/\//.test(href)) continue;
    if (/duckduckgo\.com/.test(href)) continue; // ads / internal
    const title = decodeEntities((a.textContent ?? "").trim());
    if (!title) continue;
    results.push({ title, url: href, snippet: snippets[results.length], source: "ddg" });
    if (results.length >= 8) break;
  }
  return results;
}

async function searchDdg(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const { text } = await getText(
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    signal,
  );
  return parseDdgLite(text);
}

async function searchWikipedia(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const d = await getJson<any>(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=8&format=json&formatversion=2&srsearch=${encodeURIComponent(query)}`,
    signal,
  );
  return (d.query?.search ?? []).map((s: any) => ({
    title: s.title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, "_"))}`,
    snippet: decodeEntities(String(s.snippet ?? "").replace(/<[^>]+>/g, "")),
    source: "wikipedia",
  }));
}

async function searchHn(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const d = await getJson<any>(
    `https://hn.algolia.com/api/v1/search?hitsPerPage=8&query=${encodeURIComponent(query)}`,
    signal,
  );
  return (d.hits ?? [])
    .filter((h: any) => h.title)
    .map((h: any) => ({
      title: h.title,
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      snippet: `${h.points ?? 0} points, ${h.num_comments ?? 0} comments | https://news.ycombinator.com/item?id=${h.objectID}`,
      source: "hn",
    }));
}

const SOURCES: Record<SearchSource, (q: string, s?: AbortSignal) => Promise<SearchResult[]>> = {
  ddg: searchDdg,
  wikipedia: searchWikipedia,
  hn: searchHn,
};

export interface SearchOutcome {
  results: SearchResult[];
  errors: string[];
}

/**
 * auto: ddg first (broadest), then wikipedia, then hn; stop at the first
 * source that returns anything. All are rate-limited free endpoints; failures
 * are expected and reported, not fatal.
 */
export async function webSearch(
  query: string,
  source: SearchSource | "auto",
  signal?: AbortSignal,
  onSource?: (source: SearchSource) => void,
): Promise<SearchOutcome> {
  const order: SearchSource[] = source === "auto" ? ["ddg", "wikipedia", "hn"] : [source];
  const errors: string[] = [];
  for (const s of order) {
    onSource?.(s);
    try {
      const results = await SOURCES[s](query, signal);
      if (results.length > 0) return { results, errors };
      errors.push(`${s}: no results`);
    } catch (e) {
      errors.push(`${s}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { results: [], errors };
}

export function formatResults(results: SearchResult[]): string {
  return results
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.title} [${r.source}]`, `   ${r.url}`];
      if (r.snippet) lines.push(`   ${r.snippet}`);
      return lines.join("\n");
    })
    .join("\n");
}
