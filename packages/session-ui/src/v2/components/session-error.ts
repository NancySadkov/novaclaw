/**
 * THE chokepoint that turns a session fault into display text.
 *
 * Every surface that renders a `Session.Error.Unknown` — the transcript's turn-failure box, the
 * "Interrupted" divider, a tool card's subtitle — goes through `sessionErrorDisplay`. It is one
 * function on purpose: a second formatter is how the next divergence ships, and this file exists
 * because there were three (the transcript's `err().message`, its `/interrupted/i` sniff, and the
 * tool card's `state.error.message`) with no shared answer between them.
 *
 * Two jobs, in order of how much they matter to a user:
 *
 * 1. **Raw transport detail never reaches the screen.** Today a user whose local model server is
 *    off reads, inside their own conversation:
 *    `HTTP transport failed: fetch failed | cause: connect ECONNREFUSED 192.168.178.40:8000`.
 *    That is the stack-trace-in-your-face AGENTS.md's *Identity & mission* clause forbids, and it
 *    is a lay user's single most likely first failure. `isMachineDetail` catches that shape and
 *    the fault is described as a calm sentence instead — one that still NAMES the endpoint, so
 *    ruling 2's "an unavailable subsystem names itself" is satisfied rather than traded away.
 *    (Hiding the address would be the other failure: a fault described uselessly.)
 * 2. **A translatable key becomes possible.** A free-form provider string cannot be translated
 *    into the 19 locales this product ships. A class-level sentence can, so every recognised
 *    `_tag` yields `key` + `params` for the HEADLINE, and the provider's own words — which no key
 *    could ever translate — travel separately as `detail`. Splitting them is the whole point:
 *    before, the two were one string and neither half could be handled correctly.
 *
 * ⚠️ **The message is never replaced, only re-presented.** `Session.Error.Unknown.message` stays
 * the raw text on the wire and in the record — the model reads it back on the next turn
 * (`toLLMMessages` replays it as "[Previous turn failed …]") and can act on it. This module
 * decides only what a HUMAN sees.
 *
 * ⚠️ **An untagged row must still render.** Every session record written before `_tag` existed
 * carries `{ type:"unknown", message }`. With no tag the message is used verbatim, exactly as
 * before — unless it is machine detail, in which case an old row gets the same calm treatment a
 * new one does. Nothing here requires the tag to be present.
 */

/**
 * Structurally typed on purpose: the generated SDK type (`SessionErrorUnknown`) does not declare
 * `_tag`/`retryable` until `packages/sdk/openapi.json` is regenerated, but the RUNTIME value
 * carries them the moment the schema does. Accepting the fields as optional means this helper
 * reads them today and keeps type-checking after the regen, with no hand-edit of generated code.
 */
export type SessionErrorLike = {
  readonly message?: string | null
  readonly _tag?: string | null
  readonly retryable?: boolean | null
  /**
   * The wire discriminant. Nothing here reads it — every session error is `"unknown"` today — but the
   * real decoded value carries it, so leaving it off made this type reject the very shape it describes
   * the moment a caller passed an object LITERAL (excess-property checking does not fire through a
   * variable, which is why the tests caught it and production did not).
   */
  readonly type?: string | null
}

export type SessionErrorDisplay = {
  /** `interrupted` = the user stopped it; render a divider, not an alert. */
  readonly kind: "interrupted" | "fault"
  /**
   * The i18n key for `headline`, or `undefined` when `headline` is the provider's own words.
   * ⚠️ These keys do not exist yet — defining them is a follow-up in `packages/app/src/i18n`.
   */
  readonly key?: string
  /** Interpolation params for `key`. */
  readonly params?: { readonly endpoint?: string }
  /** What to show. Guaranteed non-empty and free of raw transport detail. */
  readonly headline: string
  /**
   * The provider's own words, when they exist, are readable, and say more than the headline.
   * Also guaranteed free of machine detail — a surface may render it under the headline (or
   * behind a Developer-mode disclosure) without leaking a stack trace into the conversation.
   */
  readonly detail?: string
  /** The wire's own answer to "can retrying this turn work?" — `undefined` = not stated. */
  readonly retryable?: boolean
  /** Whether a surface should OFFER retry. Falls back to a per-class default when unstated. */
  readonly canRetry: boolean
}

/**
 * The display arms, keyed by `SessionMessage.ErrorTags`. Kept as a record rather than a `switch`
 * so a test can assert it covers the schema's vocabulary exactly — ruling 10's closed compiled
 * set, mechanically checked (ruling 1) instead of asserted in a comment.
 *
 * `ToolFailure` has no class sentence worth showing (a tool's own message is the useful text), so
 * its `text` is the last-resort wording used only when that message is unusable.
 */
