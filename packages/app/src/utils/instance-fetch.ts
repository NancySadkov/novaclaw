import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

/**
 * **THE one place this app talks to an instance over raw HTTP.**
 *
 * Nine sibling modules in this folder each carried their own copy of the same four decisions — the
 * base-URL join, the `Authorization` header, how a non-2xx becomes an `Error`, and how `directory`
 * travels — across 11 `fetch(` calls. The base-URL join and the auth block were byte-identical in
 * all nine; the error decoding had **five** different answers, which is the part that mattered.
 *
 * ⚠️ **The reason this collapse is scheduled BEFORE P2P token rotation is the `Authorization` line
 * below.** Rotating the instance token means changing how that header is derived. With nine copies
 * that is nine edits, eight of which review as "consistent with the neighbours" and one of which
 * gets missed — and a missed one does not fail loudly, it 401s a single app screen. There is now
 * exactly one derivation, in `instanceHeaders`, and `instance-fetch.test.ts` fails if a second
 * appears. (`utils/server.ts` holds the SDK's copy of the same decision and `terminal-websocket-url.ts`
 * the WebSocket ticket's; both are pinned in that test's ledger, so the true rotation surface is a
 * written-down set rather than a grep.)
 *
 * ⚠️ **What this module deliberately does NOT do.**
 * - It does not format text for a human. The session-fault vocabulary lives in
 *   `@novaclaw/core/session/session-error` (`sessionErrorDisplay`) and there must not be a second
 *   one. This module produces a structured `InstanceFetchError`; deciding what a *user* reads is
 *   the calling screen's job, as it was before.
 * - It does not wrap network failures. A DNS/refused/aborted `fetch` rejects with the runtime's own
 *   `TypeError`/`DOMException` and that value travels to the caller **unchanged**. Wrapping it would
 *   erase `instanceof TypeError` and `name === "AbortError"`, which is how the rest of the app tells
 *   "the server said no" apart from "there was no server" (`utils/server-health.ts` → `retryable`).
 *   Ruling 2 cuts both ways: a fault must not be described falsely, and "described falsely" includes
 *   flattening a transport outage into an HTTP error object.
 * - It does not reach for the SDK. Every route these clients call **is** in the generated SDK today
 *   (measured 2026-07-31 against `packages/sdk/openapi.json` + `sdk.gen.ts`: all of them, not the
 *   "≥4" the roadmap estimated), so the "NOT in the generated SDK" comment each of the nine carried
 *   is stale. Migrating onto the SDK is a separate, larger decision — it changes the error shape at
 *   every call site — and doing it silently inside a mechanical collapse is how that decision would
 *   get made by accident.
 */

/**
 * How the routed `directory` reaches the server. Both spellings are real and neither is wrong:
 *
 * - `"query"` — `?directory=…`, the legacy instance surface (`/file/*`, `/memory/*`, `/registry/*`,
 *   `/shell/*`, `/provider/*`, `/adhoc/*`, `/scheduler/*`).
 * - `"header"` — `x-novaclaw-directory`, the `/api/session/*` surface, whose location routing reads
 *   the header (the generated client rewrites the header into a query param for GETs; these are all
 *   POSTs, where it does not).
 *
 * Naming the two beats hiding them: a caller that picks the wrong one gets a 400 from a server that
 * cannot see its `directory`, which is a confusing failure to debug from a call site.
 */
export type DirectoryChannel = "query" | "header"

/** Everything decodable from a non-2xx answer, in ONE shape. */
export interface InstanceFault {
  readonly method: string
  readonly route: string
  readonly status: number
  /**
   * The server's own words when the body carried them (`message`, or `data.message` for the
   * NamedError shape the SDK's `wrapClientError` also reads) — otherwise a status line that still
   * names the method, the route and the raw body. Never a bare status code: that was the least
   * informative of the five decoders this module replaced, and adopting it everywhere would have
   * been a collapse that *lost* information.
   */
  readonly message: string
  /** The server's machine-readable discriminator, when it sent one (e.g. `messenger_login_retry`). */
  readonly kind: string | undefined
  /** The response body verbatim, uncapped — only the fallback *message* is length-capped. */
  readonly text: string
}

/**
 * A non-2xx answer from an instance. Carries the status and the server's `kind` structurally, so a
 * caller can branch on the fault rather than on the prose — `error.status === 404` and
 * `error.kind === "messenger_chat_bound"` both survive translation and both survive a server
 * rewording its message.
 */
export class InstanceFetchError extends Error {
  readonly method: string
  readonly route: string
  readonly status: number
  readonly kind: string | undefined
  readonly text: string

  constructor(fault: InstanceFault) {
    super(fault.message)
    this.name = "InstanceFetchError"
    this.method = fault.method
    this.route = fault.route
    this.status = fault.status
    this.kind = fault.kind
    this.text = fault.text
  }
}

