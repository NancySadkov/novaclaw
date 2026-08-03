/**
 * THE chokepoint that turns a session fault into display text.
 *
 * Every surface that renders a `Session.Error.Unknown` — the transcript's turn-failure box, the
 * "Interrupted" divider, a tool card's subtitle, the headless CLI's failure line, the OS
 * notification — goes through `sessionErrorDisplay`. It is one function on purpose: a second
 * formatter is how the next divergence ships, and this file exists because there were three (the
 * transcript's `err().message`, its `/interrupted/i` sniff, and the tool card's
 * `state.error.message`) with no shared answer between them.
 *
 * ⚠️ **It lives in `packages/core` because ALL THREE consumers must be able to reach it, and two
 * of them could not while it lived in `packages/session-ui`.** `packages/app` could not import it
 * at all (session-ui's `exports` map sends `"./v2/*"` to `*.tsx` and this is a `.ts`), and the
 * headless CLI (`packages/novaclaw`) has no `@novaclaw/session-ui` dependency — adding one would
 * drag SolidJS, `@kobalte/core`, `shiki` and `dompurify` into a headless CLI, against AGENTS.md
 * design-principle 7. This module has **zero imports**, so `@novaclaw/core/session/session-error`
 * costs a renderer nothing beyond the file itself. There is deliberately **no re-export shim** at
 * the old path (design-principle 1: migrate cleanly).
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
 *    into the 18 locales this product ships. A class-level sentence can, so every recognised
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
  readonly status?: number | null
  /**
   * The wire discriminant. Nothing here reads it — every session error is `"unknown"` today — but the
   * real decoded value carries it, so leaving it off made this type reject the very shape it describes
   * the moment a caller passed an object LITERAL (excess-property checking does not fire through a
   * variable, which is why the tests caught it and production did not).
   */
  readonly type?: string | null
}

/**
 * Every i18n key this module can return, WITH its English text — as an i18n template
 * (`{{endpoint}}`), so the module's own fallback and `packages/app/src/i18n/en.ts` are literally
 * the same string rather than two strings a test has to compare across a regex.
 *
 * ⚠️ **This table is one half of a ratchet.** `packages/app/src/i18n/session-error-keys.test.ts`
 * pins it against `en.ts` in BOTH directions and `parity.test.ts` requires a real translation in
 * all 17 non-English bundles, so adding an entry here is not shippable until every bundle carries
 * it. That is ruling 1 working as designed — a half-translated fault surface is exactly what it
 * catches — not a regression to route around.
 */
export const SESSION_ERROR_TEXT = {
  "session.error.interrupted": "Interrupted",
  "session.error.invalidRequest": "The model rejected this request.",
  "session.error.noRoute": "No route is configured for this model.",
  "session.error.authentication": "The model provider rejected this model's credentials.",
  "session.error.rateLimit": "The model provider is rate-limiting this account — try again in a moment.",
  "session.error.quotaExceeded": "This account is out of quota with the model provider.",
  "session.error.contentPolicy": "The model provider refused this request under its content policy.",
  "session.error.providerInternal": "The model server hit an internal error.",
  "session.error.gatewayTimeout":
    "The gateway reached the model server, but stopped waiting before it replied (HTTP {{status}}).",
  "session.error.transport":
    "Can't reach the model server. It may be turned off, still starting, or on another network.",
  "session.error.transportEndpoint":
    "Can't reach the model server at {{endpoint}}. It may be turned off, still starting, or on another network.",
  "session.error.offlineBlocked": "Offline mode blocked this request, so it never left your computer.",
  "session.error.offlineBlockedEndpoint":
    "Offline mode blocked this request to {{endpoint}}, so it never left your computer.",
  "session.error.invalidProviderOutput": "The model's reply could not be read.",
  "session.error.unknownProvider": "The model provider returned an error.",
  "session.error.toolFailure": "A tool failed.",
  "session.error.unknown": "The turn failed before it finished.",
} as const

