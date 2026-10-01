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

describe("the stream ladder is told when the instance is still starting", () => {
  // 🔴 Measured 2026-09-28 across nine real boots of the packaged app: the gap between the supervisor
  // reporting the server healthy and the client connecting was bimodal — five boots at 0.2–1.2s, four
  // at 27.7–29.9s. The slow boots had a server that was provably answering CORS correctly and whose
  // own log recorded no client for 35s. The client was asleep on a backoff earned against a port that
  // was not bound yet, and it slept through the server arriving.
  //
  // The ratchet holds the WIRE, not the maths. `streamRetryDelayMs` and `retryNow` are pinned
  // behaviourally in `reconnect-schedule.test.ts` and `reconnect-stream.test.ts`; what a future author
  // can silently break is the wiring — handing `reconnectDelayMs` straight back to the loop, or
  // dropping the window — and neither shows up as a failing number anywhere else.
  const source = () => {
    const code = fs
      .readFileSync(path.join(import.meta.dir, "server-sdk.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n")
    expect(code.length, "server-sdk.tsx must be readable — a moved file must fail LOUDLY").toBeGreaterThan(500)
    return code
  }

  test("the loop is given the start-aware delay, never the bare outage schedule", () => {
    const code = source()
    expect(code).toContain("streamRetryDelayMs")
    // The bare schedule has no way to know about a start; handing it to the loop is the defect itself.
    expect(code).not.toMatch(/delay:\s*reconnectDelayMs/)
    expect(code).toMatch(/starting:\s*supervisorPhase\(\)\?\.phase === "starting"/)
  })

  test("the loop is given the window, so the failures earned against a dead port are discarded", () => {
    const code = source()
    expect(code).toContain("useSupervisorPhase")
    expect(code).toMatch(/retryNow:\s*\(\) => startWindow\?\.signal/)
  })

  test("a window is opened only on the TRANSITION into starting, and spent on the way out", () => {
    // `useSupervisorPhase` delivers the phase twice — from the subscription and from the read that
    // follows it. An unguarded effect would mint a second window for one start and strand the loop
    // waiting on a signal nobody would ever abort, which reintroduces the very stall this removes.
    const code = source()
    expect(code).toMatch(/current === "starting" && previous !== "starting"/)
    expect(code).toMatch(/current === "running" && previous !== "running"/)
  })

  test("an instance that is merely down opens no window, so the ladder's restraint is untouched", () => {
    // The regression this must never cause: a four-hertz reconnect storm against a server that is
    // down or refusing. Only a phase that passed THROUGH `starting` may open one, so a `running` or
    // `gave-up` instance — and every client with no supervisor at all — is left exactly as it was.
    const code = source()
    const opens = code.match(/startWindow = new AbortController\(\)/g) ?? []
    expect(opens).toHaveLength(1)
    // And it is reachable ONLY from the `starting` branch, never on a phase check alone.
    expect(code).not.toMatch(/if \(current === "running"\) startWindow/)
  })

  test("🔴 a half-open ATTEMPT during a start is bounded by the short establishment heartbeat", () => {
    // The cadence ratchets above bound the wait BETWEEN attempts. They say nothing about ONE attempt
    // that the server accepted and never answered, which the idle heartbeat ends at 15 s — so the
    // start-aware ladder could still park for the full idle window twice. The establishment heartbeat
    // must therefore be phase-aware at the ATTEMPT-START seam, not only in the delay.
    const code = source()
    expect(code).toContain("streamHeartbeatMs")
    expect(code).toMatch(/resetHeartbeat\(streamHeartbeatMs\(supervisorPhase\(\)\?\.phase === "starting"\)\)/)
    // The long idle bound must remain the default the connected stream re-arms with.
    expect(code).toMatch(/resetHeartbeat = \(timeoutMs: number = HEARTBEAT_TIMEOUT_MS\)/)
  })

  test("🔴 the running edge abandons the in-flight attempt, not only the sleep", () => {
    // Cutting only the sleep leaves a half-open `open()` to run out its full idle heartbeat after the
    // server is already healthy. Measured 0.1.83: healthy at 6.6 s, connected at 38.4 s. The attempt
    // that crossed the `starting` → `running` edge must be retried, not waited out.
    const code = source()
    const running = code.slice(code.indexOf('if (current === "running"'))
    expect(running).toMatch(/startWindow\?\.abort\(\)[\s\S]*attempt\?\.abort\(\)/)
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

    expect(code).toContain("resetHeartbeat(streamHeartbeatMs(")
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
