import * as http from "node:http"
import * as tls from "node:tls"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { enableCompileCache } from "./compile-cache"
import { prepareSidecarEnv } from "./sidecar-env"

type NodeHttpWithEnvProxy = typeof http & {
  setGlobalProxyFromEnv: () => void
}

type NodeTlsWithSystemCertificates = typeof tls & {
  getCACertificates: (type: "default" | "system") => string[]
  setDefaultCACertificates: (certificates: string[]) => void
}

type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
}

type StopCommand = { type: "stop" }
type SidecarCommand = StartCommand | StopCommand

type SidecarMessage =
  | {
      type: "ready"
      /**
       * Where the sidecar's own startup went, in milliseconds.
       *
       * The parent can only see one number — fork to `ready` — and on the packaged build that is
       * 1,515 ms, 69% of the whole boot. Which of `fork + Node bootstrap`, `the one big import`, and
       * `building the layer graph` owns it decides whether the fix is a smaller bundle, a lazier
       * graph, or an earlier fork, and guessing wrong costs a rewrite of the wrong thing.
       */
      timings: { sinceProcessStart: number; import: number; listen: number }
    }
  | { type: "stopped" }
  | { type: "error"; error: { name?: string; message: string; stack?: string } }

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

type Listener = {
  stop(close?: boolean): void | Promise<void>
}

type ServerModule = {
  Server: {
    listen(options: {
      port: number
      hostname: string
      username: string
      password: string
      cors: string[]
    }): Promise<Listener>
  }
}

const parentPort = getParentPort()
let listener: Listener | undefined

parentPort.on("message", (event) => {
  const command = parseCommand(event.data)
  if (!command) return
  if (command.type === "stop") {
    void stop()
    return
  }
  void start(command)
})

async function start(command: StartCommand) {
  try {
    prepareSidecarEnv(command.password)
    ensureLoopbackNoProxy()
    useSystemCertificates()
    useEnvProxy()
    // Before the one big import, not after: the cache only helps the compile it precedes.
    //
    // ⚠️ The DURABLE fact is the delta, not the milliseconds: the cache saves ~18-20% of the one big
    // import, and the absolute numbers track bundle size, so they rot every time the bundle moves.
    // This comment used to read a bare "681 -> 555 ms" with no date, which is how a stale measurement
    // ends up reading as current — the shipped bundle measured 818 -> 653 ms by the time anyone
    // re-checked. Date any number you add here, or state the ratio.
    // Measured 681 -> 555 ms (undated, pre-2026-08); re-measured 818 -> 653 ms, 2026-08-18.
    // Never fatal — see compile-cache.ts.
    const cache = enableCompileCache()
    if (!cache.enabled) console.warn(`[novaclaw] compile cache off (${cache.reason}) — startup will be slower`)
    const serverURL = pathToFileURL(
      join(dirname(fileURLToPath(import.meta.url)), "server-runtime", "novaclaw-server.js"),
    ).href
    const beforeImport = performance.now()
    const { Server } = (await import(/* @vite-ignore */ serverURL)) as ServerModule

    const beforeListen = performance.now()
    listener = await Server.listen({
      port: command.port,
      hostname: command.hostname,
      username: "novaclaw",
      password: command.password,
      cors: ["nc://renderer"],
    })
    const done = performance.now()
    parentPort.postMessage({
      type: "ready",
      // `performance.now()` in a child process is measured from ITS OWN start, so `sinceProcessStart`
      // includes Electron's fork and Node's bootstrap — the part neither this process nor the parent
      // can attribute any other way. Rounded: sub-millisecond precision here is noise.
      timings: {
        sinceProcessStart: Math.round(done),
        import: Math.round(beforeListen - beforeImport),
        listen: Math.round(done - beforeListen),
      },
    })
  } catch (error) {
    // Write it to stderr as well as posting it to the parent. The parent turns this message into a
    // rejected promise that the supervisor retries, and nothing along that path ever logged the
    // REASON — so a sidecar that could not boot showed up only as `sidecar exited { code: 1 }` plus
    // a UI stuck on "awaiting server ready" forever, with an empty server.log. stderr IS piped into
    // the app's own server.log, so this guarantees the cause is always recoverable.
    console.error("[novaclaw] sidecar failed to start:", error)
    parentPort.postMessage({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}

async function stop() {
  try {
    await listener?.stop()
  } finally {
    listener = undefined
    parentPort.postMessage({ type: "stopped" })
    setImmediate(() => process.exit(0))
  }
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

function useSystemCertificates() {
  try {
    const nodeTls = tls as NodeTlsWithSystemCertificates
    nodeTls.setDefaultCACertificates([
      ...new Set([...nodeTls.getCACertificates("default"), ...nodeTls.getCACertificates("system")]),
    ])
  } catch (error) {
    console.warn("failed to load system certificates", error)
  }
}

function useEnvProxy() {
  try {
    ;(http as NodeHttpWithEnvProxy).setGlobalProxyFromEnv()
  } catch (error) {
    console.warn("failed to load proxy environment", error)
  }
}

function parseCommand(value: unknown): SidecarCommand | undefined {
  if (!value || typeof value !== "object") return
  const command = value as Partial<StartCommand | StopCommand>
  if (command.type === "stop") return { type: "stop" }
  if (command.type !== "start") return
  if (typeof command.hostname !== "string") return
  if (typeof command.port !== "number") return
  if (typeof command.password !== "string") return
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
  }
}

function serializeError(error: unknown) {
  // ⚠️ `name` travels too. The parent has to decide whether a start failure is RETRYABLE (a lost
  // port race) or terminal, and matching that on the message prose would break the moment someone
  // rewords it — a sentence is not an identifier.
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack }
  return { message: String(error) }
}

function getParentPort() {
  const port = process.parentPort as ParentPort | undefined
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}
