import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { LLMError } from "@novaclaw/llm"
import { RequestExecutor } from "@novaclaw/llm/route"
import { Offline } from "../src/offline"
import { ProviderRetry } from "../src/session/runner/provider-retry"
import { sessionErrorDisplay } from "../src/session/session-error"

/**
 * The offline/airgap verdict, END TO END — producer → executor → retry policy → display.
 *
 * ⚠️ **This test exists because every OTHER check in this chain can pass while production is
 * broken.** `packages/llm/test/executor.test.ts` reconstructs the error shape by hand, so it would
 * still be green if `Offline.guard` stopped attaching the `EgressBlocked` marker; the taxonomy test
 * hands `sessionErrorDisplay` a literal `_tag: "OfflineBlocked"`, so it would still be green if
 * nothing ever produced that tag. This one drives the REAL `Offline.guard` through the REAL
 * `RequestExecutor` and into the REAL display, so the four halves are pinned to each other.
 *
 * What it protects (v0.2.0 ruling 2 — *a fault is never described falsely*): an offline block is a
 * DECISION the user's instance made, an unreachable endpoint is an OUTAGE. They used to arrive
 * under one `Transport` tag, which meant the runner retried the verdict three times, the display
 * had to regex the executor's prose to recover what the type had discarded, and the user was told
 * the model server could not be reached when it was perfectly healthy.
 */

const VERDICT =
  "Offline mode: request to host 'api.example.com' blocked (fail-closed). " +
  "Only loopback and the configured model-provider hosts are reachable (allowed: none). " +
  "To allow it: add the provider globally (Settings → Models), extend NOVACLAW_OFFLINE_ALLOW " +
  "(comma-separated hosts), or turn offline mode off."

/**
 * A minimal `Offline.Interface` whose policy blocks everything but loopback — the airgap case.
 * `check` is the REAL `checkUrl`, so the verdict text under test is the product's own wording, not
 * a copy that could drift from it.
 */
const airgapped = (): Offline.Interface => {
  const policy: Offline.Policy = { enabled: true, allowedHosts: new Set<string>() }
  return {
    policy,
    check: (url: string) => Offline.checkUrl(url, policy),
    egressEnv: () => undefined,
    manifest: () => Offline.layerManifest(policy),
  }
}

/** The real guard wrapping a client that would otherwise succeed, under the real executor. */
const guardedExecutor = (offline: Offline.Interface) =>
  RequestExecutor.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        Offline.guard(
          HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}")))),
          offline,
        ),
      ),
    ),
  )

const blockedRequest = HttpClientRequest.post("https://api.example.com/v1/chat/completions")

const execute = (offline: Offline.Interface) =>
  Effect.gen(function* () {
    const executor = yield* RequestExecutor.Service
    return yield* executor.execute(blockedRequest).pipe(Effect.flip)
  }).pipe(Effect.provide(guardedExecutor(offline)), Effect.runPromise)

describe("an offline block travels as its own verdict, all the way to the screen", () => {
  test("the real guard's error becomes an OfflineBlocked reason, not Transport", async () => {
    const error = await execute(airgapped())
    expect(error).toBeInstanceOf(LLMError)
    const llm = error as LLMError
    expect(llm.reason._tag).toBe("OfflineBlocked")
    expect(llm.reason).toMatchObject({ host: "api.example.com" })
    // The policy's own remedy text survives — no i18n key could ever carry it.
    expect(llm.reason.message).toContain("turn offline mode off")
  })

  test("the runner's retry policy refuses it BY TYPE, with no `kind` string to sniff", async () => {
    const error = await execute(airgapped())
    expect(ProviderRetry.isTransientProviderFailure(error)).toBe(false)
    expect((error as LLMError).retryable).toBe(false)
  })

  test("the display names the refused host and never offers a retry", async () => {
    const error = await execute(airgapped())
    const llm = error as LLMError
    // Exactly what `runner/llm.ts` puts on the wire: the reason's message and its `_tag`.
    const shown = sessionErrorDisplay({
      type: "unknown",
      message: llm.reason.message,
      _tag: llm.reason._tag,
      retryable: ProviderRetry.isTransientProviderFailure(error),
    })
    expect(shown.key).toBe("session.error.offlineBlockedEndpoint")
    expect(shown.params?.endpoint).toBe("api.example.com")
    expect(shown.headline).toBe("Offline mode blocked this request to api.example.com, so it never left your computer.")
    expect(shown.canRetry).toBe(false)
    // Never described as unreachability: the server may be perfectly healthy.
    expect(shown.headline).not.toContain("Can't reach")
    // …and the remedy reaches the user as `detail`.
    expect(shown.detail).toContain("NOVACLAW_OFFLINE_ALLOW")
  })

  test("a request the policy ALLOWS is untouched — the guard is not a blanket failure", async () => {
    const offline = airgapped()
    const response = await Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      return yield* executor.execute(HttpClientRequest.post("http://127.0.0.1:8000/v1/chat/completions"))
    }).pipe(Effect.provide(guardedExecutor(offline)), Effect.runPromise)
    expect(response.status).toBe(200)
  })
})
