export * as WebSearchEngine from "./engine"

import { Effect, Schema } from "effect"

import { InstallationVersion } from "../installation/version"

// Web search, built in (todo.md → "Web search — a built-in fallback so it just works for lay
// users"). A normal person cannot stand up a SearXNG, so an instance with nothing configured must
// still be able to search; a power user's own SearXNG must still win when they have one.
//
// WHAT the built-in IS — the open design question, settled by the vision rather than escalated
// (AGENTS.md design principle #1): NOT a bundled SearXNG process. That means Python + Docker,
// which cannot ride into a phone or a packaged binary and is the opposite of "loads into memory
// when an agent asks". Instead this is SearXNG's *idea* — ask several free engines at once and
// merge — implemented in-process over plain fetch. Portable everywhere Bun runs, no daemon, no
// install, and it costs nothing until the first query.
//
// The honest tradeoff, stated because it shapes the code: free engines throttle and change their
// markup. So every engine is INDEPENDENT and best-effort (one dying never fails the search), the
// engine list is runtime-editable (the self-healing law: an agent can repair a broken engine
// through config, no rebuild), and a search where everything failed says so plainly instead of
// returning an empty list that reads like "no results exist".

export class SearchError extends Schema.TaggedErrorClass<SearchError>()("WebSearch.SearchError", {
  reason: Schema.String,
}) {}

export interface Result {
  readonly title: string
  readonly url: string
  readonly snippet?: string
  /** Which engine produced it — kept through merging so the agent can weigh a source. */
  readonly engine: string
}

export interface SearchOptions {
  readonly limit: number
  /** Aborts a slow engine rather than making the whole search wait on it. */
  readonly timeoutMs: number
}

