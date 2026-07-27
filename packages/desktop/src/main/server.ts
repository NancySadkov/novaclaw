import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { app, utilityProcess } from "electron"
import type { Details } from "electron"
import { getLogger } from "./logging"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"
import { DEFAULT_SERVER_URL_KEY } from "./store-keys"
import { initialSuperviseState, superviseDecision, FAST_CRASH_GIVEUP } from "./supervise-policy"

export type HealthCheck = { wait: Promise<void> }

type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

export type SidecarListener = { stop: () => Promise<void> }

const SIDECAR_SERVICE_NAME = "novaclaw server"
const SIDECAR_START_STALL_TIMEOUT = 60_000
const SIDECAR_STOP_TIMEOUT = 6_000

type SpawnLocalServerOptions = {
  userDataPath: string
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onExit?: (code: number) => void
}

export function getDefaultServerUrl(): string | null {
  const value = getStore().get(DEFAULT_SERVER_URL_KEY)
  return typeof value === "string" ? value : null
}

export function setDefaultServerUrl(url: string | null) {
  if (url) {
    getStore().set(DEFAULT_SERVER_URL_KEY, url)
    return
  }

  getStore().delete(DEFAULT_SERVER_URL_KEY)
}

export function preferAppEnv(userDataPath: string) {
  const shell = process.platform === "win32" ? null : getUserShell()
  // jh fork: isolate dev builds from production novaclaw installs.
  // When NOVACLAW_DEV_ISOLATED is set, all XDG paths redirect to userDataPath
  // so the dev app never touches %APPDATA%/novaclaw/ (shared with CLI).
  const defaultData = process.env.NOVACLAW_DEV_ISOLATED ? userDataPath : undefined

  // ⚠️ THIS IS WHERE v0.1.0's FIRST-RUN FAILURE CAME FROM. `Object.assign(process.env, {K: undefined})`
  // does NOT skip the key — Node coerces env values to strings, so it writes the literal text
  // "undefined". Outside dev-isolated mode `defaultData` IS undefined, so XDG_DATA_HOME,
  // XDG_CONFIG_HOME and XDG_CACHE_HOME each became the string "undefined". The server then read them
  // as real values (they are non-empty, so every `??`/`||` fallback was skipped) and resolved its data
  // directory to "undefined\novaclaw" and its scratch dir to "undefined\novaclaw\scratch". Clicking the
  // home prompt bar created a session at that path and answered 500.
  //
  // XDG_STATE_HOME was the one that worked, and only by luck: it has a third fallback that is always a
  // real string. So assign ONLY the keys that have a value — an unset variable must stay unset, which is
  // what lets the server fall back to the documented `$HOME/.local/share` layout.
  const env: Record<string, string> = {
    ...(shell ? loadShellEnv(shell, getLogger()) : null),
    NOVACLAW_EXPERIMENTAL_ICON_DISCOVERY: "true",
    NOVACLAW_EXPERIMENTAL_FILEWATCHER: "true",
    NOVACLAW_CLIENT: "desktop",
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? defaultData ?? userDataPath,
  }
  for (const [key, value] of [
    ["XDG_DATA_HOME", process.env.XDG_DATA_HOME ?? defaultData],
    ["XDG_CONFIG_HOME", process.env.XDG_CONFIG_HOME ?? defaultData],
    ["XDG_CACHE_HOME", process.env.XDG_CACHE_HOME ?? defaultData],
  ] as const)
    if (value !== undefined) env[key] = value

  Object.assign(process.env, env)
}

export async function spawnLocalServer(
  hostname: string,
  port: number,
  password: string,
  options: SpawnLocalServerOptions,
) {
  const sidecar = join(dirname(fileURLToPath(import.meta.url)), "sidecar.js")
  const child = utilityProcess.fork(sidecar, [], {
    cwd: process.cwd(),
    env: createSidecarEnv(),
    serviceName: SIDECAR_SERVICE_NAME,
    stdio: "pipe",
    // The sidecar's server bundle uses `node:sqlite` (the Node variant of the core's `#sqlite`).
    // On Node 22.5–22.12 that requires `--experimental-sqlite`; on 22.13+/24 the flag is a no-op
    // (accepted, just an ExperimentalWarning). Pass it unconditionally so the sidecar boots on
    // whatever Node the installed Electron bundles.
    execArgv: ["--experimental-sqlite"],
  })
  let exited = false
  const exit = defer<number>()

  const onProcessGone = (_event: unknown, details: Details) => {
    if (details.type !== "Utility" || details.name !== SIDECAR_SERVICE_NAME) return
    options.onStderr?.(`utility process gone reason=${details.reason} exitCode=${details.exitCode}`)
  }

  app.on("child-process-gone", onProcessGone)
  child.once("exit", (code) => {
    exited = true
    app.off("child-process-gone", onProcessGone)
    options.onExit?.(code)
    exit.resolve(code)
  })
  child.on("error", (error) => options.onStderr?.(`utility process error: ${serializeError(error).message}`))

  child.stdout?.on("data", (chunk: Buffer) => options.onStdout?.(chunk.toString("utf8").trimEnd()))
  child.stderr?.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8").trimEnd()))

  await new Promise<void>((resolve, reject) => {
    let done = false
    let timeout: NodeJS.Timeout

    const fail = (error: Error) => {
      if (done) return
      done = true
      cleanup()
      reject(error)
    }

    const refreshTimeout = () => {
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        fail(new Error(`Sidecar did not become ready within ${SIDECAR_START_STALL_TIMEOUT}ms: ${sidecar}`))
      }, SIDECAR_START_STALL_TIMEOUT)
    }

    const onMessage = (message: SidecarMessage) => {
      if (message.type === "ready") {
        if (done) return
        done = true
        cleanup()
        resolve()
        return
      }
      if (message.type === "error") {
        fail(Object.assign(new Error(message.error.message), { stack: message.error.stack }))
      }
    }
    const onExit = (code: number) => {
      fail(new Error(`Sidecar exited before ready with code ${code}`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.off("message", onMessage)
      child.off("exit", onExit)
    }

    child.on("message", onMessage)
    child.on("exit", onExit)
    refreshTimeout()
    child.postMessage({
      type: "start",
      hostname,
      port,
      password,
      userDataPath: options.userDataPath,
    })
  }).catch((error) => {
    if (!exited) child.kill()
    throw error
  })

  const wait = (async () => {
    const url = `http://${hostname}:${port}`
    let healthy = false
    const gone = exit.promise.then((code) => {
      if (healthy) return
      throw new Error(`Sidecar exited before health check passed with code ${code}`)
    })

    const ready = async () => {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (await checkHealth(url, password)) {
          healthy = true
          return
        }
      }
    }

    await Promise.race([ready(), gone])
  })()

  let stopping: Promise<void> | undefined

  return {
    listener: {
      stop: () => {
        if (stopping) return stopping
        if (exited) return Promise.resolve()
        child.postMessage({ type: "stop" })
        stopping = Promise.race([
          exit.promise.then(() => undefined),
          delay(SIDECAR_STOP_TIMEOUT).then(() => {
            if (!exited) child.kill()
          }),
        ])
        return stopping
      },
    },
    health: { wait },
  }
}