/** The closed key set, as a literal union — what a key-typed translator needs to accept. */
export type SessionErrorKey = keyof typeof SESSION_ERROR_TEXT

export type SessionErrorParams = { readonly endpoint?: string; readonly status?: string }

export type SessionErrorDisplay = {
  /** `interrupted` = the user stopped it; render a divider, not an alert. */
  readonly kind: "interrupted" | "fault"
  /**
   * The i18n key for `headline`, or `undefined` when `headline` is the provider's own words.
   *
   * ⚠️ A literal union, not `string`: a key-typed translator (`packages/app`'s `Translator`,
   * `packages/ui`'s `UiI18nKey`) cannot accept a `string`, and widening the translator instead
   * would delete the check that stops a raw `session.error.rateLimit` reaching a user.
   */
  readonly key?: SessionErrorKey
  /** Interpolation params for `key`. */
  readonly params?: SessionErrorParams
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
 * `{{name}}` → the value, the same syntax `@solid-primitives/i18n`'s `resolveTemplate` resolves.
 * A missing param renders empty, matching that resolver rather than leaving `{{endpoint}}` on
 * screen.
 */
function render(template: string, params?: SessionErrorParams): string {
  if (params === undefined) return template
  const values: Record<string, string> = {
    ...(params.endpoint === undefined ? {} : { endpoint: params.endpoint }),
    ...(params.status === undefined ? {} : { status: params.status }),
  }
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, name: string) => values[name.trim()] ?? "")
}

/** The English fallback for a key, rendered — what a surface with no translator shows. */
export function sessionErrorEnglish(key: SessionErrorKey, params?: SessionErrorParams): string {
  return render(SESSION_ERROR_TEXT[key], params)
}

/**
 * The display arms, keyed by `SessionMessage.ErrorTags`. Kept as a record rather than a `switch`
 * so a test can assert it covers the schema's vocabulary exactly — ruling 10's closed compiled
 * set, mechanically checked (ruling 1) instead of asserted in a comment.
 *
 * `ToolFailure` has no class sentence worth showing (a tool's own message is the useful text), so
 * its text is the last-resort wording used only when that message is unusable.
 */
const ARMS = {
  InvalidRequest: "session.error.invalidRequest",
  NoRoute: "session.error.noRoute",
  Authentication: "session.error.authentication",
  RateLimit: "session.error.rateLimit",
  QuotaExceeded: "session.error.quotaExceeded",
  ContentPolicy: "session.error.contentPolicy",
  ProviderInternal: "session.error.providerInternal",
  Transport: "session.error.transport",
  OfflineBlocked: "session.error.offlineBlocked",
  InvalidProviderOutput: "session.error.invalidProviderOutput",
  UnknownProvider: "session.error.unknownProvider",
  Interrupted: "session.error.interrupted",
  ToolFailure: "session.error.toolFailure",
} as const satisfies Record<string, SessionErrorKey>

/** Tags whose own message says more than the class sentence, so the message stays the headline. */
const PROSE_FIRST = new Set<string>(["ToolFailure"])

/** Endpoint-naming variants — used whenever a host:port can be recovered from the message. */
const WITH_ENDPOINT = {
  Transport: "session.error.transportEndpoint",
  OfflineBlocked: "session.error.offlineBlockedEndpoint",
} as const satisfies Record<string, SessionErrorKey>

