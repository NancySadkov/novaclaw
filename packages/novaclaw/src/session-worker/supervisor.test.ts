import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { EventV2 } from "@novaclaw/core/event"
import { Effect } from "effect"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"
import { SessionWorkerDeviceBridge } from "./device-bridge"
import { PermissionV2 } from "@novaclaw/core/permission"
import { QuestionV2 } from "@novaclaw/core/question"
import { SessionWorkerInteractionBridge } from "./interaction-bridge"
import { SessionWorkerExecutionBridge } from "./execution-bridge"
import type { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { activeWorkerCount, spawn } from "./supervisor"
import { SessionSpawner } from "@novaclaw/core/session/spawner"
import { SessionJoin } from "@novaclaw/core/session/join"

const joinStub: SessionJoin.Interface = {
  awaitCompletion: () => Effect.die(new Error("join is not exercised by this test")),
}

const spawnerStub: SessionSpawner.Interface = {
  spawn: () => Effect.die(new Error("spawn is not exercised by this test")),
}

const fixture = path.resolve(import.meta.dir, "../../test/fixtures/session-worker.ts")
const entrypointFixture = path.resolve(import.meta.dir, "../../test/fixtures/session-worker-entrypoint.ts")
const lease = {
  sessionID: SessionSchema.ID.make("ses_worker_supervisor"),
  attemptID: "exe_worker_supervisor",
  generation: 1,
  ownerID: "host-test",
}

const run = (mode: string) =>
  spawn({
    command: [process.execPath, fixture, mode],
    lease,
    directory: process.cwd(),
    force: false,
    // Executing a TS fixture from a Windows-mounted checkout under WSL can spend several seconds
    // in Bun's loader before user code starts. This is a containment test, not a cold-start budget.
    startupTimeoutMs: 8_000,
    heartbeatTimeoutMs: 350,
    interruptGraceMs: 100,
  })

test("a real worker settles through the fenced lifecycle protocol", async () => {
  const worker = run("settle")
  expect(await worker.result).toEqual({ type: "settled" })
})

test("a worker that never becomes ready is killed at the startup deadline", async () => {
  const worker = run("unready")
  expect(await worker.result).toEqual({ type: "start-timeout" })
}, 15_000)

test("a silent live worker is tree-killed after its heartbeat deadline", async () => {
  const worker = run("silent")
  expect(await worker.result).toEqual({ type: "heartbeat-timeout" })
})

test("a stale worker identity is rejected and tree-killed", async () => {
  const worker = run("stale")
  expect(await worker.result).toEqual({ type: "stale-message" })
})

test("structured worker failure survives the process boundary", async () => {
  const worker = run("fail")
  expect(await worker.result).toEqual({
    type: "failed",
    classification: "fixture-failure",
    detail: "deliberate",
  })
})

test("an untyped worker defect is contained as a protocol error", async () => {
  expect(await run("defect").result).toEqual({ type: "protocol-error", detail: "worker message is not valid JSON" })
})

test("ordinary exits and OS signals retain distinct diagnostics", async () => {
  expect(await run("crash").result).toEqual({ type: "exited", code: 42 })
  expect(await run("signal").result).toEqual(
    process.platform === "win32" ? { type: "exited", code: 1 } : { type: "signaled", signal: "SIGTERM" },
  )
})

test("a late event from an obsolete attempt is fenced", async () => {
  expect(await run("late-stale").result).toEqual({ type: "stale-message" })
})

test("explicit interrupt has a bounded grace period", async () => {
  const worker = run("silent")
  expect(await worker.interrupt()).toEqual({ type: "interrupted" })
})

test("event RPCs are acknowledged in request order", async () => {
  const handled: string[] = []
  let sequence = 0
  const worker = spawn({
    command: [process.execPath, fixture, "publish"],
    lease,
    directory: process.cwd(),
    force: false,
    startupTimeoutMs: 8_000,
    heartbeatTimeoutMs: 2_000,
    onPublishEvent: async (message) => {
      if (message.requestID === "rpc_1") await Bun.sleep(30)
      handled.push(message.requestID)
      return {
        version: 1,
        type: "event-published",
        sessionID: message.sessionID,
        attemptID: message.attemptID,
        generation: message.generation,
        requestID: message.requestID,
        eventID: EventV2.ID.create(),
        durable: { aggregateID: message.sessionID, seq: sequence++, version: 1 },
      }
    },
  })
  expect(await worker.result).toEqual({ type: "settled" })
  expect(handled).toEqual(["rpc_1", "rpc_2"])
})

test("device admission/report/release stay host-owned and exit reclaims the session", async () => {
  const scheduler = SessionScheduler.make()
  const handled: string[] = []
  const worker = spawn({
    command: [process.execPath, fixture, "device"],
    lease,
    directory: process.cwd(),
    force: false,
    startupTimeoutMs: 8_000,
    heartbeatTimeoutMs: 2_000,
    onDeviceRequest: (message) => {
      handled.push(message.type)
      return Effect.runPromise(SessionWorkerDeviceBridge.handle({ scheduler, lease, message }))
    },
    onExit: () => Effect.runPromise(SessionWorkerDeviceBridge.reclaim(scheduler, lease)),
  })
  expect(await worker.result).toEqual({ type: "settled" })
  expect(handled).toEqual(["device-admit", "device-report", "device-release"])
  expect((await Effect.runPromise(scheduler.snapshot()))[0]?.inFlightInteractive).toEqual([])
})

test("worker cleanup has a deadline", async () => {
  const worker = spawn({
    command: [process.execPath, fixture, "settle"],
    lease,
    directory: process.cwd(),
    force: false,
    cleanupTimeoutMs: 50,
    onExit: () => new Promise(() => undefined),
  })
  const started = Date.now()
  expect(await worker.result).toEqual({ type: "settled" })
  // Includes spawning Bun on a cold Windows host; the 50 ms cleanup deadline is what prevents
  // this deliberately never-resolving callback from hanging forever.
  expect(Date.now() - started).toBeLessThan(4_000)
})

test("a heartbeat failure aborts an in-flight host RPC", async () => {
  let aborted = false
  const worker = spawn({
    command: [process.execPath, fixture, "device"],
    lease,
    directory: process.cwd(),
    force: false,
    startupTimeoutMs: 8_000,
    heartbeatTimeoutMs: 350,
    onDeviceRequest: (_message, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true
            reject(signal.reason)
          },
          { once: true },
        )
      }),
  })
  expect(await worker.result).toEqual({ type: "heartbeat-timeout" })
  expect(aborted).toBe(true)
})

