// The provider probe must not escape the airgap — and must say so honestly when it doesn't.
//
// THE BUG THIS PINS (found 2026-07-31): `handlers/provider.ts`'s probe used a raw global `fetch`,
// so with offline/airgap mode ON, typing a WAN endpoint into Settings → Models → Custom endpoint and
// clicking *Find models* EGRESSED — while `/shell/offline` reported 9/9 layers active and
// `core/src/offline.ts`'s layer-1 manifest named "probe" among the callers riding the shared
// chokepoint. The payload can carry an API key (the handler falls back to the saved provider's
// `request.body.apiKey`), so what left the machine was a credential, not just a URL. That is
// design-principle 4 (the data plane never egresses, OFF-C) broken while the status surface said
// otherwise — the same shape as the A3 defect ruling 2 was written from.
//
// ⚠️ THE INSTRUMENT IS THE POINT. "Nothing egressed" cannot be observed from the probe's RESULT: a
// blocked probe and a probe of a dead host both come back as a failure. So the stub transport
// RECORDS every request that reaches it, and the assertion is on that record — zero requests, zero
// Authorization headers. The negative control (same URL, policy off) drives the same stub to one
// recorded request, so the zero is the guard working and not a stub that was never wired up.
//
// ⚠️ NO REAL NETWORK. Every client here is `HttpClient.make(...)` over a canned `Response`; the only
// URLs that appear are strings. Nothing opens a socket, loopback included.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http"
import { Offline } from "@novaclaw/core/offline"
import { ConfigLocalRuntime } from "@novaclaw/core/config/local-runtime"
import { AIRGAP_BLOCK_PREFIX, probeEndpoint } from "../../src/server/routes/instance/httpapi/handlers/provider"

/** The credential the probe would send. Its absence from the record is the security assertion. */
const SECRET = "Bearer sk-live-do-not-egress"
const HEADERS = { authorization: SECRET }

const WAN = "https://api.openai.com/v1/models"
const LOOPBACK = "http://localhost:11434/v1/models"

/** An `Offline.Interface` over a literal policy, using the REAL `checkUrl` so the wording under test
 *  is the product's own. Mirrors `core/test/offline-egress-blocked.test.ts`. */
const offlineWith = (policy: Offline.Policy): Offline.Interface => ({
  policy,
  check: (url: string) => Offline.checkUrl(url, policy),
  egressEnv: () => Offline.egressEnv(policy),
  manifest: () => Offline.layerManifest(policy),
})

/** Airgap ON with NOTHING allowlisted — the strictest posture a user can select. */
const AIRGAP = offlineWith({ enabled: true, allowedHosts: new Set<string>() })
/** Airgap OFF — the default install. */
const OPEN = offlineWith(Offline.disabledPolicy)

interface Seen {
  readonly url: string
  readonly authorization: string | undefined
}

/** A transport that answers like a healthy OpenAI-compatible `/models` and records what reached it. */
const recording = (answer?: (url: string) => Response) => {
  const seen: Seen[] = []
  const client = HttpClient.make((request) => {
    seen.push({ url: request.url, authorization: request.headers["authorization"] })
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        answer?.(request.url) ??
          new Response(JSON.stringify({ data: [{ id: "qwen3.6-35b", max_model_len: 262144 }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    )
  })
  return { seen, client }
}

/** A transport that fails the way a refused connection does — the OUTAGE half of ruling 2. */
const refusing = () => {
  const seen: Seen[] = []
  const client = HttpClient.make((request) => {
    seen.push({ url: request.url, authorization: request.headers["authorization"] })
    return Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description: "ConnectionRefused" }),
      }),
    )
  })
  return { seen, client }
}

const probe = async (offline: Offline.Interface, url: string, transport = recording()) => {
  const result = await Effect.runPromise(probeEndpoint(Offline.guard(transport.client, offline), url, HEADERS))
  return { result, seen: transport.seen }
}