const ARMS = {
  InvalidRequest: { key: "session.error.invalidRequest", text: "The model rejected this request." },
  NoRoute: { key: "session.error.noRoute", text: "No route is configured for this model." },
  Authentication: {
    key: "session.error.authentication",
    text: "The model provider rejected this model's credentials.",
  },
  RateLimit: {
    key: "session.error.rateLimit",
    text: "The model provider is rate-limiting this account — try again in a moment.",
  },
  QuotaExceeded: { key: "session.error.quotaExceeded", text: "This account is out of quota with the model provider." },
  ContentPolicy: {
    key: "session.error.contentPolicy",
    text: "The model provider refused this request under its content policy.",
  },
  ProviderInternal: { key: "session.error.providerInternal", text: "The model server hit an internal error." },
  Transport: {
    key: "session.error.transport",
    text: "Can't reach the model server. It may be turned off, still starting, or on another network.",
  },
  InvalidProviderOutput: { key: "session.error.invalidProviderOutput", text: "The model's reply could not be read." },
  UnknownProvider: { key: "session.error.unknownProvider", text: "The model provider returned an error." },
  Interrupted: { key: "session.error.interrupted", text: "Interrupted" },
  ToolFailure: { key: "session.error.toolFailure", text: "A tool failed." },
} as const satisfies Record<string, { readonly key: string; readonly text: string }>

/** Tags whose own message says more than the class sentence, so the message stays the headline. */
const PROSE_FIRST = new Set<string>(["ToolFailure"])

/** Endpoint-naming variant of the Transport arm — used whenever a host:port can be recovered. */
const TRANSPORT_WITH_ENDPOINT = {
  key: "session.error.transportEndpoint",
  text: (endpoint: string) =>
    `Can't reach the model server at ${endpoint}. It may be turned off, still starting, or on another network.`,
}

/** Last-resort headline when the fault carried nothing a person can use and no known class. */
const GENERIC = { key: "session.error.unknown", text: "The turn failed before it finished." }

/** Classes where retrying the SAME turn can plausibly work, when the wire did not say. */
const RETRYABLE_BY_DEFAULT = new Set<string>(["Transport", "ProviderInternal", "RateLimit"])

/** Every arm the display knows about — exported so a test can diff it against the schema's set. */
export const sessionErrorArms: ReadonlyArray<string> = Object.keys(ARMS)

/**
 * Machine detail a person cannot act on and must never read in a chat. Deliberately NARROW: a
 * URL alone is not detail (naming the endpoint is the point), and a provider's own prose is kept
 * even when it mentions a host — the offline-policy block, for instance, explains how to allow a
 * host, and losing that text would describe the fault falsely.
 */
const MACHINE_DETAIL = [
  /\b(?:ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPROTO|EPIPE)\b/,
  /\bERR_[A-Z0-9_]{3,}\b/,
  /(?:^|\s)\|\s*cause:/i,
  /(?:^|\s)cause:\s/i,
  /\bfetch failed\b/i,
  /\n\s+at\s+\S/,
]

export function isMachineDetail(text: string): boolean {
  return MACHINE_DETAIL.some((pattern) => pattern.test(text))
}

/** A bare `SomethingError` token left over after stripping framing — a name, not a sentence. */
const BARE_ERROR_TOKEN = /^[A-Za-z][A-Za-z0-9]*Error$/

/**
 * `host:port` for the failing endpoint, recovered from whatever shape the message carries — the
 * executor's own `(target <url>)` suffix first, then the bare `ip:port` a Node errno line ends
 * with, then any absolute URL. Credentials are stripped: redacting a URL is upstream's job, but a
 * headline is the last place a token may appear.
 */
export function endpointOf(message: string): string | undefined {
  const target = /\(target\s+([^)\s]+)\)/.exec(message)?.[1]
  const fromTarget = target === undefined ? undefined : authorityOf(target)
  if (fromTarget) return fromTarget
  const hostPort = /\b(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}\b/.exec(message)?.[0]
  if (hostPort) return hostPort
  const url = /\bhttps?:\/\/[^\s)"']+/.exec(message)?.[0]
  const fromUrl = url === undefined ? undefined : authorityOf(url)
  if (fromUrl) return fromUrl
  return /\blocalhost:\d{1,5}\b/.exec(message)?.[0]
}

