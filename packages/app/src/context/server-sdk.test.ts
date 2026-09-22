import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { createReconnectRecoveryBarrier, resumeStreamAfterPageShow } from "./server-sdk"
import { enqueueEvent, EVENT_BACKLOG_LIMIT, EventBacklogOverflowError } from "./global-sync/event-backlog"

// S7: the V1 `message.part.*` coalescing tests retired with the translated vocabulary — the
// stream carries raw `session.next.*` events, pushed to the frame-batched queue unmodified.

describe("resumeStreamAfterPageShow", () => {
  test("restarts a stream only after a back-forward cache restore", () => {
    let starts = 0
    const start = () => starts++

    resumeStreamAfterPageShow({ persisted: false } as PageTransitionEvent, start)
    resumeStreamAfterPageShow({ persisted: true } as PageTransitionEvent, start)

    expect(starts).toBe(1)
  })
})

describe("event backlog", () => {
  test("forces resynchronization at the fixed queue limit", () => {
    const queue: number[] = []
    for (let index = 0; index < EVENT_BACKLOG_LIMIT; index++) enqueueEvent(queue, index)

    expect(queue).toHaveLength(EVENT_BACKLOG_LIMIT)
    expect(() => enqueueEvent(queue, EVENT_BACKLOG_LIMIT)).toThrow(EventBacklogOverflowError)
    expect(queue).toHaveLength(EVENT_BACKLOG_LIMIT)
  })

  test("the live stream discards stale batches and reconnects on overflow", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "server-sdk.tsx"), "utf8")
    const code = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n")

    expect(code).toContain("enqueueEvent(queue, { directory, payload })")
    expect(code).toMatch(/queue\.length = 0[\s\S]*buffer\.length = 0[\s\S]*throw error/)
    expect(code).toContain("if (error instanceof EventBacklogOverflowError) return")
  })
})

describe("reconnect recovery is a connection barrier", () => {
  test("the production stream delegates connection state and transcript recovery to the tested loop", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "server-sdk.tsx"), "utf8")
    expect(source).toContain("await runReconnectingStream({")
    expect(source).toContain("recover: (signal) => reconnectRecovery.run(signal)")
    expect(source).toContain("sseMaxRetryAttempts: 1")
    expect(source).toContain("setReconnectAttemptNumber(displayAttempt)")
    expect(source).toContain("setStreamStatus(status)")
  })

  test("arms the stream heartbeat at attempt start, so a hanging open cannot park the loop", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "server-sdk.tsx"), "utf8")
    const start = source.indexOf("attemptStarted: (controller) => {")
    const end = source.indexOf("attemptFinished: (controller) => {")

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)

    // `runReconnectingStream` awaits `open()` with no timeout of its own, so it only regains control
    // once `open()` settles. A HALF-OPEN connection — TCP established, response headers never
    // arriving — leaves `open()` unsettled, and a heartbeat armed only inside `open()` (after the SSE
    // response resolves) is then never reached. That is an unbounded window: no timer, no abort, no
    // `failed()` log, no `state("reconnecting")`, no banner, no retry.
    //
    // Measured 2026-09-12 in log/novaclaw.log: the global event stream for run=655af8cd went
    // `disconnected` at 08:06:49.885Z and the next subscription did not arrive until 11:00:37.777Z —
    // 2h53m48s dead, with no retry in between. Same shape on 09-06 (3h13m), 09-07 (6h22m),
    // 09-09 (4h05m) and 09-10 (3h27m).
    // ⚠️ Strip comment lines before asserting. The first version of this guard asserted
    // `toContain("resetHeartbeat()")` against the RAW slice — and still passed with the fix removed,
    // because the block contains this guard's own explanatory prose naming `resetHeartbeat()`. A
    // source ratchet that prose can satisfy is not a guard.
    const code = source
      .slice(start, end)
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n")

    expect(code).toContain("resetHeartbeat()")
  })

  test("does not settle before every registered recovery settles", async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => (release = resolve))
    const barrier = createReconnectRecoveryBarrier()
    barrier.register(() => pending)
    let settled = false

    const settling = barrier.run().then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)

    release()
    await settling
    expect(settled).toBe(true)
  })

  test("a failed projection keeps connected closed while independent projections still recover", async () => {
    const barrier = createReconnectRecoveryBarrier()
    let recovered = false
    barrier.register(() => {
      throw new Error("transcript read failed")
    })
    barrier.register(async () => {
      recovered = true
    })
    await expect(barrier.run()).rejects.toThrow("reconnect recovery failed")
    expect(recovered).toBe(true)
  })

  test("the native transcript is registered on the barrier rather than refreshed after connected", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "server-sync.tsx"), "utf8")
    expect(source).toMatch(
      /serverSDK\.reconnectRecovery\.register\(\(signal\) =>\s*nativeMessages\.reconcileAll\(signal\)/,
    )
    expect(source).not.toContain(
      'if ((event.type as string) === "server.connected") void nativeMessages.reconcileAll()',
    )
  })
})
