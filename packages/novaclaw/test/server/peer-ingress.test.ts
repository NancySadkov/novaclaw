import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { CommunityAdmission } from "@novaclaw/core/community/admission"
import { CommunityConsent } from "@novaclaw/core/community/consent"
import { readFileSync } from "node:fs"
import { CommunityReconcile } from "@novaclaw/core/community/reconcile"
import { CommunitySync } from "@novaclaw/core/community/sync"
import { Offline } from "@novaclaw/core/offline"
import { CommunityPeerPaths } from "../../src/server/routes/instance/httpapi/groups/community"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { cosignedRotation, mintIdentity } from "../../../core/test/lib/community"

/**
 * 🔴 Codex review 2026-08-17, P1 — **the anonymous sync surface amplified without limit.**
 *
 * The peer doors that STORE something charge proof-of-work; the ones that READ charge nothing, by
 * design, and multiply: `/sync/ids` ≈335 KB for a ~200-byte request, `GET /succession` the whole
 * table (≈230 KB for an ~80-byte GET, about 2,900×), `/sync/summary` a 64-bucket digest recomputed
 * over 5,000 ids per call. The 256 KB inbound cap bounds one request's SIZE and says nothing about
 * how many arrive.
 *
 * ⚠️ Driven through the real web handler, because the property is about what a stranger receives —
 * the governor's arithmetic is pinned separately in `packages/core`, and passing there proves only
 * that the function works, never that anything calls it.
 */

function app() {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
    { disableLogger: true },
  ).handler
  return {
    request(input: string, init?: RequestInit) {
      return handler(new Request(new URL(input, "http://localhost"), init), HttpApiApp.context)
    },
  }
}

async function cancelBody(response: Response) {
  await response.body?.cancel().catch(() => {})
}

const post = (server: ReturnType<typeof app>, path: string, directory: string, body: unknown) => {
  const payload = JSON.stringify(body)
  return server.request(path, {
    method: "POST",
    headers: {
      "x-novaclaw-directory": directory,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(payload)),
    },
    body: payload,
  })
}

afterEach(async () => {
  // All three gates are process-wide: a test that spends the minute's allowance must hand it back,
  // or the next file's first request is refused for reasons it cannot see.
  CommunityAdmission.reset()
  CommunityConsent.resetGate()
  Offline.resetPolicy()
  await disposeAllInstances()
  await resetDatabase()
})

describe("the anonymous peer doors are bounded (Codex P1)", () => {
  test("🔴 a stranger in a loop is refused rather than served forever", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const server = app()
    CommunityConsent.applied({ consented: true, enabled: true }, { enabled: false })

    // The cheapest read there is, repeated. Before the governor every one of these was served.
    let refused = 0
    let served = 0
    for (let i = 0; i < CommunityAdmission.PER_SOURCE_PER_MINUTE + 20; i++) {
      const response = await server.request(CommunityPeerPaths.identity, {
        headers: { "x-novaclaw-directory": tmp.path },
      })
      await cancelBody(response)
      if (response.status === 429) refused++
      else served++
    }
    expect(refused, "the loop must hit a ceiling").toBeGreaterThan(0)
    expect(served, "…and honest traffic below it must be served").toBeGreaterThan(0)
    expect(served).toBeLessThanOrEqual(CommunityAdmission.PER_SOURCE_PER_MINUTE)
  })

  test("🔴 a refusal tells the caller when to come back", async () => {
    // A peer that cannot tell "slow down" from "gone" retries the wrong thing forever, which is how
    // a limiter turns into an outage for honest callers.
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const server = app()
    CommunityConsent.applied({ consented: true, enabled: true }, { enabled: false })
    for (let i = 0; i < CommunityAdmission.PER_SOURCE_PER_MINUTE; i++)
      await cancelBody(
        await server.request(CommunityPeerPaths.identity, { headers: { "x-novaclaw-directory": tmp.path } }),
      )

    const refused = await server.request(CommunityPeerPaths.identity, {
      headers: { "x-novaclaw-directory": tmp.path },
    })
    await cancelBody(refused)
    expect(refused.status).toBe(429)
    expect(refused.headers.get("retry-after")).toBe("60")
  })

  test("🔴 `GET /succession` serves at most what an honest caller reads — with a FULL table", async () => {
    /**
     * It served the whole table — up to 1,000 statements for an ~80-byte GET, about 2,900× — while
     * every honest caller has discarded everything past `MAX_SUCCESSIONS_PER_ANSWER` since the day
     * it was written. That is amplification with no reader.
     *
     * 🔴 The table is FILLED first, and that is the difference between this test and the vacuous one
     * it replaces. Asserting `length <= 64` against an empty store passes whether or not the bound
     * exists — measured: with the slice removed it still passed. Announcing a rotation costs no
     * proof-of-work by design, which is exactly why the door needed the cap and why filling it here
     * is cheap.
     */
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const server = app()
    CommunityConsent.applied({ consented: true, enabled: true }, { enabled: false })

    const overflow = CommunitySync.MAX_SUCCESSIONS_PER_ANSWER + 12
    for (let i = 0; i < overflow; i++) {
      const statement = cosignedRotation(mintIdentity(), mintIdentity())
      const stored = await post(server, CommunityPeerPaths.succession, tmp.path, statement)
      await cancelBody(stored)
      expect(stored.status, "a co-signed statement is accepted by the anonymous door").toBe(200)
    }

    const response = await server.request(CommunityPeerPaths.succession, {
      headers: { "x-novaclaw-directory": tmp.path },
    })
    const body = (await response.json()) as { statements: readonly unknown[] }
    expect(body.statements.length).toBe(CommunitySync.MAX_SUCCESSIONS_PER_ANSWER)
  })

  test("🔴 `/sync/ids` answers a bounded number of ids, whatever is asked for", async () => {
    /**
     * ⚠️ The BOUND itself is proven in `packages/core` over five thousand ids, where it costs
     * nothing; filling a room here would mean paying ~49 ms of proof-of-work a thousand times. What
     * this proves is the half that test cannot: the door really calls it.
     */
    await using tmp = await tmpdir({ git: true, config: { formatter: false } })
    const server = app()
    CommunityConsent.applied({ consented: true, enabled: true }, { enabled: false })

    // Thousands of buckets that cannot exist — the shape a prober sends.
    const buckets = Array.from({ length: 5_000 }, (_, i) => i)
    const response = await post(server, CommunityPeerPaths.syncIds, tmp.path, { topic: "whatever", buckets })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ids: readonly string[] }
    expect(body.ids.length).toBeLessThanOrEqual(CommunityReconcile.MAX_IDS_PER_ANSWER)

    const handlers = readFileSync(
      new URL("../../src/server/routes/instance/httpapi/handlers/community.ts", import.meta.url),
      "utf8",
    )
    expect(handlers, "the door must answer through the bounded helper, not by slicing twice").toContain(
      "CommunityReconcile.answerIds(",
    )
  })
})