test("permission and question waits execute in host-owned services", async () => {
  const handled: string[] = []
  const permission = {
    ask: () => Effect.die("unused"),
    assert: () => Effect.void,
    reply: () => Effect.die("unused"),
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  } as PermissionV2.Interface
  const question = {
    ask: () => Effect.succeed([["Yes"]]),
    reply: () => Effect.die("unused"),
    reject: () => Effect.die("unused"),
    list: () => Effect.succeed([]),
  } as QuestionV2.Interface
  const worker = spawn({
    command: [process.execPath, fixture, "interaction"],
    lease,
    directory: process.cwd(),
    force: false,
    startupTimeoutMs: 8_000,
    heartbeatTimeoutMs: 2_000,
    onInteractionRequest: (message) => {
      handled.push(message.type)
      return Effect.runPromise(SessionWorkerInteractionBridge.handle({
        permission,
        question,
        spawner: spawnerStub,
        join: joinStub,
        // Host-side hand-off is not what this case exercises — it must never run here.
        colleague: {
          deliver: () => Effect.die("unused"),
          hire: () => Effect.die("unused"),
          retire: () => Effect.die("unused"),
        },
        lease,
        message,
      }))
    },
  })
  expect(await worker.result).toEqual({ type: "settled" })
  expect(handled).toEqual(["permission-assert", "question-ask"])
})

test("the standard worker entrypoint publishes through the host and settles", async () => {
  const published: string[] = []
  const worker = spawn({
    command: [process.execPath, entrypointFixture, "publish"],
    lease,
    directory: process.cwd(),
    force: false,
    startupTimeoutMs: 8_000,
    heartbeatTimeoutMs: 500,
    onPublishEvent: async (message) => {
      published.push(message.eventType)
      return {
        version: 1,
        type: "event-published",
        sessionID: message.sessionID,
        attemptID: message.attemptID,
        generation: message.generation,
        requestID: message.requestID,
        eventID: EventV2.ID.create(),
      }
    },
  })
  expect(await worker.result).toEqual({ type: "settled" })
  expect(published).toEqual(["session.next.synthetic"])
})

