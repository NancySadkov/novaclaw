export * as ProviderSession from "./provider-session"

import { InstallationVersion } from "../../installation/version"
import { endpointKey } from "./endpoint"

/**
 * Session affinity for endpoints that gate inference on a per-conversation identity.
 *
 * 🔴 **Nothing here is compiled to a vendor.** Some hosted gateways route inference by a session
 * identity and refuse every request that carries none; which header they accept, and for which
 * endpoint, is a fact about THAT endpoint rather than about NovaClaw. So it is LEARNED from the
 * endpoint's own 400 and remembered per endpoint (`provider_session_affinity`), exactly like the
 * repetition floor beside it. A hostname or header literal in this file would name a third party in
 * the product, which AGENTS.md forbids: attribution lives only in `LICENSE`, `NOTICE` and
 * `licenses/`.
 *
 * Measured 2026-09-17 against one such gateway (the plan repo's `doc/oc-session.md`): the 400 names
 * the header it wants, the value is an opaque string of 1–256 bytes, and it must be stable within a
 * conversation. That is the whole contract this seam implements.
 */

/**
 * The header sent when the endpoint's refusal did not name one.
 *
 * ⚠️ A documented-accepted generic session header, not a vendor name. The endpoint's own message is
 * preferred when it names a specific header (`requiredHeaderFrom`), so a gateway that publishes one
 * gets exactly it; this is the fallback for a gateway that refuses without saying which name works.
 */
export const FALLBACK_AFFINITY_HEADER = "x-session-id"

/**
 * Identity for provider work that has NO conversation behind it — document ingestion, a community
 * reply, a session-less default resolution.
 *
 * ⚠️ One stable bucket, deliberately. A fresh UUID per request would satisfy a gate's letter while
 * destroying the affinity it exists to obtain. Session-less work has no conversation to stay affine
 * to, so one honest, bounded identity is the right trade — the shape to avoid is every CONVERSATION
 * sharing one bucket, which this does not do.
 */
export const SESSIONLESS_ID = "novaclaw-sessionless"

/** Bytes, not characters: the measured ceiling is 256 bytes, and 257 failed deterministically. */
const MAX_SESSION_BYTES = 256

/**
 * The sentence an affinity-gated endpoint returns when the request carried no session identity.
 * Brand-free by construction: it matches the shape, never a vendor's header name.
 */
const MISSING_SESSION = /MissingSessionID|missing\s+[A-Za-z0-9_-]*session[A-Za-z0-9_-]*\s+and\s+cannot\s+be\s+routed/i

/** The header the endpoint's own refusal named, when it named one. */
const NAMED_HEADER = /missing\s+([A-Za-z0-9_-]+)\s+and\s+cannot\s+be\s+routed/i

/**
 * Does this 4xx body say the endpoint requires a session identity the request did not carry?
 *
 * Matches the documented machine token (`MissingSessionID`) and the human sentence shape, so a
 * gateway that keeps one and rewords the other is still recognised. It never matches a vendor name.
 */
export const rejectsMissingSession = (message: string): boolean => MISSING_SESSION.test(message)

/** The session header the endpoint's own 400 named, or `undefined` when it named none. */
export const requiredHeaderFrom = (message: string): string | undefined => message.match(NAMED_HEADER)?.[1]

/** Trimmed, non-empty and ≤256 bytes; anything else falls back to the session-less identity. */
const affinityId = (sessionID: string | undefined): string => {
  const trimmed = sessionID?.trim()
  if (trimmed === undefined || trimmed === "") return SESSIONLESS_ID
  // A real session id is ASCII and short, so the truncation is a guard against a foreign caller
  // rather than a path the harness takes. Slicing bytes can split a multi-byte character, which is
  // acceptable for an OPAQUE routing id the gateway never parses.
  const bytes = new TextEncoder().encode(trimmed)
  if (bytes.byteLength <= MAX_SESSION_BYTES) return trimmed
  return new TextDecoder().decode(bytes.slice(0, MAX_SESSION_BYTES))
}

/**
 * Endpoints THIS process has already learned require a session header, and which header each wants.
 *
 * A module-level map, like the repetition floor's set: it covers the recovery retry inside one turn
 * (`resolve` re-runs in the same worker), while the persisted `provider_session_affinity` row is what
 * makes the NEXT process start warm.
 */
const affinityHeaders = new Map<string, string>()

/** Remember an endpoint's required header for this process. */
export const rememberAffinity = (url: string | undefined, header: string): void => {
  const key = endpointKey(url)
  if (key !== undefined) affinityHeaders.set(key, header)
}

/** True when this process has already learned this endpoint's requirement. */
export const isAffinityKnown = (url: string | undefined): boolean => {
  const key = endpointKey(url)
  return key !== undefined && affinityHeaders.has(key)
}

/**
 * The header to send: this process's own memory wins over what a previous process learned, and
 * `undefined` means no header is sent — the pass-everything answer for every other endpoint.
 */
export const affinityHeaderFor = (url: string | undefined, persisted: string | undefined): string | undefined => {
  const key = endpointKey(url)
  if (key === undefined) return persisted
  return affinityHeaders.get(key) ?? persisted
}

/** Test seam: module state must not leak between cases. */
export const clearAffinity = (): void => affinityHeaders.clear()

/**
 * The deployment headers one resolved route must carry, keyed to the conversation it serves.
 *
 * `undefined` for every endpoint that does not require them. It is applied to route DEFAULTS at the
 * single seam that knows both the session and the route (`SessionRunnerModel.resolve`), so every
 * derived request — compaction, short answers, titles, the reasoning phase — inherits it without a
 * second assignment per request-assembly site.
 */
export const headersFor = (input: {
  readonly header: string | undefined
  readonly sessionID: string | undefined
}): Record<string, string> | undefined =>
  input.header === undefined
    ? undefined
    : {
        [input.header]: affinityId(input.sessionID),
        // Some gateways ask a client to name itself rather than send an SDK default. Not enforced
        // as of 2026-09-17, but the generic runtime default is exactly what they discourage and is
        // the kind of thing that starts failing quietly later.
        "user-agent": `novaclaw/${InstallationVersion}`,
      }
