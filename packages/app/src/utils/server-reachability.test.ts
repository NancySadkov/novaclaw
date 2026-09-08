import { describe, expect, test } from "bun:test"
import type { ServerConnection } from "@/context/server"
import { dict as en } from "@/i18n/en"
import { checkServerHealth, connectionErrorCopy, serverReachability } from "./server-health"

const server: ServerConnection.HttpBase = { url: "http://localhost:4096" }

const answering = (status: number, body: unknown) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch

/** A connection refusal: the shape a dead port produces, not an answer. */
const refusing = (async () => {
  throw new TypeError("fetch failed: ECONNREFUSED")
}) as unknown as typeof globalThis.fetch

/**
 * 🔴 **The PAIR is the proof.** A 401 must classify as `rejected` and a refusal as `unreachable`,
 * and each case alone passes on the broken tree — which collapsed both into `healthy: false` and
 * showed "Could not reach <instance>" either way. Only asserting them together, from the wire
 * through the classifier to the sentence the gate renders, can fail on it.
 */
describe("server reachability", () => {
  test("a 401 from the wire is a REJECTION and a refusal is an OUTAGE", async () => {
    const rejected = await checkServerHealth(server, answering(401, { error: "unauthorized" }), { retryCount: 0 })
    const unreachable = await checkServerHealth(server, refusing, { retryCount: 0, retryDelayMs: 0 })

    expect(serverReachability(rejected)).toBe("rejected")
    expect(serverReachability(unreachable)).toBe("unreachable")
    expect(serverReachability(rejected)).not.toBe(serverReachability(unreachable))
  })

  test("403 rejects too, a healthy answer is ok, and a missing answer is an outage", async () => {
    const forbidden = await checkServerHealth(server, answering(403, { error: "forbidden" }), { retryCount: 0 })
    const healthy = await checkServerHealth(server, answering(200, { healthy: true, version: "1.2.3" }))

    expect(serverReachability(forbidden)).toBe("rejected")
    expect(serverReachability(healthy)).toBe("ok")
    expect(serverReachability(undefined)).toBe("unreachable")
    // A 500 answers, but it is not an ANSWER about credentials — it stays an outage.
    expect(serverReachability({ healthy: false })).toBe("unreachable")
  })

  test("the gate says CREDENTIALS for a rejection and OUTAGE for an unreachable instance", () => {
    const rejected = connectionErrorCopy({ hasServer: true, reachability: "rejected", supervisorGaveUp: false })
    const unreachable = connectionErrorCopy({ hasServer: true, reachability: "unreachable", supervisorGaveUp: false })

    expect(rejected.headline).toBe("app.server.rejected")
    expect(rejected.detail).toBe("app.server.rejectedHint")
    expect(unreachable.headline).toBe("app.server.unreachable")
    expect(unreachable.detail).toBe("app.server.retrying")
    expect(rejected.headline).not.toBe(unreachable.headline)

    // The sentences must exist and actually be about the two different things.
    expect(en[rejected.headline]).toContain("{{server}}")
    expect(en[rejected.detail].toLowerCase()).toContain("password")
    expect(en[unreachable.detail].toLowerCase()).not.toContain("password")
  })

  test("a rejection does not promise a retry, and does not probe at the outage cadence", () => {
    const rejected = connectionErrorCopy({ hasServer: true, reachability: "rejected", supervisorGaveUp: false })
    const unreachable = connectionErrorCopy({ hasServer: true, reachability: "unreachable", supervisorGaveUp: false })

    expect(rejected.probeEveryMs).toBeGreaterThan(unreachable.probeEveryMs)
    // ...but it must still probe: a credential repaired on the server side has to clear this screen.
    expect(rejected.probeEveryMs).toBeGreaterThan(0)
    expect(Number.isFinite(rejected.probeEveryMs)).toBe(true)
  })

  test("the no-instance and supervisor-stopped screens are unchanged", () => {
    const none = connectionErrorCopy({ hasServer: false, reachability: "unreachable", supervisorGaveUp: false })
    const stopped = connectionErrorCopy({ hasServer: true, reachability: "unreachable", supervisorGaveUp: true })

    expect(none).toEqual({ headline: "app.server.none", detail: "app.server.noneHint", probeEveryMs: 1_000 })
    expect(stopped.headline).toBe("app.server.unreachable")
    expect(stopped.detail).toBe("app.connection.stopped.description")
    expect(stopped.probeEveryMs).toBe(1_000)
    // A rejection outranks the local supervisor's phase: the instance the shell is DRIVING answered.
    expect(connectionErrorCopy({ hasServer: true, reachability: "rejected", supervisorGaveUp: true }).headline).toBe(
      "app.server.rejected",
    )
  })
})