export interface Engine {
  readonly id: string
  /** Human name for the honest "everything failed" message. */
  readonly name: string
  readonly search: (query: string, options: SearchOptions) => Effect.Effect<readonly Result[], SearchError>
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** A browser-ish UA. Not a disguise — several free endpoints simply 403 an empty agent, and the
 *  request genuinely is a person's search, made on their own machine, at their own request. */
export const USER_AGENT = `Mozilla/5.0 (compatible; NovaClaw/${InstallationVersion}; +https://novaclaw.app)`

// ── pure parsing + merging (unit-tested; the part most likely to rot is the part most tested) ────

const decodeEntities = (text: string): string =>
  text
    .replaceAll(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replaceAll(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")

/** Strip tags and collapse whitespace — search snippets arrive as marked-up fragments. */
export const stripHtml = (html: string): string => decodeEntities(html.replaceAll(/<[^>]*>/g, "")).replaceAll(/\s+/g, " ").trim()

/** DuckDuckGo's HTML results wrap every outbound link in a redirect; the real URL is inside. */
export const unwrapRedirect = (href: string): string => {
  const trimmed = href.trim()
  const absolute = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed
  try {
    const url = new URL(absolute, "https://duckduckgo.com")
    const wrapped = url.searchParams.get("uddg")
    if (wrapped !== null && wrapped.length > 0) return wrapped
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : absolute
  } catch {
    return absolute
  }
}

/**
 * Parse DuckDuckGo's no-JavaScript HTML results. Deliberately loose: it matches the anchor that
 * carries the result class and the snippet that follows, rather than assuming a document shape, so
 * a layout tweak degrades to fewer results instead of zero.
 */
export const parseDuckDuckGo = (html: string, limit: number): readonly Result[] => {
  const out: Result[] = []
  const anchor = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = anchor.exec(html)) !== null && out.length < limit) {
    const url = unwrapRedirect(match[1] ?? "")
    const title = stripHtml(match[2] ?? "")
    if (title.length === 0 || !/^https?:/i.test(url)) continue
    // The snippet lives after the title in the same result block.
    const rest = html.slice(match.index, match.index + 4000)
    const snippetMatch = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(rest)
    const snippet = snippetMatch === null ? undefined : stripHtml(snippetMatch[1] ?? "")
    out.push({ title, url, engine: "duckduckgo", ...(snippet === undefined || snippet.length === 0 ? {} : { snippet }) })
  }
  return out
}

/**
 * Wikipedia's FULL-TEXT search reply (`action=query&list=search`). ⚠️ Not `opensearch`, which the
 * first cut used: opensearch matches title PREFIXES, so a descriptive query like "bun javascript
 * runtime" returns nothing at all — found by running it against the live API, not by reading docs.
 * Snippets arrive as marked-up HTML with the match highlighted, so they need stripping.
 */
export const parseWikipedia = (body: unknown, limit: number): readonly Result[] => {
  const rows = (body as { query?: { search?: unknown } })?.query?.search
  if (!Array.isArray(rows)) return []
  const out: Result[] = []
  for (const row of rows) {
    if (out.length >= limit) break
    const entry = row as Record<string, unknown>
    const title = entry["title"]
    if (typeof title !== "string" || title.length === 0) continue
    const snippet = typeof entry["snippet"] === "string" ? stripHtml(entry["snippet"]) : undefined
    out.push({
      title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`,
      engine: "wikipedia",
      ...(snippet === undefined || snippet.length === 0 ? {} : { snippet }),
    })
  }
  return out
}

/** A SearXNG instance's JSON API (`/search?format=json`) — the power-user override. */
export const parseSearxng = (body: unknown, limit: number): readonly Result[] => {
  const rows = (body as { results?: unknown })?.results
  if (!Array.isArray(rows)) return []
  const out: Result[] = []
  for (const row of rows) {
    if (out.length >= limit) break
    const entry = row as Record<string, unknown>
    const title = entry["title"]
    const url = entry["url"]
    if (typeof title !== "string" || typeof url !== "string") continue
    const snippet = entry["content"]
    out.push({ title, url, engine: "searxng", ...(typeof snippet === "string" && snippet.length > 0 ? { snippet } : {}) })
  }
  return out
}

/** Same page, different address — so merging doesn't show one result three times. */
export const canonicalUrl = (raw: string): string => {
  try {
    const url = new URL(raw)
    url.hash = ""
    for (const key of [...url.searchParams.keys()]) if (key.startsWith("utm_") || key === "ref" || key === "fbclid") url.searchParams.delete(key)
    const path = url.pathname.replace(/\/+$/, "")
    return `${url.hostname.replace(/^www\./, "")}${path}${url.search}`.toLowerCase()
  } catch {
    return raw.trim().toLowerCase()
  }
}

/**
 * Merge several engines' rankings into one — reciprocal rank fusion, which is what a metasearch
 * engine is FOR: a page two engines both rank highly outranks one engine's top hit. Agreement is
 * the only quality signal available without crawling anything ourselves.
 */
export const mergeResults = (lists: readonly (readonly Result[])[], limit: number): readonly Result[] => {
  const scored = new Map<string, { result: Result; score: number; engines: Set<string> }>()
  for (const list of lists) {
    list.forEach((result, index) => {
      const key = canonicalUrl(result.url)
      const existing = scored.get(key)
      const contribution = 1 / (index + 2) // rank 0 → 0.5, rank 1 → 0.33 …
      if (existing === undefined) {
        scored.set(key, { result, score: contribution, engines: new Set([result.engine]) })
        return
      }
      existing.score += contribution
      existing.engines.add(result.engine)
      // Keep the fullest description available across engines.
      if ((existing.result.snippet?.length ?? 0) < (result.snippet?.length ?? 0)) existing.result = { ...existing.result, snippet: result.snippet }
    })
  }
  return [...scored.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ result, engines }) => ({ ...result, engine: [...engines].sort().join("+") }))
}

// ── the built-in engines ────────────────────────────────────────────────────────────────────────

const fetchText = (fetchImpl: FetchLike, url: string, options: SearchOptions, init?: RequestInit) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(options.timeoutMs),
        headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9", ...(init?.headers ?? {}) },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.text()
    },
    catch: (error) => new SearchError({ reason: String(error) }),
  })

/** DuckDuckGo's HTML endpoint — no key, no account, and it answers general queries. */
export const duckduckgo = (fetchImpl: FetchLike): Engine => ({
  id: "duckduckgo",
  name: "DuckDuckGo",
  search: (query, options) =>
    fetchText(fetchImpl, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, options, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ q: query }).toString(),
    }).pipe(Effect.map((html) => parseDuckDuckGo(html, options.limit))),
})

/** Wikipedia — a real JSON API with no key and a generous policy. Narrow, but when a question is
 *  factual it is the best answer in the set, and it keeps search useful when scrapers are blocked. */
export const wikipedia = (fetchImpl: FetchLike): Engine => ({
  id: "wikipedia",
  name: "Wikipedia",
  search: (query, options) =>
    fetchText(
      fetchImpl,
      `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=${options.limit}&srsearch=${encodeURIComponent(query)}`,
      options,
    ).pipe(
      Effect.flatMap((text) =>
        Effect.try({
          try: () => parseWikipedia(JSON.parse(text) as unknown, options.limit),
          catch: () => new SearchError({ reason: "Wikipedia returned something unreadable" }),
        }),
      ),
    ),
})

/** A user's own SearXNG instance. Same contract as the built-ins, so it composes rather than
 *  branching the pipeline — it just gets to win (see service.ts). */
export const searxng = (fetchImpl: FetchLike, baseUrl: string): Engine => ({
  id: "searxng",
  name: `SearXNG (${baseUrl})`,
  search: (query, options) =>
    fetchText(fetchImpl, `${baseUrl.replace(/\/+$/, "")}/search?format=json&q=${encodeURIComponent(query)}`, options).pipe(
      Effect.flatMap((text) =>
        Effect.try({
          try: () => parseSearxng(JSON.parse(text) as unknown, options.limit),
          catch: () => new SearchError({ reason: "That SearXNG instance did not return JSON — is its JSON format enabled?" }),
        }),
      ),
    ),
})