test("worker diagnostics stay on stderr and cannot corrupt the stdout protocol", async () => {
  const worker = spawn({
    command: [process.execPath, entrypointFixture, "log"],
    lease,
    directory: process.cwd(),
    force: false,
    startupTimeoutMs: 8_000,
    heartbeatTimeoutMs: 2_000,
  })
  expect(await worker.result).toEqual({ type: "settled" })
})

test("a standard worker exits cleanly when interrupted", async () => {
  const worker = spawn({
    command: [process.execPath, entrypointFixture, "interrupt"],
    lease,
    directory: process.cwd(),
    force: false,
    startupTimeoutMs: 8_000,
    heartbeatTimeoutMs: 500,
    interruptGraceMs: 500,
  })
  await Bun.sleep(100)
  expect(await worker.interrupt()).toEqual({ type: "interrupted" })
})

test("the standard worker keeps execution checkpoints and heartbeats host-owned", async () => {
  const advanced: string[] = []
  const contextUpdates: string[] = []
  const receipts: string[] = []
  let heartbeats = 0
  const attempts = {
    start: () => Effect.succeed(lease),
    owns: () => Effect.succeed(true),
    advance: (_lease, phase, checkpoint) =>
      Effect.sync(() => {
        advanced.push(`${phase}:${checkpoint}`)
      }),
    toolDispatched: (_lease, receipt) =>
      Effect.sync(() => receipts.push(`dispatch:${receipt.callID}:${receipt.sideEffect}`)),
    toolSettled: (_lease, callID) => Effect.sync(() => receipts.push(`settle:${callID}`)),
    servedBy: (_lease, fingerprint) => Effect.sync(() => receipts.push(`served:${fingerprint}`)),
    heartbeat: () =>
      Effect.sync(() => {
        heartbeats++
      }),
    providerStarted: () => Effect.void,
    providerToolProtocol: () => Effect.void,
    providerSettled: () => Effect.void,
    providerRecovery: () => Effect.succeed(undefined),
    settle: () => Effect.void,
    recoverFailure: () => Effect.succeed(undefined),
    get: () => Effect.succeed(undefined),
    list: () => Effect.succeed([]),
    authorizeRetry: () => Effect.void,
    recoverStale: () => Effect.succeed([]),
  } as SessionExecutionAttempt.Interface
  const worker = spawn({
    command: [process.execPath, entrypointFixture, "execution"],
    lease,
    directory: process.cwd(),
    force: false,
    startupTimeoutMs: 8_000,
    heartbeatTimeoutMs: 500,
    onHeartbeat: (message) => Effect.runPromise(SessionWorkerExecutionBridge.heartbeat({ attempts, lease, message })),
    onExecutionRequest: (message) =>
      Effect.runPromise(
        SessionWorkerExecutionBridge.handle({
          attempts,
          lease,
          message,
          contextUpdated: (update) => Effect.sync(() => contextUpdates.push(update.text)).pipe(Effect.asVoid),
        }),
      ),
  })
  expect(await worker.result).toEqual({ type: "settled" })
  expect(advanced).toEqual(["provider:mark"])
  expect(contextUpdates).toEqual(["context changed"])
  // 🔴 The serving identity crosses the worker boundary under its own message. Five files carry it
  // (protocol, client pairing, supervisor admission, bridge, worker facade) and a receipt would be
  // silently blank on provenance under the worker if any one of them were missed.
  expect(receipts).toEqual([
    "dispatch:call_fixture:idempotent-write",
    "settle:call_fixture",
    "served:vllm-fixture-a44fe734",
  ])
  expect(heartbeats).toBeGreaterThan(0)
})

