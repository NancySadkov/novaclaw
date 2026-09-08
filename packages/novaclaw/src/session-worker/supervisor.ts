import { Presence } from "@novaclaw/core/presence"
import { killTree, killTreeSync } from "@novaclaw/core/util/kill-tree"
import { SessionWorkerProtocol } from "@novaclaw/core/session/execution/worker-protocol"
import type { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { AbsolutePath } from "@novaclaw/core/schema"
import type { Location } from "@novaclaw/core/location"
import childProcess from "node:child_process"
import type { Readable } from "node:stream"
import * as ProtocolWrite from "./protocol-write"
import { SessionWorkerFraming } from "./protocol-framing"

export type Outcome =
  | { readonly type: "settled" }
  | { readonly type: "failed"; readonly classification: string; readonly detail?: string }
  | { readonly type: "start-timeout" }
  | { readonly type: "heartbeat-timeout" }
  | { readonly type: "memory-limit"; readonly rssBytes: number; readonly limitBytes: number }
  | { readonly type: "protocol-error"; readonly detail: string }
  | { readonly type: "stale-message" }
  | { readonly type: "exited"; readonly code: number }
  | { readonly type: "signaled"; readonly signal: NodeJS.Signals }
  | { readonly type: "interrupted" }

export interface Input {
  readonly command: readonly string[]
  readonly lease: SessionExecutionAttempt.Lease
  readonly directory: string
  readonly workspaceID?: Location.Ref["workspaceID"]
  readonly force: boolean
  readonly env?: Record<string, string | undefined>
  readonly startupTimeoutMs?: number
  readonly heartbeatTimeoutMs?: number
  readonly interruptGraceMs?: number
  readonly cleanupTimeoutMs?: number
  readonly memoryLimitBytes?: number
  readonly onMessage?: (message: SessionWorkerProtocol.WorkerMessage) => void
  readonly onHeartbeat?: (
    message: Extract<SessionWorkerProtocol.WorkerMessage, { readonly type: "heartbeat" }>,
    signal: AbortSignal,
  ) => Promise<void>
  readonly onPublishEvent?: (
    message: Extract<SessionWorkerProtocol.WorkerMessage, { readonly type: "publish-event" }>,
    signal: AbortSignal,
  ) => Promise<Extract<SessionWorkerProtocol.HostMessage, { readonly type: "event-published" | "event-rejected" }>>
  readonly onDeviceRequest?: (
    message: Extract<
      SessionWorkerProtocol.WorkerMessage,
      {
        readonly type:
          | "device-admit"
          | "device-release"
          | "device-report"
          | "device-maintenance-admit"
          | "device-maintenance-release"
          | "device-maintenance-await-preemption"
      }
    >,
    signal: AbortSignal,
  ) => Promise<
    Extract<
      SessionWorkerProtocol.HostMessage,
      {
        readonly type:
          | "device-admitted"
          | "device-released"
          | "device-reported"
          | "device-maintenance-admitted"
          | "device-maintenance-released"
          | "device-maintenance-preempted"
          | "device-rejected"
      }
    >
  >
  readonly onInteractionRequest?: (
    message: Extract<
      SessionWorkerProtocol.WorkerMessage,
      { readonly type: "permission-assert" | "spawn-child" | "await-child" | "colleague-request" }
    >,
    signal: AbortSignal,
  ) => Promise<
    Extract<
      SessionWorkerProtocol.HostMessage,
      {
        readonly type: "permission-result" | "spawn-result" | "await-child-result" | "colleague-result"
      }
    >
  >
  readonly onMemoryRequest?: (
    message: Extract<SessionWorkerProtocol.WorkerMessage, { readonly type: "memory-request" }>,
    signal: AbortSignal,
  ) => Promise<Extract<SessionWorkerProtocol.HostMessage, { readonly type: "memory-result" }>>
  readonly onWorldMemoryRequest?: (
    message: Extract<SessionWorkerProtocol.WorkerMessage, { readonly type: "memory-request" }>,
    signal: AbortSignal,
  ) => Promise<Extract<SessionWorkerProtocol.HostMessage, { readonly type: "memory-result" }>>
  readonly onLocalModelRequest?: (
    message: Extract<SessionWorkerProtocol.WorkerMessage, { readonly type: "local-model-request" }>,
    signal: AbortSignal,
  ) => Promise<Extract<SessionWorkerProtocol.HostMessage, { readonly type: "local-model-result" }>>
  readonly onDriveStateRequest?: (
    message: Extract<SessionWorkerProtocol.WorkerMessage, { readonly type: "drive-state-request" }>,
    signal: AbortSignal,
  ) => Promise<Extract<SessionWorkerProtocol.HostMessage, { readonly type: "drive-state-result" }>>
  readonly onExecutionRequest?: (
    message: SessionWorkerProtocol.ExecutionRequest,
    signal: AbortSignal,
  ) => Promise<Extract<SessionWorkerProtocol.HostMessage, { readonly type: "execution-result" }>>
  readonly onExit?: (outcome: Outcome) => Promise<void>
}

export interface Handle {
  readonly pid: number
  readonly result: Promise<Outcome>
  readonly interrupt: () => Promise<Outcome>
  readonly send: (message: SessionWorkerProtocol.HostMessage) => void
}

const STARTUP_TIMEOUT_MS = 15_000
const HEARTBEAT_TIMEOUT_MS = 15_000
const INTERRUPT_GRACE_MS = 2_000
const CLEANUP_TIMEOUT_MS = 2_000
const MONITOR_INTERVAL_MS = 100
const activePIDs = new Set<number>()

/** Process-count diagnostic and a testable lazy-lifetime invariant: an idle session owns no worker. */
export const activeWorkerCount = () => activePIDs.size

let reaperInstalled = false

/**
 * 🔴 **Do not spawn what you will not reap — including when the thing that spawned it is what dies.**
 *
 * A session worker is a raw `child_process.spawn` that holds a SQLite connection to the live instance
 * database and owns a tool-subprocess tree of its own. `finish` tree-kills it on every terminal path
 * the supervisor can see; nothing saw the case where the SUPERVISOR's own process goes away first.
 * `serve` under supervision is covered by accident — `cli/cmd/serve.ts` `killTreeSync`s the inner
 * server and `taskkill /t` reaches its worker children — but `serve --no-supervise` exits through the
 * `process.exit()` in `src/index.ts`'s `finally`, and a fatal in the server process exits the same
 * way. Both left every live worker running, which is AGENTS.md pitfall #8 with the instance database
 * still open.
 *
 * `killTreeSync` is the right twin here and not a shortcut: an `exit` hook cannot await, and an async
 * `taskkill` spawned from one is not guaranteed to outlive the process that spawned it
 * (`core/src/util/kill-tree.ts`).
 *
 * ⚠️ Installed on FIRST SPAWN, not at import: importing this module must stay free of process-wide
 * side effects, and a process that never started a worker has nothing to reap.
 *
 * ⚠️ What this does NOT cover, deliberately. `SIGKILL`, a Windows `TerminateProcess`, and a `SIGTERM`
 * that no listener handles all bypass `exit` hooks — no in-process hook can cover those, which is why
 * the layer above still tree-kills rather than trusting this one. Registering our own `SIGINT`/
 * `SIGTERM` listeners is NOT the answer: a listener suppresses Node's default termination, so a
 * module that merely gets imported would silently change what Ctrl-C does to every CLI command.
 *
 * ⚠️ **Which hosts this actually rescues, measured 2026-09-02 on win32.** Under **Bun** a
 * non-`detached` child joins a job object that Windows tears down with the parent, so a bun-hosted
 * server's workers were already dying on their own there — the same probe with `detached: true`
 * outlived its parent, which is what identifies the job object as the reason. That is a property of
 * one runtime on one platform: **Node** (the desktop sidecar is an Electron `utilityProcess`, i.e.
 * node) creates no such job, and no POSIX host has one at all. So the hole is real everywhere except
 * the one configuration that happens to be the easiest to test from.
 */
export const reapActiveWorkers = () => {
  for (const pid of activePIDs) killTreeSync(pid)
  activePIDs.clear()
}

const installReaper = () => {
  if (reaperInstalled) return
  reaperInstalled = true
  process.once("exit", reapActiveWorkers)
}

/** The worker messages that carry a `requestID` — i.e. the ones the host must answer. */
type RPCMessage = Extract<SessionWorkerProtocol.WorkerMessage, { readonly requestID: string }>

/**
 * 🔴 **Which worker RPCs share one serial chain — decided by a PROPERTY, not by a list of names.**
 *
 * There are two properties in play and they are not the same axis:
 *
 *  · **It writes the host's ORDERED record for this session.** `publish-event` appends to the durable
 *    event sequence and `execution-*` checkpoints the fenced attempt row; two of those overtaking one
 *    another is a transcript that reads out of order. These are local database writes — none of them
 *    can block on anything but disk.
 *  · **It can block on something OUTSIDE the worker.** `await-child` waits out its whole timeout (`tool/wait.ts` passes
 *    ten minutes). `spawn-child` and `colleague-request` reach another session. A device admission may
 *    wait for a lease this same worker is concurrently trying to release. A memory op is an
 *    independent store call. **None of these writes the ordered record.**
 *
 * The rule is that first property alone, and the second one is why getting it wrong is expensive: a
 * blocking request parked on the shared chain stalls every ordered write behind it. That is not
 * hypothetical — with the interaction group on the chain, a session's transcript stopped advancing
 * for as long as a permission dialog stayed open, and the 30 s early-title fiber
 * (`core/src/session/runner/maintenance.ts`) never got its publication out, which is precisely the
 * long turn it exists for.
 *
 * Ordering is safe to drop for everything else because the worker correlates replies by `requestID`
 * (`client.ts`), not by arrival order, and each fiber awaits its own op before issuing the next — so
 * per-caller ordering is preserved by the caller, and the scheduler, permission gate and memory store each own their own serialization.
 *
 * ⚠️ **`satisfies` is the door.** The table is exhaustive over `RPCMessage["type"]`, so a new worker
 * RPC does not compile until somebody answers "does this write the ordered record?" — the previous
 * shape, an exemption naming one message type at one dispatch site, let a new blocking request join
 * the chain by simply not being mentioned anywhere.
 */
const ORDERED_RPC = {
  "publish-event": true,
  "execution-advance": true,
  "execution-tool-dispatched": true,
  "execution-tool-settled": true,
  "execution-provider-started": true,
  "execution-provider-tool-protocol": true,
  "execution-provider-settled": true,
  "execution-provider-recovery": true,
  "execution-served-by": true,
  "execution-context-updated": true,
  "permission-assert": false,
  "spawn-child": false,
  "colleague-request": false,
  "await-child": false,
  "device-admit": false,
  "device-release": false,
  "device-report": false,
  "device-maintenance-admit": false,
  "device-maintenance-release": false,
  "device-maintenance-await-preemption": false,
  "memory-request": false,
  "local-model-request": false,
  // Ordered: a `save` must land before the `load` of the next drain, and both come from one worker
  // in sequence anyway — the chain costs nothing and rules out a reordered write.
  "drive-state-request": true,
} satisfies Record<RPCMessage["type"], boolean>

/** One child, one lease, one drain. This owns process lifetime only; event/device/interaction/execution RPC is
 * layered on top. Every terminal path tree-kills the worker so a tool subprocess cannot outlive
 * the fault domain that launched it. */
export function spawn(input: Input): Handle {
  if (input.command.length === 0) throw new Error("Session worker command is empty")
  // A missing `cwd` makes uv_spawn fail ENOENT with `path` set to the EXECUTABLE, so the raw error
  // names the interpreter as missing when the interpreter is fine and the session's folder is gone.
  // Measured 2026-08-05: same bun.exe, missing cwd -> ENOENT naming bun.exe; valid cwd -> spawns. That
  // is ruling 2's "a fault is never described falsely", and it reaches users through boot recovery,
  // which resumes abandoned input for sessions whose folder may have been deleted since. Check first
  // so the fault names the thing that is actually absent.
  // ⚠️ **Three answers, not two** (`@novaclaw/core/presence`). The check above used `existsSync`, which
  // answers `false` for `EACCES`, `EPERM`, `ELOOP` and `EIO` exactly as it does for `ENOENT` — so a
  // folder we merely could not READ produced the flat sentence "no longer exists", plus an imperative
  // to *restore* something that was very likely still sitting right there. That is ruling 2 again, one
  // step past where the comment above stopped: it moved the blame off the interpreter and onto the
  // folder, on evidence that only supported "the stat failed".
  const reading = Presence.read(input.directory)
  if (reading.answer === "absent")
    throw new Error(
      `Session working folder no longer exists: ${input.directory} — the session cannot run until it is restored or the session is pointed at another folder.`,
    )
  if (reading.answer === "unreadable")
    throw new Error(
      `${Presence.couldNotRead(input.directory, reading)}. The session cannot start until I can read that ` +
        `folder — check its permissions, or whether the drive or network share it lives on is still connected.`,
    )
  const child = childProcess.spawn(input.command[0]!, input.command.slice(1), {
    cwd: input.directory,
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...input.env } as Record<string, string>,
    windowsHide: true,
  })
  if (child.pid === undefined || child.stdin === null || child.stdout === null)
    throw new Error("Session worker process did not expose its control pipes")
  const childPID = child.pid
  activePIDs.add(childPID)
  installReaper()
  const startedAt = Date.now()
  let lastHeartbeat = startedAt
  let ready = false
  let done = false
  let interruptRequested = false
  let monitor: ReturnType<typeof setInterval> | undefined
  let resolveResult!: (outcome: Outcome) => void
  let rpcTail = Promise.resolve()
  const rpcInFlight = new Set<Promise<void>>()
  const lifetime = new AbortController()
  const result = new Promise<Outcome>((resolve) => {
    resolveResult = resolve
  })

  const finish = (outcome: Outcome) => {
    if (done) return
    done = true
    activePIDs.delete(childPID)
    lifetime.abort()
    if (monitor) clearInterval(monitor)
    // The normal terminal path can await: keep the parent-map walk and Windows taskkill off the
    // server event loop, while still holding result settlement behind the tree teardown so callers
    // never observe a finished worker whose descendants are still alive.
    // Host RPCs are part of this generation's lifetime too. Resolving the worker outcome before they
    // unwind lets the executor open the replacement lease while an old transcript write, spawn, or
    // memory mutation is still running. Geryon's old tool-label publication landed after generation
    // 2 had started through exactly that gap. Abort first (above), then join every request that was
    // already admitted; the existing cleanup deadline remains the hard bound for a broken handler.
    const cleanup = Promise.all([
      killTree(childPID),
      Promise.resolve().then(() => input.onExit?.(outcome)),
      Promise.allSettled([...rpcInFlight]),
    ])
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      deadlineTimer = setTimeout(resolve, input.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS)
    })
    void Promise.race([cleanup.catch(() => undefined), deadline]).then(() => {
      if (deadlineTimer) clearTimeout(deadlineTimer)
      resolveResult(outcome)
    })
  }

  const send = (message: SessionWorkerProtocol.HostMessage) => {
    if (done) return
    if (!SessionWorkerProtocol.owns(input.lease, message)) {
      finish({ type: "protocol-error", detail: "host attempted to send a stale worker message" })
      return
    }
    ProtocolWrite.write(child.stdin, SessionWorkerFraming.encode(SessionWorkerProtocol.encodeLine(message)), (error) =>
      finish({ type: "protocol-error", detail: `failed to write worker message: ${error.message}` }),
    )
  }

  // The callback above catches asynchronous write completion failures; Node also emits `error` on
  // the Writable. Without this listener an EPIPE is an uncaught exception in the SERVER process —
  // exactly the same class as the worker-side stdout hole, mirrored across the protocol boundary.
  ProtocolWrite.observeErrors(child.stdin, (error) =>
    finish({ type: "protocol-error", detail: `worker input pipe failed: ${error.message}` }),
  )

  /**
   * Route one worker RPC: onto the serial chain, or straight out.
   *
   * The classification is {@link ORDERED_RPC}, which is a PROPERTY of the request rather than a list
   * of the requests somebody remembered to exempt.
   */
  const dispatchRPC = (message: RPCMessage, run: () => Promise<SessionWorkerProtocol.HostMessage>) => {
    const settle = async () => {
      if (done) return
      const reply = await run()
      if (!("requestID" in reply) || reply.requestID !== message.requestID) {
        finish({ type: "protocol-error", detail: "RPC reply request id does not match" })
        return
      }
      send(reply)
    }
    const pending = (ORDERED_RPC[message.type] ? rpcTail.then(settle) : settle()).catch(() =>
      finish({ type: "protocol-error", detail: "worker RPC failed" }),
    )
    if (ORDERED_RPC[message.type]) rpcTail = pending
    rpcInFlight.add(pending)
    void pending.finally(() => rpcInFlight.delete(pending))
  }

  const accept = (message: SessionWorkerProtocol.WorkerMessage) => {
    if (done) return
    if (!SessionWorkerProtocol.owns(input.lease, message)) {
      finish({ type: "stale-message" })
      return
    }
    input.onMessage?.(message)
    switch (message.type) {
      case "ready":
        ready = true
        lastHeartbeat = Date.now()
        return
      case "heartbeat":
        if (!ready) {
          finish({ type: "protocol-error", detail: "heartbeat arrived before ready" })
          return
        }
        lastHeartbeat = Date.now()
        if (
          message.rssBytes !== undefined &&
          input.memoryLimitBytes !== undefined &&
          message.rssBytes > input.memoryLimitBytes
        ) {
          finish({ type: "memory-limit", rssBytes: message.rssBytes, limitBytes: input.memoryLimitBytes })
          return
        }
        if (input.onHeartbeat)
          void input
            .onHeartbeat(message, lifetime.signal)
            .catch(() => finish({ type: "protocol-error", detail: "failed to persist worker heartbeat" }))
        return
      case "settled":
        finish({ type: "settled" })
        return
      case "failed":
        finish({
          type: "failed",
          classification: message.classification,
          ...(message.detail === undefined ? {} : { detail: message.detail }),
        })
        return
      case "publish-event": {
        if (!ready) {
          finish({ type: "protocol-error", detail: "event publication arrived before ready" })
          return
        }
        const publish = input.onPublishEvent
        if (!publish) {
          send({
            version: SessionWorkerProtocol.VERSION,
            type: "event-rejected",
            sessionID: input.lease.sessionID,
            attemptID: input.lease.attemptID,
            generation: input.lease.generation,
            requestID: message.requestID,
            error: "event publication is unavailable",
          })
          return
        }
        // Ordered: one promise chain is the transcript ordering gate, so even when a publication
        // awaits disk the next one cannot overtake it and receive an earlier durable sequence. See
        // `ORDERED_RPC` for why nothing that can block on a human shares that chain any more.
        dispatchRPC(message, () => publish(message, lifetime.signal))
        return
      }
      case "device-admit":
      case "device-release":
      case "device-report":
      case "device-maintenance-admit":
      case "device-maintenance-release":
      case "device-maintenance-await-preemption": {
        if (!ready) {
          finish({ type: "protocol-error", detail: "device request arrived before ready" })
          return
        }
        const request = input.onDeviceRequest
        if (!request) {
          send({
            version: SessionWorkerProtocol.VERSION,
            type: "device-rejected",
            sessionID: input.lease.sessionID,
            attemptID: input.lease.attemptID,
            generation: input.lease.generation,
            requestID: message.requestID,
            error: "device arbitration is unavailable",
          })
          return
        }
        dispatchRPC(message, () => request(message, lifetime.signal))
        return
      }
      case "permission-assert":
      // Spawn rides the INTERACTION channel because it needs the same thing those two do:
      // the host's LOCATION services. `SessionSpawner` is a location node, and this is the
      // only worker->host path already resolved inside `runLocated`.
      // A colleague hand-off rides this channel for the same reason spawn does: it needs the host's
      // LOCATION services, and this is the one worker→host path already resolved inside `runLocated`.
      case "colleague-request":
      case "spawn-child": {
        if (!ready) {
          finish({ type: "protocol-error", detail: "interaction request arrived before ready" })
          return
        }
        const request = input.onInteractionRequest
        if (!request) {
          send(
            message.type === "colleague-request"
              ? {
                  version: SessionWorkerProtocol.VERSION,
                  type: "colleague-result",
                  sessionID: input.lease.sessionID,
                  attemptID: input.lease.attemptID,
                  generation: input.lease.generation,
                  requestID: message.requestID,
                  outcome: "rejected",
                }
              : message.type === "spawn-child"
                ? {
                    version: SessionWorkerProtocol.VERSION,
                    type: "spawn-result",
                    sessionID: input.lease.sessionID,
                    attemptID: input.lease.attemptID,
                    generation: input.lease.generation,
                    requestID: message.requestID,
                    outcome: "rejected",
                  }
                : {
                    version: SessionWorkerProtocol.VERSION,
                    type: "permission-result",
                    sessionID: input.lease.sessionID,
                    attemptID: input.lease.attemptID,
                    generation: input.lease.generation,
                    requestID: message.requestID,
                    outcome: "rejected",
                  },
          )
          return
        }
        dispatchRPC(message, () => request(message, lifetime.signal))
        return
      }
      case "await-child": {
        if (!ready) {
          finish({ type: "protocol-error", detail: "interaction request arrived before ready" })
          return
        }
        const request = input.onInteractionRequest
        if (!request) {
          send({
            version: SessionWorkerProtocol.VERSION,
            type: "await-child-result",
            sessionID: input.lease.sessionID,
            attemptID: input.lease.attemptID,
            generation: input.lease.generation,
            requestID: message.requestID,
            outcome: "rejected",
          })
          return
        }
        dispatchRPC(message, () => request(message, lifetime.signal))
        return
      }
      case "memory-request": {
        if (!ready) {
          finish({ type: "protocol-error", detail: "memory request arrived before ready" })
          return
        }
        const request = message.store === "world" ? input.onWorldMemoryRequest : input.onMemoryRequest
        if (!request) {
          // A host with no memory bridge answers "rejected", which the worker turns into an ordinary
          // `MemoryError` — the same degradation a disabled engine produces. It must never be silence.
          send({
            version: SessionWorkerProtocol.VERSION,
            type: "memory-result",
            store: message.store,
            sessionID: input.lease.sessionID,
            attemptID: input.lease.attemptID,
            generation: input.lease.generation,
            requestID: message.requestID,
            outcome: "rejected",
            reason: "memory is host-only and this host exposes no memory bridge",
          })
          return
        }
        dispatchRPC(message, () => request(message, lifetime.signal))
        return
      }
      case "local-model-request": {
        if (!ready) {
          finish({ type: "protocol-error", detail: "local-model request arrived before ready" })
          return
        }
        const request = input.onLocalModelRequest
        if (!request) {
          // A host with no local-model bridge answers "rejected", which the worker turns into the
          // `UnavailableError` the model resolver already handles. Never silence: a worker that
          // heard nothing would wait out the RPC and then run a turn without the model.
          send({
            version: SessionWorkerProtocol.VERSION,
            type: "local-model-result",
            sessionID: input.lease.sessionID,
            attemptID: input.lease.attemptID,
            generation: input.lease.generation,
            requestID: message.requestID,
            outcome: "rejected",
            reason: "the managed local model is host-only and this host exposes no local-model bridge",
          })
          return
        }
        dispatchRPC(message, () => request(message, lifetime.signal))
        return
      }
      case "drive-state-request": {
        if (!ready) {
          finish({ type: "protocol-error", detail: "drive-state request arrived before ready" })
          return
        }
        const request = input.onDriveStateRequest
        if (!request) {
          // A host with no drive-state bridge answers "rejected"; the worker reads `empty` on load
          // and drops the save — the exact pre-fix behaviour, now named rather than silent.
          send({
            version: SessionWorkerProtocol.VERSION,
            type: "drive-state-result",
            sessionID: input.lease.sessionID,
            attemptID: input.lease.attemptID,
            generation: input.lease.generation,
            requestID: message.requestID,
            outcome: "rejected",
            reason: "drive state is host-only and this host exposes no drive-state bridge",
          })
          return
        }
        dispatchRPC(message, () => request(message, lifetime.signal))
        return
      }
      case "execution-advance":
      case "execution-tool-dispatched":
      case "execution-tool-settled":
      case "execution-provider-started":
      case "execution-provider-tool-protocol":
      case "execution-provider-settled":
      case "execution-provider-recovery":
      case "execution-served-by":
      case "execution-context-updated": {
        if (!ready) {
          finish({ type: "protocol-error", detail: "execution request arrived before ready" })
          return
        }
        const request = input.onExecutionRequest
        if (!request) {
          send({
            version: SessionWorkerProtocol.VERSION,
            type: "execution-result",
            sessionID: input.lease.sessionID,
            attemptID: input.lease.attemptID,
            generation: input.lease.generation,
            requestID: message.requestID,
            outcome: "rejected",
            error: "execution checkpoint service is unavailable",
          })
          return
        }
        dispatchRPC(message, () => request(message, lifetime.signal))
        return
      }
    }
  }

  void readLines(child.stdout, (line) => {
    const decoded = SessionWorkerProtocol.decodeWorkerLine(line)
    if (!decoded.ok) {
      finish({ type: "protocol-error", detail: decoded.error })
      return
    }
    accept(decoded.message)
  }).catch((error) =>
    finish({
      type: "protocol-error",
      detail: `failed to read worker output: ${error instanceof Error ? error.message : String(error)}`,
    }),
  )

  child.once("exit", (code, signal) => {
    if (!done)
      finish(
        interruptRequested
          ? { type: "interrupted" }
          : signal
            ? { type: "signaled", signal }
            : { type: "exited", code: code ?? 1 },
      )
  })

  const startupTimeoutMs = input.startupTimeoutMs ?? STARTUP_TIMEOUT_MS
  const heartbeatTimeoutMs = input.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS
  monitor = setInterval(
    () => {
      const now = Date.now()
      if (!ready && now - startedAt > startupTimeoutMs) finish({ type: "start-timeout" })
      else if (ready && now - lastHeartbeat > heartbeatTimeoutMs) finish({ type: "heartbeat-timeout" })
    },
    Math.min(MONITOR_INTERVAL_MS, startupTimeoutMs, heartbeatTimeoutMs),
  )
  monitor.unref?.()

  send({
    version: SessionWorkerProtocol.VERSION,
    type: "start",
    sessionID: input.lease.sessionID,
    attemptID: input.lease.attemptID,
    generation: input.lease.generation,
    location: {
      directory: AbsolutePath.make(input.directory),
      ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }),
    },
    force: input.force,
  })

  const interrupt = async () => {
    if (done) return result
    interruptRequested = true
    send({
      version: SessionWorkerProtocol.VERSION,
      type: "interrupt",
      sessionID: input.lease.sessionID,
      attemptID: input.lease.attemptID,
      generation: input.lease.generation,
    })
    const grace = setTimeout(() => finish({ type: "interrupted" }), input.interruptGraceMs ?? INTERRUPT_GRACE_MS)
    grace.unref?.()
    const outcome = await result
    clearTimeout(grace)
    return outcome
  }

  return { pid: childPID, result, interrupt, send }
}

export async function readLines(stream: Readable, onLine: (line: string) => void) {
  for await (const line of SessionWorkerFraming.lines(stream)) onLine(line)
}