/** Last-resort headline when the fault carried nothing a person can use and no known class. */
const GENERIC = "session.error.unknown"

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
 * ⚠️ **This is a BACK-COMPAT reader, not the current producer contract.** The offline/airgap block
 * — the case it was written for — now arrives as its own `OfflineBlocked` tag
 * (`packages/llm/src/schema/errors.ts`), so nothing NEW needs prose-sniffing to be described
 * honestly. Two things still reach it and are why it stays:
 *
 *   1. **Every session record already on disk.** A row written before the typed arm existed
 *      carries `_tag: "Transport"` with the verdict flattened into its message. Deleting this
 *      would re-describe those rows as "can't reach the model server" — the false description
 *      ruling 2 forbids, applied retroactively to a user's own history.
 *   2. **The residual `HttpClientError` reasons** the executor still flattens into `Transport`
 *      (`EncodeError`, `DecodeError`, `EmptyBodyError`, and the platform's own malformed-URL
 *      `InvalidUrlError`), formatted `HTTP transport failed: <ReasonTag> — <description>`. For
 *      those the description is the only accurate text available, because the wire carries no
 *      `kind` a reader could switch on. Giving each its own typed arm is the real fix and is a
 *      separate, larger change (four reasons × a session tag × an i18n key × 18 bundles).
 *
 * Either way it is a VERDICT or an encoding fault, not an outage, so its own words lead and
 * nothing is retried by default — the same conclusion `provider-retry.ts` reaches.
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
  const status = typeof error?.status === "number" && Number.isFinite(error.status) ? error.status : undefined

  // A stop is not a fault. The tag answers it structurally; the phrase match is the fallback for
  // rows written before the tag existed (the runner's own wording — see `runner/llm.ts`).
  if (tag === "Interrupted" || (tag === undefined && /interrupted/i.test(raw)))
    return {
      kind: "interrupted",
      key: ARMS.Interrupted,
      headline: sessionErrorEnglish(ARMS.Interrupted),
      retryable,
      canRetry: false,
    }

  const arm = tag === undefined ? undefined : (ARMS as Record<string, SessionErrorKey>)[tag]
  const prose = proseOf(raw)
  const canRetry = retryable ?? (tag !== undefined && RETRYABLE_BY_DEFAULT.has(tag))

  // Cloudflare 524 is not an opaque provider crash: the gateway reached the origin model server,
  // then gave up before the origin produced its HTTP reply. Keep that exact, actionable distinction.
  if (tag === "ProviderInternal" && status === 524) {
    const params = { status: String(status) }
    return {
      kind: "fault",
      key: "session.error.gatewayTimeout",
      params,
      headline: sessionErrorEnglish("session.error.gatewayTimeout", params),
      ...(prose === undefined ? {} : { detail: prose }),
      retryable,
      canRetry,
    }
  }

  // An offline/airgap block is a DECISION this instance made, not an outage. It is filed apart
  // from Transport so `canRetry` is false by construction rather than by prose-sniffing, and so
  // the sentence a user reads says what actually happened (ruling 2).
  if (tag === "OfflineBlocked") {
    const endpoint = endpointOf(raw)
    if (endpoint !== undefined)
      return {
        kind: "fault",
        key: WITH_ENDPOINT.OfflineBlocked,
        params: { endpoint },
        headline: sessionErrorEnglish(WITH_ENDPOINT.OfflineBlocked, { endpoint }),
        ...(prose === undefined ? {} : { detail: prose }),
        retryable,
        canRetry: retryable ?? false,
      }
    return {
      kind: "fault",
      key: ARMS.OfflineBlocked,
      headline: sessionErrorEnglish(ARMS.OfflineBlocked),
      ...(prose === undefined ? {} : { detail: prose }),
      retryable,
      canRetry: retryable ?? false,
    }
  }

  // Transport is the case this whole module exists for: name the endpoint, drop the errno.
  if (tag === "Transport") {
    // …unless the reason carried its own description, in which case it is a verdict (or an
    // encoding fault), not an outage, and its words are the only accurate headline available.
    // See `DESCRIBED_REASON` — this is the back-compat reader for pre-`OfflineBlocked` rows.
    const described = describedReason(raw)
    if (described !== undefined) return { kind: "fault", headline: described, retryable, canRetry: retryable ?? false }
    const endpoint = endpointOf(raw)
    if (endpoint !== undefined)
      return {
        kind: "fault",
        key: WITH_ENDPOINT.Transport,
        params: { endpoint },
        headline: sessionErrorEnglish(WITH_ENDPOINT.Transport, { endpoint }),
        ...(prose === undefined ? {} : { detail: prose }),
        retryable,
        canRetry,
      }
    return {
      kind: "fault",
      key: ARMS.Transport,
      headline: sessionErrorEnglish(ARMS.Transport),
      ...(prose === undefined ? {} : { detail: prose }),
      retryable,
      canRetry,
    }
  }

  // A recognised class: the translatable sentence leads, the provider's words follow.
  if (tag !== undefined && arm !== undefined && !PROSE_FIRST.has(tag))
    return {
      kind: "fault",
      key: arm,
      headline: sessionErrorEnglish(arm),
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
        key: WITH_ENDPOINT.Transport,
        params: { endpoint },
        headline: sessionErrorEnglish(WITH_ENDPOINT.Transport, { endpoint }),
        retryable,
        canRetry: retryable ?? true,
      }
    return {
      kind: "fault",
      key: ARMS.Transport,
      headline: sessionErrorEnglish(ARMS.Transport),
      retryable,
      canRetry: retryable ?? true,
    }
  }

  if (arm !== undefined) return { kind: "fault", key: arm, headline: sessionErrorEnglish(arm), retryable, canRetry }
  return { kind: "fault", key: GENERIC, headline: sessionErrorEnglish(GENERIC), retryable, canRetry }
}

