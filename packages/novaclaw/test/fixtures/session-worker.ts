import { createInterface } from "node:readline"
import childProcess from "node:child_process"
import { SessionWorkerProtocol } from "@novaclaw/core/session/execution/worker-protocol"
import { SessionSchema } from "@novaclaw/core/session/schema"

const mode = process.argv[2] ?? "settle"
const input = createInterface({ input: process.stdin })
let identity:
  | {
      readonly version: 1
      readonly sessionID: SessionSchema.ID
      readonly attemptID: string
      readonly generation: number
    }
  | undefined
let acknowledgements = 0
let deviceStage = 0
let joinedChildren = 0
let generationReleased = false
let maintenanceReleased = false
let maintenanceID: string | undefined
let blockingPermissionAnswered = false
let blockingPublishAnswered = false

const emit = (message: SessionWorkerProtocol.WorkerMessage) =>
  process.stdout.write(SessionWorkerProtocol.encodeLine(message))

input.on("line", (line) => {
  const decoded = SessionWorkerProtocol.decodeHostLine(line)
  if (!decoded.ok) process.exit(64)
  const message = decoded.message
  if (message.type === "start") {
    identity = {
      version: SessionWorkerProtocol.VERSION,
      sessionID: message.sessionID,
      attemptID: mode === "stale" ? `${message.attemptID}_stale` : message.attemptID,
      generation: message.generation,
    }
    if (mode === "unready") {
      setInterval(() => undefined, 1_000)
      return
    }
    emit({ ...identity, type: "ready", workerPID: process.pid })
    if (mode === "settle") {
      emit({ ...identity, type: "settled" })
      return
    }
    if (mode === "fail") {
      emit({ ...identity, type: "failed", classification: "fixture-failure", detail: "deliberate" })
      return
    }
    if (mode === "crash") process.exit(42)
    if (mode === "signal") process.kill(process.pid, "SIGTERM")
    if (mode === "defect") {
      process.stdout.write("{not worker protocol}\n")
      return
    }
    if (mode === "late-stale") {
      emit({ ...identity, attemptID: `${identity.attemptID}_old`, type: "heartbeat", phase: "drain", at: Date.now() })
      return
    }
    if (mode === "busy") {
      // Bounded by the host heartbeat deadline. Deliberately synchronous: this is the event-loop
      // wedge a same-process Effect fiber cannot contain and a worker process must contain.
      for (;;) Math.imul(17, 19)
    }
    if (mode === "memory") {
      emit({ ...identity, type: "heartbeat", phase: "drain", at: Date.now(), rssBytes: 2_000_000 })
      return
    }
    if (mode === "child") {
      const marker = process.argv[3]
      if (!marker) process.exit(66)
      childProcess.spawn(
        process.execPath,
        [
          "-e",
          `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'leaked'), 1000); setInterval(() => {}, 1000)`,
        ],
        { stdio: "ignore", windowsHide: true },
      )
      setInterval(() => undefined, 1_000)
      return
    }
    if (mode === "publish") {
      for (const requestID of ["rpc_1", "rpc_2"])
        emit({
          ...identity,
          type: "publish-event",
          requestID,
          eventType: "session.next.synthetic",
          data: { sessionID: message.sessionID, requestID },
        })
      return
    }
    if (mode === "device" || mode === "device-batch" || mode === "device-maintenance-overlap") {
      emit({
        ...identity,
        type: "device-admit",
        requestID: "rpc_admit",
        deviceKey: "provider/model",
        sessionClass: mode === "device" ? "interactive" : "auto-prompting",
        ...(mode === "device-maintenance-overlap" ? { concurrency: 1 } : {}),
      })
      return
    }
    if (mode === "interaction") {
      emit({
        ...identity,
        type: "permission-assert",
        requestID: "rpc_permission",
        input: { sessionID: message.sessionID, action: "read", resources: ["README.md"] },
      })
      return
    }
    // A request the host can only answer by waiting on something outside this worker, issued
    // together with an ordered publication from what is, on the worker side, a different fiber.
    if (mode === "blocking-interaction") {
      emit({
        ...identity,
        type: "permission-assert",
        requestID: "rpc_permission",
        input: { sessionID: message.sessionID, action: "read", resources: ["README.md"] },
      })
      emit({
        ...identity,
        type: "publish-event",
        requestID: "rpc_publish",
        eventType: "session.next.synthetic",
        data: { sessionID: message.sessionID, requestID: "rpc_publish" },
      })
      return
    }
    if (mode === "await-parallel") {
      for (const [requestID, childID] of [
        ["rpc_wait_1", SessionSchema.ID.make("ses_worker_child_one")],
        ["rpc_wait_2", SessionSchema.ID.make("ses_worker_child_two")],
      ] as const)
        emit({
          ...identity,
          type: "await-child",
          requestID,
          input: { childID, timeoutMs: 1_000 },
        })
      return
    }
    // `silent` stays alive but sends no heartbeat. This is a non-blocking hang fixture: it exercises
    // liveness without burning CPU or allocating memory in the test environment.
    setInterval(() => undefined, 1_000)
    return
  }
  if (!identity) process.exit(65)
  if (mode === "blocking-interaction") {
    if (message.type === "permission-result") blockingPermissionAnswered = true
    if (message.type === "event-published" || message.type === "event-rejected") blockingPublishAnswered = true
    if (blockingPermissionAnswered && blockingPublishAnswered) emit({ ...identity, type: "settled" })
    return
  }
  if (message.type === "event-published") {
    acknowledgements++
    if (acknowledgements === 2) emit({ ...identity, type: "settled" })
  }
  if (message.type === "device-admitted" && deviceStage === 0) {
    deviceStage = 1
    if (mode === "device-maintenance-overlap") {
      // Deliberately ask for maintenance before returning the generation lease. With a one-slot
      // scheduler the admission must wait, while the independent release must still reach the host.
      emit({
        ...identity,
        type: "device-maintenance-admit",
        requestID: "rpc_maintenance_admit",
        deviceKey: "provider/model",
        task: "session-title",
        concurrency: 1,
      })
      emit({
        ...identity,
        type: "device-release",
        requestID: "rpc_release",
        deviceKey: "provider/model",
      })
      return
    }
    emit({
      ...identity,
      type: "device-report",
      requestID: "rpc_report",
      deviceKey: "provider/model",
      costTokens: 42,
    })
  } else if (message.type === "device-reported" && deviceStage === 1) {
    deviceStage = 2
    emit({
      ...identity,
      type: "device-release",
      requestID: "rpc_release",
      deviceKey: "provider/model",
    })
  } else if (message.type === "device-released" && deviceStage === 2) {
    emit({ ...identity, type: "settled" })
  } else if (mode === "device-maintenance-overlap" && message.type === "device-released") {
    generationReleased = true
    if (maintenanceReleased) emit({ ...identity, type: "settled" })
  } else if (mode === "device-maintenance-overlap" && message.type === "device-maintenance-admitted") {
    maintenanceID = message.maintenanceID
    emit({
      ...identity,
      type: "device-maintenance-release",
      requestID: "rpc_maintenance_release",
      deviceKey: "provider/model",
      maintenanceID,
    })
  } else if (mode === "device-maintenance-overlap" && message.type === "device-maintenance-released") {
    maintenanceReleased = true
    if (generationReleased) emit({ ...identity, type: "settled" })
  }
  if (message.type === "permission-result" && message.outcome === "allowed") {
    emit({ ...identity, type: "settled" })
  }
  if (message.type === "await-child-result") {
    joinedChildren++
    if (joinedChildren === 2) emit({ ...identity, type: "settled" })
  }
})
