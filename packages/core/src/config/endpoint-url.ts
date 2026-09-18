export * as EndpointURL from "./endpoint-url"

// Lay users cannot be asked to type a correct API base URL, and the field the product gives them
// ("the server address") is one they will fill with whatever their provider's docs show — the full
// `/v1/chat/completions` endpoint, a bare host, a host with no scheme, or a URL copied from a
// different API surface entirely. Every competing harness normalizes this and every one of them has
// been burned by the same handful of shapes, so this module is the pure half of that defence: given
// ONE string a person typed, produce the ordered list of base URLs worth PROBING. It opens no socket
// and knows nothing about models; the caller (`handlers/provider.ts`) does the probing and keeps the
// address that actually answered.
//
// ⚠️ WHAT THE COMPETITORS TEACH, and the caveat each turned into a rule here:
//
//   · A trailing slash is not identity. Open WebUI shipped `f"{url}/models"` and a single trailing
//     slash produced `//models` and an empty model list; LiteLLM's CLI now `rstrip`s once at the
//     door. Every URL this module returns ends in exactly one `/`.
//   · Do NOT blindly append `/v1`. redpanda's ai-sdk-go DELETED its `normalizeBaseURL()` for this
//     reason: gateways mount their compat surface at their own path (`/v1/openai`,
//     `/api/v1`, `/v1beta/openai`), and Google's is `/v1beta/openai/`. So a path that already
//     carries a version segment (`v1`, `v1beta`, `v2`…) is left ALONE, mount prefix and all.
//   · Do NOT truncate past a version marker. LibreChat's `extractBaseURL()` assumes `/v1` is the
//     entry point and shortens deeper paths, which 404s Huawei ModelArts Studio's
//     `…/v1/infers/{uuid}/v1/chat/completions`. This module never truncates to a version; it only
//     strips known OPERATION suffixes and appends `/v1` when nothing version-shaped is present.
//   · A user pasting a full endpoint is normal, not an error. OpenClaw/LibreChat both grew a
//     special case for `…/chat/completions`; here it is one entry in an operation vocabulary that
//     also covers `/completions`, `/responses`, `/embeddings`, `/models`, `/rerank` and the
//     vectorize surface, matched longest-first so `chat/completions` cannot be mistaken for
//     `completions`.
//   · Bare hosts. `model-probe` assumes `https` for public gateways and `http` for loopback; a
//     schemeless `localhost:1234` must not be read as a public host. Private/LAN names default to
//     `http` because that is what a model server on your own network actually speaks.
//
// ⚠️ WHAT THIS MODULE DOES NOT DO: it never guesses that a URL is CORRECT. It produces the very
// small set of addresses a probe should try, and the probe's answer is the only thing allowed to
// decide. `canonical` is the address a lay user almost certainly meant; it is not a claim that
// anything is listening there.

/** A scheme at the front, e.g. `http://`, `https://`. */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//

/**
 * A `scheme:` that is NOT `http(s)://` and NOT a `host:port` — a class of address that merely looks
 * like a server (`mailto:user@example.com`, `file:/etc`). The negative lookahead is what tells the
 * two apart: `localhost:8000` is a host and a port, `mailto:user` is not.
 */
const OPAQUE_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:(?![/\d])/

/** A path segment that names an API version: `v1`, `v1beta`, `v2`, `v4`, `v1.0`. */
const VERSION = /^v\d+[a-z0-9._-]*$/i

/**
 * Terminal segments that name an OPERATION, not a base path. Longest-first below so a two-segment
 * operation is stripped whole: `…/chat/completions` must not degrade to `…/chat`.
 */
const OPERATIONS: readonly (readonly string[])[] = [
  ["chat", "completions"],
  ["images", "generations"],
  ["images", "edits"],
  ["audio", "transcriptions"],
  ["audio", "translations"],
  ["vectorize", "upsert"],
  ["vectorize", "query"],
  ["vectorize", "delete"],
  ["audio", "speech"],
  ["completions"],
  ["responses"],
  ["embeddings"],
  ["rerank"],
  ["moderations"],
  ["models"],
  ["vectorize"],
]

const isVersion = (segment: string): boolean => VERSION.test(segment)

const endsWith = (segments: readonly string[], suffix: readonly string[]): boolean =>
  segments.length >= suffix.length &&
  suffix.every((segment, index) => segments[segments.length - suffix.length + index] === segment)

/** Strip every trailing operation sequence, longest match first, until none is left. */
const stripOperations = (segments: readonly string[]): readonly string[] => {
  let remaining = segments.slice()
  for (;;) {
    const operation = OPERATIONS.find((candidate) => endsWith(remaining, candidate))
    if (operation === undefined) return remaining
    remaining = remaining.slice(0, remaining.length - operation.length)
  }
}

