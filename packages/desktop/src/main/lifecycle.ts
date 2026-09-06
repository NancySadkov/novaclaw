import type { ServerReadyData } from "../preload/types"

export type DesktopPhase =
  | "created"
  | "electron-ready"
  | "window-open"
  | "sidecar-spawned"
  | "sidecar-healthy"
  | "failed"
  | "quitting"
  | "stopped"

export interface InstanceOwner {
  /** Stop accepting starts synchronously; await every owned child, including a pending acquisition. */
  stop(): Promise<void>
}

export interface LocalInstanceOwner extends InstanceOwner {
  start(signal: AbortSignal): Promise<{ credentials: ServerReadyData; healthy: Promise<void> }>
}

export interface DesktopLifecyclePorts {
  electronReady(): Promise<void>
  openWindow(): void
  local: LocalInstanceOwner
  instances: readonly InstanceOwner[]
  /** Optional initialization begins behind the visible window. Its owner is already registered above. */
  afterWindow?(): void
  afterCredentials?(): void
  phase?(phase: DesktopPhase): void
  failure(error: unknown, stage: "electron" | "window" | "startup" | "health"): void
  deadline?: {
    schedule(callback: () => void, milliseconds: number): unknown
    cancel(handle: unknown): void
  }
}

export type ShutdownResult = { outcome: "settled" | "forced"; failures: readonly unknown[] }

/** Owns boot and shutdown ordering without importing Electron. Each resource has one owner,
 * registered before it can start. The renderer's initialization has one terminal result, and the
 * same closed state gates boot, late credentials, health notifications and every quit path. */
export function createDesktopLifecycle(ports: DesktopLifecyclePorts) {
  const abort = new AbortController()
  const initialization = Promise.withResolvers<ServerReadyData>()
  // IPC may subscribe after startup fails. Preserve that rejection without an unhandled-rejection
  // side effect while no renderer exists to observe it yet.
  void initialization.promise.catch(() => undefined)
  let initialized = false
  let phase: DesktopPhase = "created"
  let running: Promise<void> | undefined
  let stopping: Promise<ShutdownResult> | undefined
  const deadline = ports.deadline ?? {
    schedule: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds),
    cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  const transition = (next: DesktopPhase) => {
    phase = next
    // A diagnostic observer cannot prevent shutdown or settlement of initialization.
    try {
      ports.phase?.(next)
    } catch {}
  }
  const failInitialization = (error: unknown) => {
    if (initialized) return
    initialized = true
    initialization.reject(error)
  }
  const fail = (error: unknown, stage: "electron" | "window" | "startup" | "health") => {
    if (abort.signal.aborted) return
    if (stage !== "health") {
      failInitialization(error)
      transition("failed")
    }
    ports.failure(error, stage)
  }
  const boot = async () => {
    try {
      await ports.electronReady()
    } catch (error) {
      fail(error, "electron")
      return
    }
    if (abort.signal.aborted) return
    transition("electron-ready")
    if (abort.signal.aborted) return
    try {
      ports.openWindow()
    } catch (error) {
      fail(error, "window")
      return
    }
    if (abort.signal.aborted) return
    transition("window-open")
    try {
      if (abort.signal.aborted) return
      ports.afterWindow?.()
      const started = await ports.local.start(abort.signal)
      // A late acquisition still owns a health rejection even if quit prevents publication.
      void started.healthy.catch(() => undefined)
      // The local owner releases an acquisition that completes after stop. No late result can
      // publish credentials or reopen initialization while the app is quitting.
      if (abort.signal.aborted) return
      transition("sidecar-spawned")
      if (abort.signal.aborted) return
      if (!initialized) {
        initialized = true
        initialization.resolve(started.credentials)
        ports.afterCredentials?.()
      }
      try {
        await started.healthy
        if (!abort.signal.aborted) transition("sidecar-healthy")
      } catch (error) {
        fail(error, "health")
      }
    } catch (error) {
      fail(error, "startup")
    }
  }
  return {
    phase: () => phase,
    awaitInitialization: () => initialization.promise,
    run: () => (running ??= boot()),
    quit: (): Promise<ShutdownResult> => {
      if (stopping) return stopping
      const completion = Promise.withResolvers<ShutdownResult>()
      stopping = completion.promise
      abort.abort(new Error("NovaClaw is shutting down"))
      failInitialization(abort.signal.reason)
      transition("quitting")
      const failures: unknown[] = []
      const timer = deadline.schedule(() => completion.resolve({ outcome: "forced", failures: [...failures] }), 5_000)
      // Invoke every stop before waiting for any. A rejected or stuck local child cannot prevent
      // WSL children from being asked to stop under this same deadline.
      const stops = [...new Set([ports.local, ...ports.instances])].map(async (owner) => {
        try {
          await owner.stop()
        } catch (error) {
          failures.push(error)
        }
      })
      void Promise.all(stops).then(() => completion.resolve({ outcome: "settled", failures: [...failures] }))
      void stopping.then(() => {
        deadline.cancel(timer)
        transition("stopped")
      })
      return stopping
    },
  }
}
