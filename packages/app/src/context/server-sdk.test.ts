import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { createReconnectRecoveryBarrier, resumeStreamAfterPageShow } from "./server-sdk"

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

describe("reconnect recovery is a connection barrier", () => {
  test("the production stream delegates connection state and transcript recovery to the tested loop", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "server-sdk.tsx"), "utf8")
    expect(source).toContain("await runReconnectingStream({")
    expect(source).toContain("recover: () => reconnectRecovery.run()")
    expect(source).toContain("setReconnectAttemptNumber(displayAttempt)")
    expect(source).toContain("setStreamStatus(status)")
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
    expect(source).toContain("serverSDK.reconnectRecovery.register(() => nativeMessages.reconcileAll())")
    expect(source).not.toContain(
      'if ((event.type as string) === "server.connected") void nativeMessages.reconcileAll()',
    )
  })
})
