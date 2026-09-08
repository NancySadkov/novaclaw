import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { Cause } from "effect"
import type { SuperviseStatus } from "@novaclaw/script/supervise"
import type { ServerReadyData } from "../preload/types"
import type { LocalInstanceOwner } from "./lifecycle"

type Started = { listener: { stop(): Promise<void> }; health: { wait: Promise<void> } }
export interface LocalInstancePorts {
  prepare(): void
  spawn(
    port: number,
    password: string,
    signal: AbortSignal,
    report: (status: SuperviseStatus) => void,
  ): Promise<Started>
  pinnedPort?: string
  probe?(signal: AbortSignal): Promise<number>
  log(message: string, metadata?: unknown): void
}

/** Owns the local instance from the start request, rather than only after a child becomes ready.
 * A late acquisition is disposed under the same stop promise and never publishes credentials. */
export function createLocalInstance(ports: LocalInstancePorts): LocalInstanceOwner & {
  state(): SuperviseStatus
  subscribe(listener: (state: SuperviseStatus) => void): () => void
} {
  const abort = new AbortController()
  const listeners = new Set<(state: SuperviseStatus) => void>()
  let status: SuperviseStatus = { phase: "running" }
  let pending: ReturnType<LocalInstanceOwner["start"]> | undefined
  let current: Started | undefined
  let stopping: Promise<void> | undefined
  let handleStop: Promise<void> | undefined
  const report = (state: SuperviseStatus) => {
    status = state
    for (const listener of listeners) {
      try {
        listener(state)
      } catch (error) {
        ports.log("supervisor state listener failed", { error: String(error) })
      }
    }
  }
  const stopHandle = () =>
    (handleStop ??= current ? Promise.resolve().then(() => current!.listener.stop()) : Promise.resolve())
  const acquire = async (signal: AbortSignal) => {
    signal.throwIfAborted()
    ports.prepare()
    signal.throwIfAborted()
    const pinned = ports.pinnedPort !== undefined && ports.pinnedPort !== ""
    const fixed = pinned ? Number(ports.pinnedPort) : undefined
    if (pinned && (!Number.isInteger(fixed) || fixed! < 1 || fixed! > 65535))
      throw new Error("NOVACLAW_PORT must be a port number from 1 to 65535")
    const password = randomUUID()
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted()
      const port = fixed ?? (await (ports.probe ?? probeLocalPort)(signal))
      signal.throwIfAborted()
      const url = `http://127.0.0.1:${port}`
      try {
        ports.log("spawning sidecar", { url })
        current = await ports.spawn(port, password, signal, (state) => {
          if (!abort.signal.aborted) report(state)
        })
        // The health promise may reject while shutdown is disposing this acquisition.
        void current.health.wait.catch(() => undefined)
        if (signal.aborted) {
          await stopHandle()
          signal.throwIfAborted()
        }
        const credentials: ServerReadyData = { url, username: "novaclaw", password }
        return { credentials, healthy: deadlineHealth(current.health.wait, signal) }
      } catch (error) {
        if (
          signal.aborted ||
          pinned ||
          !(error instanceof Error) ||
          error.name !== "PortUnavailableError" ||
          attempt === 2
        )
          throw error
        ports.log("sidecar lost the port race — re-probing")
      }
    }
    throw new Error("Local instance did not start")
  }
  return {
    state: () => status,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start: (signal) => {
      if (abort.signal.aborted) return Promise.reject(abort.signal.reason)
      return (pending ??= acquire(AbortSignal.any([signal, abort.signal])))
    },
    stop: () => {
      if (stopping) return stopping
      const completion = Promise.withResolvers<void>()
      stopping = completion.promise
      abort.abort(new Error("NovaClaw is shutting down"))
      report({ phase: "stopped" })
      void (async () => {
        await pending?.catch(() => undefined)
        await stopHandle()
      })().then(completion.resolve, completion.reject)
      return stopping
    },
  }
}

function deadlineHealth(healthy: Promise<void>, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout>
  let interrupted: () => void
  const bounded = new Promise<void>((resolve, reject) => {
    interrupted = () => reject(signal.reason)
    signal.addEventListener("abort", interrupted, { once: true })
    timer = setTimeout(
      () => reject(new Cause.TimeoutError("The local server did not pass its health check in time")),
      30_000,
    )
    healthy.then(resolve, reject)
  })
  return bounded.finally(() => {
    clearTimeout(timer)
    signal.removeEventListener("abort", interrupted)
  })
}

export function probeLocalPort(signal: AbortSignal): Promise<number> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const server = createServer()
    let done = false
    const finish = (error?: unknown, port?: number) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal.removeEventListener("abort", interrupted)
      try {
        server.close()
      } catch {}
      if (error !== undefined) reject(error)
      else resolve(port!)
    }
    const interrupted = () => finish(signal.reason)
    const timer = setTimeout(
      () => finish(new Cause.TimeoutError("Could not choose a local port within 10 seconds")),
      10_000,
    )
    signal.addEventListener("abort", interrupted, { once: true })
    server.on("error", (error) => finish(error))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return finish(new Error("Could not choose a local port"))
      server.close((error) => finish(error, address.port))
    })
  })
}