export interface InstanceRequest {
  /** Defaults to `GET`, the only method used by more than half the call sites. */
  readonly method?: string
  /** RELATIVE to the instance root — `"api/recipe"`, not `"/api/recipe"`. */
  readonly route: string
  /** JSON-encoded when present. `undefined` sends no body at all (not `"undefined"`). */
  readonly body?: unknown
  readonly directory?: string
  /** Defaults to `"query"` — the spelling 4 of the 5 directory-carrying clients use. */
  readonly directoryVia?: DirectoryChannel
  /** `undefined` values are skipped, so callers stop writing `...(x ? { k: v } : {})`. */
  readonly query?: Record<string, string | undefined>
  readonly headers?: Record<string, string>
  /** Abort this request when the owning view disappears. Transport failures stay unwrapped. */
  readonly signal?: AbortSignal
  /** Optional wall-clock bound covering the response body as well as the initial fetch. */
  readonly timeoutMs?: number
  /**
   * Test seam, and the hook a future platform-fetch fix would use. ⚠️ All ten of this app's raw
   * clients call the GLOBAL fetch, while `server-health.ts` routes through `platform.fetch`
   * (Electron/WSL). That divergence predates this module and is preserved here rather than
   * silently changed — see the note in `instance-fetch.test.ts`.
   */
  readonly fetch?: typeof globalThis.fetch
  /**
   * Name the fault with a domain-specific subclass. The DECODING stays here (one answer); only the
   * class is the caller's, so `messenger-api.ts` can keep throwing a `MessengerApiError` that three
   * existing call sites test with `instanceof`.
   */
  readonly fault?: (fault: InstanceFault) => Error
}

/**
 * A raw body is capped only where it is being pasted into a fallback message. A server-authored
 * `message` is never truncated — that one is meant to be read.
 */
const FAULT_TEXT_LIMIT = 500

/**
 * The bare CALL SIGNATURE of `fetch`, not `typeof globalThis.fetch` itself. Runtimes decorate their
 * `fetch` with static properties (bun and recent Node both do), and a plain arrow function is not
 * assignable to a type that carries them — while the decorated `fetch` IS assignable to this. Using
 * the signature makes the default and the injected override interchangeable in both directions.
 */
type Send = (...args: Parameters<typeof globalThis.fetch>) => ReturnType<typeof globalThis.fetch>

function requestAbort(request: InstanceRequest) {
  if (request.timeoutMs === undefined) return { signal: request.signal, clear: () => undefined }

  const controller = new AbortController()
  const relay = () => controller.abort(request.signal?.reason)
  if (request.signal?.aborted) relay()
  if (!request.signal?.aborted) request.signal?.addEventListener("abort", relay, { once: true })
  const timer = setTimeout(
    () => controller.abort(new DOMException("Instance request timed out", "TimeoutError")),
    request.timeoutMs,
  )
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer)
      request.signal?.removeEventListener("abort", relay)
    },
  }
}

const trailingSlash = (url: string) => (url.endsWith("/") ? url : `${url}/`)

/** The base-URL join, formerly copied into all nine clients character for character. */
export function instanceUrl(
  server: ServerConnection.HttpBase,
  route: string,
  query?: Record<string, string | undefined>,
): URL {
  const url = new URL(route, trailingSlash(server.url))
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return url
}

/**
 * ⚠️ **THE auth seam.** The only place in this app that turns a stored credential into a request
 * header for a raw fetch. Rotate the P2P token here.
 *
 * `content-type: application/json` is sent unconditionally, including on bodyless GETs. Eight of
 * the nine collapsed clients already did; `instance-discovery.ts` did not, and it now does. Measured
 * safe: the instance's CORS middleware (`httpapi/server.ts`) declares no `allowedHeaders`
 * restriction, so it reflects whatever the preflight asks for — and the eight are live proof.
 */