test("a CPU-wedged session cannot delay an unrelated session or retain an idle worker", async () => {
  const wedged = spawn({
    command: [process.execPath, fixture, "busy"],
    lease: { ...lease, sessionID: SessionSchema.ID.make("ses_worker_wedged"), attemptID: "exe_wedged" },
    directory: process.cwd(),
    force: false,
    startupTimeoutMs: 8_000,
    heartbeatTimeoutMs: 350,
  })
  const started = Date.now()
  const healthy = spawn({
    command: [process.execPath, fixture, "settle"],
    lease: { ...lease, sessionID: SessionSchema.ID.make("ses_worker_healthy"), attemptID: "exe_healthy" },
    directory: process.cwd(),
    force: false,
    startupTimeoutMs: 8_000,
    heartbeatTimeoutMs: 2_000,
  })
  expect(await healthy.result).toEqual({ type: "settled" })
  // The healthy peer must complete independently; allow Bun's WSL-on-NTFS loader overhead while
  // remaining far below the wedged worker's unbounded lifetime.
  expect(Date.now() - started).toBeLessThan(4_000)
  expect(await wedged.result).toEqual({ type: "heartbeat-timeout" })
  expect(activeWorkerCount()).toBe(0)
})

test("one crashing session leaves its concurrent peer alive", async () => {
  const crashed = spawn({
    command: [process.execPath, fixture, "crash"],
    lease: { ...lease, sessionID: SessionSchema.ID.make("ses_worker_crash"), attemptID: "exe_crash" },
    directory: process.cwd(),
    force: false,
  })
  const peer = spawn({
    command: [process.execPath, fixture, "settle"],
    lease: { ...lease, sessionID: SessionSchema.ID.make("ses_worker_peer"), attemptID: "exe_peer" },
    directory: process.cwd(),
    force: false,
  })
  expect(await crashed.result).toEqual({ type: "exited", code: 42 })
  expect(await peer.result).toEqual({ type: "settled" })
  expect(activeWorkerCount()).toBe(0)
})

test("reported worker memory pressure is contained without allocating it in the test host", async () => {
  const worker = spawn({
    command: [process.execPath, fixture, "memory"],
    lease: { ...lease, sessionID: SessionSchema.ID.make("ses_worker_memory"), attemptID: "exe_memory" },
    directory: process.cwd(),
    force: false,
    memoryLimitBytes: 1_000_000,
  })
  expect(await worker.result).toEqual({ type: "memory-limit", rssBytes: 2_000_000, limitBytes: 1_000_000 })
  expect(activeWorkerCount()).toBe(0)
})

test("a deleted session folder is named as the fault, not the interpreter", async () => {
  // A path that must NOT exist. It used to be keyed on `process.pid`, which is the wrong tool twice
  // over: pids are recycled, so a leftover directory from a dead run could occupy the name and turn
  // this assertion false, and the shape is the one `core/test/tmpdir-namespace.test.ts` now fails on
  // (a pid-named temp path is live state a later run can inherit). Nothing is created here, so a
  // random name is both correct and unambiguous.
  const missing = path.join(os.tmpdir(), `novaclaw-worker-gone-${crypto.randomUUID()}`)
  expect(
    await fs.stat(missing).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  const attempt = () =>
    spawn({
      command: [process.execPath, fixture, "settle"],
      lease: { ...lease, sessionID: SessionSchema.ID.make("ses_worker_gone"), attemptID: "exe_gone" },
      directory: missing,
      force: false,
    })
  // NEGATIVE CONTROL for the whole point of this test: uv_spawn reports a missing cwd as ENOENT with
  // `path` set to the EXECUTABLE (measured 2026-08-05 — same binary, missing cwd fails, valid cwd
  // spawns), so without the pre-check the operator is told the interpreter is missing. Assert the
  // message names the FOLDER and never the interpreter, or this guard passes while still lying.
  expect(attempt).toThrow(missing)
  expect(() => attempt()).not.toThrow(path.basename(process.execPath))
  expect(activeWorkerCount()).toBe(0)
})

test("interrupt tree-kills a tool subprocess owned by the isolated session", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "novaclaw-worker-tree-"))
  const marker = path.join(directory, "leaked.txt")
  try {
    const worker = spawn({
      command: [process.execPath, fixture, "child", marker],
      lease: { ...lease, sessionID: SessionSchema.ID.make("ses_worker_child"), attemptID: "exe_child" },
      directory: process.cwd(),
      force: false,
      interruptGraceMs: 100,
    })
    await Bun.sleep(150)
    expect(await worker.interrupt()).toEqual({ type: "interrupted" })
    await Bun.sleep(1_100)
    expect(
      await fs.stat(marker).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    expect(activeWorkerCount()).toBe(0)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