describe("the provider probe rides the guarded HttpClient", () => {
  test("airgap ON: a non-loopback probe never reaches the transport, and the key never leaves", async () => {
    const { result, seen } = await probe(AIRGAP, WAN)
    // The evidence that matters: the socket was never opened, so the Bearer token never travelled.
    expect(seen).toEqual([])
    expect(JSON.stringify(seen)).not.toContain("sk-live")
    expect(result.kind).toBe("blocked")
    if (result.kind !== "blocked") throw new Error("unreachable")
    expect(result.host).toBe("api.openai.com")
  })

  test("NEGATIVE CONTROL — airgap OFF: the same URL, the same stub, one recorded request", async () => {
    // Without this, the zero above could be a stub that was never reachable in the first place.
    const { result, seen } = await probe(OPEN, WAN)
    expect(result.kind).toBe("ok")
    expect(seen.map((entry) => entry.url)).toEqual([WAN])
    expect(seen[0]?.authorization).toBe(SECRET)
  })

  test("airgap ON: loopback still works — an airgapped user's only possible model is a local one", async () => {
    const { result, seen } = await probe(AIRGAP, LOOPBACK)
    expect(result.kind).toBe("ok")
    expect(seen.map((entry) => entry.url)).toEqual([LOOPBACK])
  })

  test("airgap ON: every local-runtime sweep candidate reaches the transport", async () => {
    // The sibling S0 sweep (`core/src/config/local-runtime.ts`) probes these four through THIS
    // handler. `checkUrl` short-circuits on loopback before consulting the allowlist, so the sweep
    // is legal while airgapped — this asserts the guard I added did not quietly break that.
    for (const candidate of ConfigLocalRuntime.CANDIDATES) {
      const url = `${candidate.baseURL}/models`
      const { result, seen } = await probe(AIRGAP, url)
      expect(result.kind, candidate.id).toBe("ok")
      expect(
        seen.map((entry) => entry.url),
        candidate.id,
      ).toEqual([url])
    }
    expect(ConfigLocalRuntime.CANDIDATES.length).toBeGreaterThan(0)
  })
})

describe("ruling 2 — a refusal and an outage are different facts", () => {
  test("the block says 'blocked by airgap', carries the remedy, and is NOT filed as unreachable", async () => {
    const { result } = await probe(AIRGAP, WAN)
    if (result.kind !== "blocked") throw new Error(`expected blocked, got ${result.kind}`)
    // The headline is first so it survives any downstream truncation.
    expect(result.detail.startsWith(AIRGAP_BLOCK_PREFIX)).toBe(true)
    expect(result.detail).toContain("airgap")
    // The policy's own remedy text reaches the user — no i18n key could carry it.
    expect(result.detail).toContain("NOVACLAW_OFFLINE_ALLOW")
    expect(result.detail).toContain("turn offline mode off")
    // …and it is never described as unreachability: the endpoint may be perfectly healthy.
    expect(result.status).toBe("error")
    expect(result.status).not.toBe("unreachable")
    expect(result.detail).not.toContain("No answer within")
  })

  test("a genuinely dead endpoint is still `unreachable`, with no airgap wording", async () => {
    const { result, seen } = await probe(OPEN, WAN, refusing())
    expect(result.kind).toBe("unreachable")
    if (result.kind !== "unreachable") throw new Error("unreachable")
    expect(result.status).toBe("unreachable")
    expect(result.detail).toContain("ConnectionRefused")
    expect(result.detail).not.toContain(AIRGAP_BLOCK_PREFIX)
    // It DID try — that is exactly what makes it a different fact from the block above.
    expect(seen.map((entry) => entry.url)).toEqual([WAN])
  })

  test("an HTTP error and an auth failure keep their own arms", async () => {
    const notFound = await probe(
      OPEN,
      WAN,
      recording(() => new Response("nope", { status: 404 })),
    )
    expect(notFound.result.kind).toBe("http")
    expect(notFound.result.kind === "http" && notFound.result.status).toBe("error")

    const unauthorized = await probe(
      OPEN,
      WAN,
      recording(() => new Response("nope", { status: 401 })),
    )
    expect(unauthorized.result.kind).toBe("auth")
  })
})
