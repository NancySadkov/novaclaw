export * as ProviderSession from "./provider-session"

import { InstallationVersion } from "../../installation/version"

/**
 * The header the OpenCode Go gateway requires on every inference request.
 *
 * Measured 2026-09-17 against the live gateway (`doc/oc-session.md` in the plan repo): the gateway
 * recognises a fixed allow-list of six session header names, the value is an opaque string of 1–256
 * bytes, and it must be stable within a conversation or the request dies at the gate with
 * `400 MissingSessionID` before a model is ever reached.
 *
 * ⚠️ We emit the documented name only. The other five are an accommodation so native agent headers
 * are not thrown away, not a published interface the vendor promises to keep.
 */
export const OPENCODE_SESSION_HEADER = "x-opencode-session"

/**
 * Identity for provider work that has NO conversation behind it — document ingestion, a community
 * reply, a session-less default resolution.
 *
 * ⚠️ One stable bucket, deliberately. A fresh UUID per request would satisfy the gate's letter while
 * destroying the affinity it exists to obtain (the plan doc's option C). Session-less work has no
 * conversation to stay affine to, so one honest, bounded identity is the right trade — the shape the
 * doc warns against is every CONVERSATION sharing one bucket, which this does not do.
 */
export const SESSIONLESS_ID = "novaclaw-sessionless"

/** Bytes, not characters: the gateway's own 400 names 256 bytes, and 257 failed deterministically. */
const MAX_SESSION_BYTES = 256

/**
 * The Go gateway, and only it.
 *
 * A session header on a LAN vLLM is harmless but pointless noise; the plan doc asks for the fix to
 * be scoped to Go's URL. A malformed URL is not a reason to fail a turn, so it reads as "not Go".
 */
const GO_HOST = "opencode.ai"
const GO_PATH_PREFIX = "/zen/go"

export const isOpenCodeGo = (url: string | undefined): boolean => {
  if (url === undefined) return false
  try {
    const parsed = new URL(url)
    return parsed.hostname.toLowerCase() === GO_HOST && parsed.pathname.startsWith(GO_PATH_PREFIX)
  } catch {
    return false
  }
}

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
 * The deployment headers one resolved route must carry, keyed to the conversation it serves.
 *
 * `undefined` for every endpoint that does not need them. It is applied to route DEFAULTS at the
 * single seam that knows both the session and the route (`SessionRunnerModel.resolve`), so every
 * derived request — compaction, short answers, titles, the reasoning phase — inherits it without a
 * second assignment per request-assembly site.
 */
export const headersFor = (input: {
  readonly url: string | undefined
  readonly sessionID: string | undefined
}): Record<string, string> | undefined =>
  isOpenCodeGo(input.url)
    ? {
        [OPENCODE_SESSION_HEADER]: affinityId(input.sessionID),
        // The vendor docs ask a client to name itself rather than send an SDK default. Not enforced
        // as of 2026-09-17, but the generic runtime default is exactly what they discourage and is
        // the kind of thing that starts failing quietly later.
        "user-agent": `novaclaw/${InstallationVersion}`,
      }
    : undefined
