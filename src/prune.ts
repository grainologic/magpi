interface MessageLike {
  role: string;
  toolName?: string;
  content?: unknown;
  details?: { contentPath?: string; treePath?: string };
}

/** Chars of new elidable preview text that trigger an elision pass (~5k tokens). */
const ELIDE_THRESHOLD = 20_000;

// Paths whose previews we have committed to eliding. The context event hands us
// a fresh deep copy of the original messages on every LLM call, so the decision
// must live outside the messages or it would flip-flop between calls and break
// the prompt cache repeatedly. Once a path is in here it stays elided.
// ponytail: module state, resets on session restart; that costs one extra cache
// break per restart, which is what a restart costs anyway.
const committed = new Set<string>();

function previewChars(m: MessageLike): number {
  if (typeof m.content === "string") return m.content.length;
  if (!Array.isArray(m.content)) return 0;
  let n = 0;
  for (const block of m.content as { text?: unknown }[]) {
    if (typeof block?.text === "string") n += block.text.length;
  }
  return n;
}

/**
 * Context thrift: old magpi_fetch previews are dead weight; the full text is
 * already on disk. Replace old previews (all but the most recent `keepRecent`)
 * with a one-line pointer to the cached file. Mutates in place.
 *
 * Rewriting an old message invalidates the prompt cache from that point on, so
 * elision is batched: nothing happens until the not-yet-elided old previews
 * add up to `threshold` chars, then all of them are elided in one pass. One
 * cache break amortized over several fetches, and small previews never break
 * the cache at all.
 */
export function elideFetchPreviews<T extends MessageLike>(
  messages: T[],
  keepRecent = 2,
  threshold = ELIDE_THRESHOLD,
): T[] {
  const fetches = messages.filter(
    (m) => m.role === "toolResult" && m.toolName === "magpi_fetch" && m.details?.contentPath,
  );
  const eligible = fetches.slice(0, Math.max(0, fetches.length - keepRecent));

  const freshChars = eligible
    .filter((m) => !committed.has(m.details!.contentPath!))
    .reduce((n, m) => n + previewChars(m), 0);
  if (freshChars > threshold) {
    for (const m of eligible) committed.add(m.details!.contentPath!);
  }

  for (const m of eligible) {
    if (!committed.has(m.details!.contentPath!)) continue;
    const d = m.details!;
    m.content = [
      {
        type: "text",
        text: `(magpi: preview elided to save context; full text at ${d.contentPath}${d.treePath ? `; files at ${d.treePath}` : ""})`,
      },
    ];
  }
  return messages;
}