export function instanceHeaders(
  server: ServerConnection.HttpBase,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(server.password
      ? { Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}` }
      : {}),
    ...extra,
  }
}

function statusLine(method: string, route: string, status: number, text: string) {
  if (!text) return `${method} ${route} failed: ${status}`
  const body = text.length > FAULT_TEXT_LIMIT ? `${text.slice(0, FAULT_TEXT_LIMIT)}…` : text
  return `${method} ${route} failed: ${status} ${body}`
}

/**
 * The ONE non-2xx decoder. Exported so the test can drive it without a socket.
 *
 * The precedence — server `message`, then `data.message`, then the status line — is the union of
 * what the five previous decoders did, not a new invention: `recipe-api` and
 * `fs-api.exportSessionMarkdown` preferred `message`, `messenger-api` additionally kept `kind`,
 * and the other three fell back to status + raw text. Applying the most informative of them
 * everywhere is the only collapse that loses nothing.
 */
export function decodeFault(input: { method: string; route: string; status: number; text: string }): InstanceFault {
  let message: string | undefined
  let kind: string | undefined
  if (input.text) {
    try {
      const parsed: unknown = JSON.parse(input.text)
      if (parsed !== null && typeof parsed === "object") {
        const body = parsed as { message?: unknown; kind?: unknown; data?: unknown }
        if (typeof body.message === "string" && body.message.trim()) message = body.message
        else if (body.data !== null && typeof body.data === "object") {
          const nested = (body.data as { message?: unknown }).message
          if (typeof nested === "string" && nested.trim()) message = nested
        }
        if (typeof body.kind === "string" && body.kind) kind = body.kind
      }
    } catch {
      // Not JSON — an HTML error page from a proxy, or plain text. The raw body is all there is,
      // and the status line below still carries it.
    }
  }
  return {
    method: input.method,
    route: input.route,
    status: input.status,
    kind,
    message: message ?? statusLine(input.method, input.route, input.status, input.text),
    text: input.text,
  }
}

/**
 * One instance call: base URL, auth, JSON body, JSON answer, decoded fault.
 *
 * ⚠️ `globalThis.fetch` is invoked through a wrapper rather than hoisted into a local. A detached
 * `const send = globalThis.fetch` throws `Illegal invocation` in Chromium (the packaged desktop
 * app's renderer) because `fetch` needs its global `this`; it happens to work under Bun and Node,
 * so a test suite would never see it.
 */
export async function instanceFetch<T>(server: ServerConnection.HttpBase, request: InstanceRequest): Promise<T> {
  const method = request.method ?? "GET"
  const via = request.directoryVia ?? "query"
  const routed = request.directory !== undefined
  const send: Send = request.fetch ?? ((...args) => globalThis.fetch(...args))
  const abort = requestAbort(request)

  const url = instanceUrl(server, request.route, {
    ...(routed && via === "query" ? { directory: request.directory } : {}),
    ...request.query,
  })
  const headers = instanceHeaders(server, {
    ...(routed && via === "header" ? { "x-novaclaw-directory": request.directory as string } : {}),
    ...request.headers,
  })

  try {
    // No catch: transport/abort failures retain the runtime's own identity and classification.
    const res = await send(url, {
      method,
      headers,
      ...(abort.signal === undefined ? {} : { signal: abort.signal }),
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    })

    if (!res.ok) {
      const fault = decodeFault({
        method,
        route: request.route,
        status: res.status,
        text: await res.text().catch(() => ""),
      })
      throw request.fault ? request.fault(fault) : new InstanceFetchError(fault)
    }

    // 204/205 are DECLARED no-content by every void-returning route in the spec, so an absent body
    // there is the answer, not a fault.
    if (res.status === 204 || res.status === 205) return undefined as T
    const text = await res.text()
    if (!text) {
      // A 2xx that promised a body and sent none. Previously this surfaced as
      // `SyntaxError: Unexpected end of JSON input`, which names the parser rather than the fault —
      // and for a list-returning route it is the shape that later throws inside a render.
      throw new InstanceFetchError({
        method,
        route: request.route,
        status: res.status,
        kind: undefined,
        message: `${method} ${request.route} answered ${res.status} with an empty body`,
        text: "",
      })
    }
    try {
      return JSON.parse(text) as T
    } catch {
      throw new InstanceFetchError({
        method,
        route: request.route,
        status: res.status,
        kind: undefined,
        message: statusLine(method, request.route, res.status, text).replace(" failed: ", " answered non-JSON: "),
        text,
      })
    }
  } finally {
    abort.clear()
  }
}

/**
 * A list route that cannot take the whole app down when the answer is not a list.
 *
 * ⚠️ Consumers read a resource's `.latest` and immediately `.filter`/`.find` it. `createResource`'s
 * `initialValue: []` only covers the PENDING state — once a fetch RESOLVES with a non-array, that
 * value becomes `.latest` and the next `.filter` throws inside a render, which the app error
 * boundary turns into "Something went wrong" for the entire UI. A panel we could not parse must not
 * cost the user their session (AGENTS.md → *it never breaks in your hands*).
 *
 * ⚠️ And this is not merely a malformed-reply guard: instances are PEERS and may run different
 * versions (AGENTS.md → *P2P instances*), so "an endpoint answered a shape this build did not
 * expect" is a permanent, normal condition of the product rather than a bug to be fixed upstream
 * once.
 *
 * It coerces rather than throws, but it does NOT pretend the list was empty: the fault is named on
 * the console, which `utils/error-log.ts` taps into the Debug app. Rendering empty *silently* would
 * be ruling 2's "an unavailable subsystem names itself instead of rendering empty".
 *
 * Lifted out of `messenger-api.ts`, where it was found by an e2e spec whose mock returns `{}` —
 * exactly the shape a peer on an older protocol would send. The identical defect and fix exist in
 * `apps/persisted.ts`, which is why this belongs to the seam and not to one client.
 */
export async function instanceFetchList<T>(
  server: ServerConnection.HttpBase,
  request: InstanceRequest,
  what: string,
): Promise<T[]> {
  const value = await instanceFetch<unknown>(server, request)
  if (Array.isArray(value)) return value as T[]
  console.warn(
    `${request.route} answered ${value === null ? "null" : typeof value}, not a list of ${what} — ` +
      `showing none. The instance may be running a different version.`,
  )
  return []
}