// ⚠️ `sessionErrorText(error) => display.headline` used to live here and is DELETED (2026-07-30).
// Its one production caller was `native-transcript.tsx`, and that call site was the bug this round
// fixed: it rendered the ENGLISH fallback on a surface that has a translator. Keeping a convenience
// whose only remaining users are tests is the cruft the standing ruling names, and worse, it is a
// convenience shaped exactly like the mistake — the next renderer would reach for it. A surface with
// a translator calls `sessionErrorHeadline`; one without calls `sessionErrorLines`.

/**
 * The full DIAGNOSTIC rendering, as lines — for a surface that has no translator and whose reader
 * is debugging: the headless `novaclaw run`.
 *
 * ⚠️ **This is the one place in the tree that deliberately lets machine detail through, and the
 * reasoning has to be explicit or the next reader will "fix" it.** The chat suppresses the errno
 * because a lay user cannot act on `connect ECONNREFUSED 192.168.178.40:8000` and should never read
 * it inside their own conversation. `novaclaw run` is the opposite surface: AGENTS.md documents it
 * as the way to exercise a model through the real pipeline, so its entire audience is diagnosing
 * something, the text is already on the wire and in the session record, and `--format json` emits
 * the raw error object anyway — hiding it from the human arm would only make one command's two
 * arms disagree. Ruling 2 is satisfied by line 1: the fault is described truthfully, in the same
 * words the app uses, and the raw text is additional rather than contradictory.
 *
 * Line 1 is always the headline. Line 2 is the provider's own words when they add something. The
 * raw line appears ONLY when the message carries machine detail — precisely what was stripped —
 * so an interruption or a tool's own prose stays one clean line.
 */
export function sessionErrorLines(error: SessionErrorLike | undefined | null): ReadonlyArray<string> {
  const display = sessionErrorDisplay(error)
  const raw = typeof error?.message === "string" ? error.message.trim() : ""
  const lines = [display.headline]
  if (display.detail !== undefined) lines.push(display.detail)
  if (raw.length > 0 && raw !== display.headline && isMachineDetail(raw)) lines.push(raw)
  return lines
}

/**
 * Copyable technical detail for the transcript's explicitly folded disclosure. Unlike the calm
 * headline this deliberately preserves the provider's diagnostic text; it is never shown until a
 * person expands or copies it, and the request executor has already redacted credentials.
 */