function authorityOf(url: string): string | undefined {
  const withoutScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
  const authority = withoutScheme.split(/[/?#]/)[0]
  if (authority === undefined || authority.length === 0) return undefined
  const afterCredentials = authority.slice(authority.lastIndexOf("@") + 1)
  return afterCredentials.length > 0 ? afterCredentials : undefined
}

/**
 * Strip the framing the executor adds so what is left is the provider's own words: the
 * `HTTP transport failed:` prefix, a `<Reason>Error —` prefix, and the trailing `(target …)`
 * (whose content moves into the headline as `endpoint`).
 */
function tidy(message: string): string {
  return message
    .replace(/\(target\s+[^)\s]+\)\s*$/, "")
    .replace(/^HTTP transport failed:\s*/i, "")
    .replace(/^[A-Za-z]+Error\s*(?:—|--|-)\s*/, "")
    .trim()
}

/** The provider's own words, or `undefined` when the message held nothing showable. */
function proseOf(message: string): string | undefined {
  const detail = tidy(message)
  if (detail.length === 0 || isMachineDetail(detail) || BARE_ERROR_TOKEN.test(detail)) return undefined
  return detail
}

/**
 * A `Transport` reason that carries its own DESCRIPTION rather than a network failure.
 *
 * `packages/llm/src/route/executor.ts` emits two different things under one reason: a real
 * transport failure (`HTTP transport failed: <errno detail> (target …)`) and a *described*
 * HttpClientError, formatted `HTTP transport failed: <ReasonTag> — <description>` (executor.ts's
 * "keep the reason's own description when it has one" branch). The second is a VERDICT, not an
 * outage — the offline-policy chokepoint arrives that way, carrying the "host blocked, here is
 * how to allow it" text — and `provider-retry.ts` already treats it as non-transient for the same
 * reason. Describing it as "can't reach the model server" would be the false description ruling 2
 * forbids, so its own words lead and nothing is retried by default.
 */
const DESCRIBED_REASON = /HTTP transport failed:\s*([A-Za-z][A-Za-z0-9]*Error)\s*(?:—|--|-)\s*(.+)$/s

function describedReason(message: string): string | undefined {
  const description = DESCRIBED_REASON.exec(message)?.[2]
  if (description === undefined) return undefined
  const trimmed = description.replace(/\(target\s+[^)\s]+\)\s*$/, "").trim()
  return trimmed.length > 0 && !isMachineDetail(trimmed) ? trimmed : undefined
}

/**
 * The one function. Never throws, never returns an empty headline, and never returns machine
 * detail in either `headline` or `detail`.
 */
export function sessionErrorDisplay(error: SessionErrorLike | undefined | null): SessionErrorDisplay {
  const raw = typeof error?.message === "string" ? error.message : ""
  const tag = typeof error?._tag === "string" && error._tag.length > 0 ? error._tag : undefined
  const retryable = typeof error?.retryable === "boolean" ? error.retryable : undefined

  // A stop is not a fault. The tag answers it structurally; the phrase match is the fallback for
  // rows written before the tag existed (the runner's own wording — see `runner/llm.ts`).
  if (tag === "Interrupted" || (tag === undefined && /interrupted/i.test(raw)))
    return {
      kind: "interrupted",
      key: ARMS.Interrupted.key,
      headline: ARMS.Interrupted.text,
      retryable,
      canRetry: false,
    }

  const arm = tag === undefined ? undefined : (ARMS as Record<string, { key: string; text: string }>)[tag]
  const prose = proseOf(raw)
  const canRetry = retryable ?? (tag !== undefined && RETRYABLE_BY_DEFAULT.has(tag))

  // Transport is the case this whole module exists for: name the endpoint, drop the errno.
  if (tag === "Transport") {
    // …unless the reason carried its own description, in which case it is a verdict, not an
    // outage, and its words are the only accurate headline available.
    const described = describedReason(raw)
    if (described !== undefined) return { kind: "fault", headline: described, retryable, canRetry: retryable ?? false }
    const endpoint = endpointOf(raw)
    if (endpoint !== undefined)
      return {
        kind: "fault",
        key: TRANSPORT_WITH_ENDPOINT.key,
        params: { endpoint },
        headline: TRANSPORT_WITH_ENDPOINT.text(endpoint),
        ...(prose === undefined ? {} : { detail: prose }),
        retryable,
        canRetry,
      }
    return {
      kind: "fault",
      key: ARMS.Transport.key,
      headline: ARMS.Transport.text,
      ...(prose === undefined ? {} : { detail: prose }),
      retryable,
      canRetry,
    }
  }

  // A recognised class: the translatable sentence leads, the provider's words follow.
  if (tag !== undefined && arm !== undefined && !PROSE_FIRST.has(tag))
    return {
      kind: "fault",
      key: arm.key,
      headline: arm.text,
      ...(prose === undefined ? {} : { detail: prose }),
      retryable,
      canRetry,
    }

  // Prose-first classes (a tool's own failure) and unrecognised/absent tags keep the message —
  // which is what every reader did before this module existed, so an old row is unchanged.
  if (prose !== undefined) return { kind: "fault", headline: prose, retryable, canRetry }

  // No usable words. If the raw text was transport-shaped, say so honestly rather than shrugging:
  // an untagged ECONNREFUSED is a transport fault in every producer that emits one.
  if (raw.length > 0 && isMachineDetail(raw)) {
    const endpoint = endpointOf(raw)
    if (endpoint !== undefined)
      return {
        kind: "fault",
        key: TRANSPORT_WITH_ENDPOINT.key,
        params: { endpoint },
        headline: TRANSPORT_WITH_ENDPOINT.text(endpoint),
        retryable,
        canRetry: retryable ?? true,
      }
    return {
      kind: "fault",
      key: ARMS.Transport.key,
      headline: ARMS.Transport.text,
      retryable,
      canRetry: retryable ?? true,
    }
  }

  if (arm !== undefined) return { kind: "fault", key: arm.key, headline: arm.text, retryable, canRetry }
  return { kind: "fault", key: GENERIC.key, headline: GENERIC.text, retryable, canRetry }
}

/** Convenience for call sites that need only the string to render. */
export function sessionErrorText(error: SessionErrorLike | undefined | null): string {
  return sessionErrorDisplay(error).headline
}