// Dependability P3 (uix-dependability-plan): the sidecar SUPERVISOR — "the instance heals itself".
// Wraps spawnLocalServer: a child that exits after becoming ready (a crash, an OOM kill) is
// respawned with backoff; a crash loop gives up gracefully (the renderer's P2 banner reports the
// outage — never a dead dialog). An intentional stop (updater/app-quit via listener.stop) sets the
// `stopping` latch so the respawner never fights a shutdown. Each respawn goes through
// spawnLocalServer itself, so every child gets FRESH exit/health plumbing. The returned shape is
// spawnLocalServer's own — callers hold ONE stable listener whose stop() always targets the live
// child, and the first child's health gate (the boot contract) is preserved.
export async function superviseLocalServer(
  hostname: string,
  port: number,
  password: string,
  options: SpawnLocalServerOptions,
): Promise<{ listener: SidecarListener; health: HealthCheck }> {
  let stopping = false
  let state = initialSuperviseState
  let startedAt = Date.now()
  let current: Awaited<ReturnType<typeof spawnLocalServer>> | undefined
  let respawnTimer: NodeJS.Timeout | undefined
  const note = (message: string) => options.onStderr?.(`[supervise] ${message}`)

  const spawnOnce = async () => {
    let readySeen = false
    startedAt = Date.now()
    const handle = await spawnLocalServer(hostname, port, password, {
      ...options,
      onExit: (code) => {
        options.onExit?.(code)
        // Pre-ready exits reject spawnOnce's await and are counted by the caller — only a child
        // that made it past ready is handled here (readySeen is set before any later event fires).
        if (readySeen && !stopping) onChildGone(code)
      },
    })
    readySeen = true
    return handle
  }

  const onChildGone = (code: number) => {
    const decision = superviseDecision(state, { code, aliveMs: Date.now() - startedAt })
    if (decision.action === "stop-clean") {
      note("sidecar exited cleanly — not restarting")
      return
    }
    if (decision.action === "giveup") {
      note(`crash loop: ${FAST_CRASH_GIVEUP} consecutive fast exits — giving up; the connection banner will show the outage`)
      return
    }
    note(`sidecar exited (code ${code}) — restarting in ${decision.delayMs / 1000}s`)
    state = decision.next
    respawnTimer = setTimeout(() => void respawn(), decision.delayMs)
  }

  const respawn = async () => {
    if (stopping) return
    try {
      current = await spawnOnce()
      note("sidecar respawned")
      // Respawned children aren't awaited by boot code — surface a failed health gate in the log.
      current.health.wait.catch((error: unknown) => note(`respawned sidecar health check failed: ${String(error)}`))
    } catch (error) {
      if (stopping) return
      note(`respawn failed before ready: ${error instanceof Error ? error.message : String(error)}`)
      onChildGone(1)
    }
  }

  current = await spawnOnce() // first boot failures throw to the caller, exactly as before
  return {
    listener: {
      stop: () => {
        stopping = true
        if (respawnTimer) clearTimeout(respawnTimer)
        return current ? current.listener.stop() : Promise.resolve()
      },
    },
    health: current.health,
  }
}

// Dependability P6: is the machine airgapped? Asks the sidecar's offline-status route (the same
// source the N/9 Settings indicator reads — never re-derive the policy here). Used to force the
// updater's polling OFF on an airgapped machine; false on any failure (a dead sidecar must not
// block updates for a machine that is actually online).
export async function checkOfflineEnabled(url: string, password: string, directory: string): Promise<boolean> {
  try {
    const target = new URL("/shell/offline", url)
    target.searchParams.set("directory", directory)
    const auth = Buffer.from(`novaclaw:${password}`).toString("base64")
    const res = await fetch(target, {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return false
    const status = (await res.json()) as { enabled?: boolean }
    return status.enabled === true
  } catch {
    return false
  }
}

export async function checkHealth(url: string, password?: string | null): Promise<boolean> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }

  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`novaclaw:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

function createSidecarEnv(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
  )
  delete env.DEBUG
  if (process.platform === "linux") delete env.LD_PRELOAD
  if (!app.isPackaged) env.NOVACLAW_DISABLE_CHANNEL_DB = "1"
  return env
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