export function sessionErrorDiagnostic(error: SessionErrorLike | undefined | null): string {
  const raw = typeof error?.message === "string" ? error.message.trim() : ""
  return [
    `Type: ${typeof error?._tag === "string" ? error._tag : "Unknown"}`,
    ...(typeof error?.status === "number" ? [`HTTP status: ${error.status}`] : []),
    `Retryable: ${typeof error?.retryable === "boolean" ? (error.retryable ? "yes" : "no") : "not specified"}`,
    `Details: ${raw || "No additional provider details were supplied."}`,
  ].join("\n")
}

/**
 * The headline, TRANSLATED — the one function every surface with a translator calls.
 *
 * ⚠️ **`display.headline` is the English fallback, not the answer.** It exists for surfaces that
 * have no translator at all (the headless CLI). A surface that *does* have one and renders
 * `headline` anyway ships an English-only fault box, which is what `native-transcript.tsx` did
 * until 2026-07-30 — on the surface a lay user is most likely to reach first.
 *
 * `translate` is deliberately typed to accept a plain `Record<string, string>` and to return
 * `string | undefined`, which makes both real translators assignable AS THEY ARE — no adapter, no
 * cast: `packages/ui`'s `useI18n().t` and `packages/app`'s `Translator` both take a wider key set
 * and a wider param bag (parameters are contravariant) and both really can answer `undefined` for
 * a key their dictionary lacks, whatever their declaration says.
 */
export function sessionErrorHeadline(
  display: SessionErrorDisplay,
  translate: (key: SessionErrorKey, params: Record<string, string>) => string | undefined,
): string {
  // No key = the headline is the provider's own words. Nothing could translate those.
  if (display.key === undefined) return display.headline
  return (
    translate(display.key, {
      ...(display.params?.endpoint === undefined ? {} : { endpoint: display.params.endpoint }),
      ...(display.params?.status === undefined ? {} : { status: display.params.status }),
    }) ?? display.headline
  )
}

/**
 * Normalize an UNTYPED session-fault payload into the shape `sessionErrorDisplay` reads.
 *
 * The record-level `session.error` event (`schema/session-record-event.ts`) declares its payload
 * `Schema.Unknown`, and its one producer (`novaclaw/src/skill/index.ts`) publishes a `NamedError`
 * object — `{ name: "UnknownError", data: { message } }`. A reader that only understood a bare
 * string therefore fell through to a generic "An error occurred" for the ONLY shape that is ever
 * sent, which is ruling 2's *an unavailable subsystem names itself instead of rendering empty*.
 *
 * ⚠️ `name` is deliberately NOT read as `_tag`: `NamedError`'s names (`UnknownError`,
 * `FrontmatterError`, …) are a different vocabulary from `SessionMessage.ErrorTags`, and feeding
 * one into the other would invent an arm. Only the message is recovered.
 *
 * Returns `undefined` when the payload carries no readable message, so a caller can choose its
 * own wording rather than being handed a fabricated one.
 */
export function sessionErrorLike(value: unknown): SessionErrorLike | undefined {
  if (typeof value === "string") return value.trim().length > 0 ? { message: value } : undefined
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const direct = typeof record["message"] === "string" ? (record["message"] as string) : undefined
  const nested = record["data"]
  const fromData =
    typeof nested === "object" && nested !== null && typeof (nested as Record<string, unknown>)["message"] === "string"
      ? ((nested as Record<string, unknown>)["message"] as string)
      : undefined
  const message = direct ?? fromData
  if (message === undefined || message.trim().length === 0) return undefined
  return {
    message,
    ...(typeof record["_tag"] === "string" ? { _tag: record["_tag"] as string } : {}),
    ...(typeof record["retryable"] === "boolean" ? { retryable: record["retryable"] as boolean } : {}),
    ...(typeof record["status"] === "number" ? { status: record["status"] as number } : {}),
  }
}