/** `true` for the hosts whose model servers speak plain `http` on a user's own machine or LAN. */
const hostLooksLocal = (host: string): boolean => {
  const name = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
  if (name === "localhost" || name === "::1" || name === "0.0.0.0") return true
  if (/^127\./.test(name) || /^10\./.test(name) || /^192\.168\./.test(name) || /^169\.254\./.test(name)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(name)) return true
  if (/\.(local|internal|lan|home\.arpa)$/.test(name)) return true
  // A bare name with no dot is not a public host: it resolves on the local network.
  return !name.includes(".")
}

/** The scheme a schemeless address almost certainly means: local servers are `http`, the WAN `https`. */
const defaultScheme = (withoutScheme: string): "http" | "https" => {
  try {
    return hostLooksLocal(new URL(`http://${withoutScheme}`).hostname) ? "http" : "https"
  } catch {
    return "https"
  }
}

/** Give a schemeless or protocol-relative address the scheme its host implies. */
const withScheme = (raw: string): string => {
  if (SCHEME.test(raw)) return raw
  if (raw.startsWith("//")) return `${defaultScheme(raw.slice(2))}:${raw}`
  return `${defaultScheme(raw)}://${raw}`
}

/** `scheme://host:port/segments/` — one trailing slash, no query, no fragment, no credentials. */
const build = (url: URL, segments: readonly string[]): string =>
  `${url.protocol}//${url.host}/${segments.join("/")}${segments.length > 0 ? "/" : ""}`

export interface Derived {
  /**
   * The base URLs a probe should try, in order. Always at most two, always ending in `/`:
   *   · `canonical` — the address a lay user almost certainly meant;
   *   · the same path with a trailing `v1` dropped, for a server that serves at its root.
   * Empty when the input cannot be read as an http(s) address at all.
   */
  readonly candidates: readonly string[]
  /** `candidates[0]`, or `undefined` when the input is unreadable. */
  readonly canonical?: string
  /**
   * Scheme completed and known operation suffixes stripped, but `/v1` NEVER appended and no version
   * ever dropped — the conservative fix to apply when nothing could be probed. Preserves a
   * nonstandard mount (`…/openai`) that appending `/v1` would break.
   */
  readonly strippedBase?: string
}

/**
 * Derive the addresses worth probing from one line a person typed.
 *
 * ⚠️ Order is a COST decision as much as a correctness one: the caller stops at the first candidate
 * that answers, so the convention (`/v1/`) is asked first and the permissive fallback last.
 */
export function derive(raw: string): Derived {
  const trimmed = raw.trim()
  if (trimmed === "") return { candidates: [] }
  if (!SCHEME.test(trimmed) && OPAQUE_SCHEME.test(trimmed)) return { candidates: [] }

  let url: URL
  try {
    url = new URL(withScheme(trimmed))
  } catch {
    return { candidates: [] }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { candidates: [] }

  const original = url.pathname.split("/").filter((segment) => segment !== "")
  const stripped = stripOperations(original)
  const versioned = stripped.some(isVersion)
  const canonicalSegments = versioned ? stripped : [...stripped, "v1"]

  const canonical = build(url, canonicalSegments)
  const last = stripped[stripped.length - 1]
  const alternateSegments = last !== undefined && isVersion(last) ? stripped.slice(0, -1) : stripped
  const alternate = build(url, alternateSegments)

  return {
    candidates: alternate === canonical ? [canonical] : [canonical, alternate],
    canonical,
    strippedBase: build(url, stripped),
  }
}

/** See {@link derive}. */
export function candidates(raw: string): readonly string[] {
  return derive(raw).candidates
}

/** The single best syntactic guess, or `undefined` when the input is unreadable. */
export function canonical(raw: string): string | undefined {
  return derive(raw).canonical
}

/**
 * The conservative normalization: scheme completed, operation suffix stripped, `/v1` NOT appended.
 * Use this when nothing could be probed, so a nonstandard mount the user got right stays untouched.
 */
export function stripped(raw: string): string | undefined {
  return derive(raw).strippedBase
}

/**
 * How many usable model ids an OpenAI-shaped `/models` body carries.
 *
 * `-1` means the body is not an OpenAI model list at all (HTML, an error object, a proxy page);
 * `0` means it IS a list but lists nothing usable; `>0` is the only strong evidence. The handler
 * uses the sign, never the count, to decide whether a probed address is a valid access point —
 * which is exactly the distinction the local-runtime sweep had to invent for the same reason.
 */
export function modelListCount(body: unknown): number {
  if (typeof body !== "object" || body === null) return -1
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return -1
  return data.filter(
    (item) => typeof (item as { id?: unknown } | null)?.id === "string" && (item as { id: string }).id.length > 0,
  ).length
}
