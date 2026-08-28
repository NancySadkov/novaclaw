import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { app, utilityProcess } from "electron"
import type { Details } from "electron"
import { getLogger } from "./logging"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"
import { DEFAULT_SERVER_URL_KEY } from "./store-keys"
import {
  initialSuperviseState,
  livenessDecision,
  superviseDecision,
  FAST_CRASH_GIVEUP,
  LIVENESS_FAILURE_LIMIT,
  type StopReason,
  type SuperviseStatus,
} from "@novaclaw/script/supervise"

export type HealthCheck = { wait: Promise<void> }

type SidecarMessage =
  | { type: "ready"; timings?: { sinceProcessStart: number; import: number; listen: number } }
  | { type: "stopped" }
  | { type: "error"; error: { name?: string; message: string; stack?: string } }

export type SidecarListener = { stop: () => Promise<void> }

const SIDECAR_SERVICE_NAME = "novaclaw server"
const SIDECAR_START_STALL_TIMEOUT = 60_000
const SIDECAR_STOP_TIMEOUT = 6_000
const SIDECAR_LIVENESS_INTERVAL = 2_000

type SpawnLocalServerOptions = {
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onExit?: (code: number) => void
}

type SuperviseLocalServerOptions = SpawnLocalServerOptions & {
  /**
   * Every supervisor state transition, for the surfaces a person actually looks at.
   *
   * ⚠️ Log lines are NOT this. `note()` writes `[supervise] …` into server.log, which is where the
   * give-up used to end its life: the renderer's banner went on saying *"Still trying. Your work is
   * safe; this clears by itself once the instance is back"* while the ladder had permanently
   * stopped, so the one message the user could see was false exactly when it mattered. A bounded
   * policy needs a reported terminal state or the bound is invisible.
   */
  onState?: (state: SuperviseStatus) => void
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
  // XDG_STATE_HOME used to be the odd one out: production desktop forced it to Electron's private
  // userData directory while leaving XDG_DATA_HOME on the shared, documented home-directory layout.
  // That split the credential key (state) from auth.json (data), so desktop and CLI encrypted the SAME
  // auth file with DIFFERENT keys. Keep all four homes under one rule: an unset variable stays unset in
  // production, while an isolated dev build redirects the complete instance together.
  const env: Record<string, string> = {
    ...(shell ? loadShellEnv(shell, getLogger()) : null),
    NOVACLAW_EXPERIMENTAL_ICON_DISCOVERY: "true",
    NOVACLAW_EXPERIMENTAL_FILEWATCHER: "true",
    NOVACLAW_CLIENT: "desktop",
  }
  for (const [key, value] of [
    ["XDG_DATA_HOME", process.env.XDG_DATA_HOME ?? defaultData],
    ["XDG_CONFIG_HOME", process.env.XDG_CONFIG_HOME ?? defaultData],
    ["XDG_CACHE_HOME", process.env.XDG_CACHE_HOME ?? defaultData],
    ["XDG_STATE_HOME", process.env.XDG_STATE_HOME ?? defaultData],
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
        // ⚠️ Surfaced through the SAME stdout channel the app already writes to its log, rather than
        // a new one: the parent's own boot timeline can only see fork-to-ready as a single number,
        // and this is the only place the three parts of it exist. Optional on the type because a WSL
        // sidecar answers the same protocol from an older build.
        if (message.timings)
          options.onStdout?.(
            `sidecar ready sinceProcessStart=${message.timings.sinceProcessStart}ms ` +
              `import=${message.timings.import}ms listen=${message.timings.listen}ms`,
          )
        resolve()
        return
      }
      if (message.type === "error") {
        fail(
          Object.assign(new Error(message.error.message), {
            stack: message.error.stack,
            // Preserved so the boot path can tell a lost port race from a broken sidecar.
            ...(message.error.name === undefined ? {} : { name: message.error.name }),
          }),
        )
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
      // Fault recovery, not a user shutdown: do not send an IPC stop request to a child whose event
      // loop has stopped answering. The supervisor observes the resulting exit and respawns it.
      terminate: () => {
        if (!exited) child.kill()
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
  options: SuperviseLocalServerOptions,
): Promise<{ listener: SidecarListener; health: HealthCheck }> {
  let stopping = false
  let state = initialSuperviseState
  let startedAt = Date.now()
  let current: Awaited<ReturnType<typeof spawnLocalServer>> | undefined
  let respawnTimer: NodeJS.Timeout | undefined
  let monitorTimer: NodeJS.Timeout | undefined
  let monitorEpoch = 0
  let livenessFailures = 0
  let unresponsive = false
  let attempts = 0
  // The reason the CURRENT child is going away, latched where the decision is made rather than read
  // off an exit code afterwards — see StopReason. `stopping` remains the authority on intent; this
  // only says which flavour of fault an unintended stop was, for the message the user reads.
  let reason: Exclude<StopReason, "intentional"> = "crash"
  const note = (message: string) => options.onStderr?.(`[supervise] ${message}`)
  const report = (next: SuperviseStatus) => {
    try {
      options.onState?.(next)
    } catch {
      // A reporting surface must never be able to break recovery. Losing one status update is a
      // stale banner; throwing here would abandon the restart itself.
    }
  }

  const stopMonitor = () => {
    monitorEpoch++
    if (monitorTimer) clearTimeout(monitorTimer)
    monitorTimer = undefined
    livenessFailures = 0
  }

  const startMonitor = (handle: Awaited<ReturnType<typeof spawnLocalServer>>) => {
    stopMonitor()
    const epoch = monitorEpoch
    const probe = async () => {
      if (stopping || current !== handle || epoch !== monitorEpoch) return
      const decision = livenessDecision(livenessFailures, await checkHealth(`http://${hostname}:${port}`, password))
      if (stopping || current !== handle || epoch !== monitorEpoch) return
      livenessFailures = decision.failures
      if (decision.action === "restart") {
        unresponsive = true
        reason = "unresponsive"
        stopMonitor()
        note(`sidecar missed ${LIVENESS_FAILURE_LIMIT} health checks — terminating the hung process`)
        handle.listener.terminate()
        return
      }
      monitorTimer = setTimeout(() => void probe(), SIDECAR_LIVENESS_INTERVAL)
    }
    void handle.health.wait
      .then(() => {
        if (!stopping && current === handle && epoch === monitorEpoch)
          monitorTimer = setTimeout(() => void probe(), SIDECAR_LIVENESS_INTERVAL)
      })
      .catch(() => undefined) // the exit/respawn path owns failed startup health
  }

  const spawnOnce = async () => {
    let readySeen = false
    unresponsive = false
    reason = "crash"
    startedAt = Date.now()
    const handle = await spawnLocalServer(hostname, port, password, {
      ...options,
      onExit: (code) => {
        options.onExit?.(code)
        // Pre-ready exits reject spawnOnce's await and are counted by the caller — only a child
        // that made it past ready is handled here (readySeen is set before any later event fires).
        // `stopping` is the proof of an intentional shutdown. Any exit observed here—including 0—
        // is unexpected and must heal; otherwise a buggy clean exit silently leaves a dead port.
        if (readySeen && !stopping) onChildGone(unresponsive || code === 0 ? 1 : code)
      },
    })
    readySeen = true
    return handle
  }

  const onChildGone = (code: number) => {
    stopMonitor()
    const decision = superviseDecision(state, { code, aliveMs: Date.now() - startedAt })
    if (decision.action === "stop-clean") {
      note("sidecar exited cleanly — not restarting")
      report({ phase: "stopped" })
      return
    }
    if (decision.action === "giveup") {
      note(
        `crash loop: ${FAST_CRASH_GIVEUP} consecutive fast exits — giving up; the connection banner will show the outage`,
      )
      report({ phase: "gave-up", reason, attempts })
      return
    }
    attempts++
    note(`sidecar exited (code ${code}) — restarting in ${decision.delayMs / 1000}s`)
    report({ phase: "restarting", reason, attempt: attempts, nextAttemptInMs: decision.delayMs })
    state = decision.next
    respawnTimer = setTimeout(() => void respawn(), decision.delayMs)
  }

  const respawn = async () => {
    if (stopping) return
    try {
      current = await spawnOnce()
      // ⚠️ The intent latch can flip DURING the await above (a quit racing a respawn). Without this
      // the supervisor would announce a healthy server nobody is going to stop and leave the UI
      // reporting "running" through a shutdown.
      if (stopping) {
        await current.listener.stop().catch(() => undefined)
        report({ phase: "stopped" })
        return
      }
      note("sidecar respawned")
      report({ phase: "running" })
      startMonitor(current)
      // Respawned children aren't awaited by boot code — surface a failed health gate in the log.
      current.health.wait.catch((error: unknown) => note(`respawned sidecar health check failed: ${String(error)}`))
    } catch (error) {
      if (stopping) return
      note(`respawn failed before ready: ${error instanceof Error ? error.message : String(error)}`)
      reason = "start-failed"
      onChildGone(1)
    }
  }

  /**
   * 🔴 **NC-REL-012 — the FIRST spawn had no supervision at all.** Every later failure goes through
   * `respawn`'s guarded path and the `superviseDecision` ladder; this call sat outside it, and the
   * comment that used to be here said so plainly: *"first boot failures throw to the caller, exactly
   * as before"*. So an error, a pre-ready exit, or the 60-second readiness stall killed the child and
   * rejected — and nothing restarted it. The one call the user actually waits on was the one with no
   * self-healing, in a product whose whole premise is that *"our users are not server admins"*.
   *
   * ⚠️ The caller's retry does not cover this. `index.ts` wraps it in
   * `Effect.retry({ while: isPortRace, … })` — a port race heals, everything else propagates.
   *
   * ⚠️ **Only FAST failures are retried, and that bound is the point.** A pre-ready exit in the first
   * couple of seconds is the racy, transient shape worth another go. The 60-second stall is not: it
   * means something is genuinely wrong, and retrying it on the crash ladder would turn a prompt,
   * named boot error into minutes of a blank window — the opposite of the dependability this is for.
   * A stall still throws immediately, exactly as before.
   *
   * ⚠️ It still THROWS when it gives up, so the caller's contract is unchanged: boot either returns a
   * live server or reports a named error. What changed is that a transient first failure no longer
   * ends the app's startup.
   */
  const FIRST_BOOT_FAST_MS = 10_000
  const firstSpawn = async () => {
    for (;;) {
      const attemptedAt = Date.now()
      try {
        return await spawnOnce()
      } catch (error) {
        const aliveMs = Date.now() - attemptedAt
        if (stopping || aliveMs >= FIRST_BOOT_FAST_MS) throw error
        reason = "start-failed"
        const decision = superviseDecision(state, { code: 1, aliveMs })
        if (decision.action !== "restart") {
          report({ phase: "gave-up", reason, attempts })
          throw error
        }
        attempts++
        note(`sidecar failed before ready — retrying in ${decision.delayMs / 1000}s`)
        report({ phase: "restarting", reason, attempt: attempts, nextAttemptInMs: decision.delayMs })
        state = decision.next
        await new Promise((resolve) => setTimeout(resolve, decision.delayMs))
        if (stopping) throw error
      }
    }
  }
  current = await firstSpawn()
  startMonitor(current)
  report({ phase: "running" })
  return {
    listener: {
      stop: () => {
        // The intent latch, and the ONLY place it is set. Everything downstream reads it rather
        // than guessing from an exit code.
        stopping = true
        stopMonitor()
        if (respawnTimer) clearTimeout(respawnTimer)
        report({ phase: "stopped" })
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
  if (process.platform === "win32" && app.isPackaged) {
    env.NOVACLAW_W64DEVKIT_PATH = join(process.resourcesPath, "third-party", "w64devkit")
    // The embedded `magick` (owner, 2026-08-23). Same shape and the same reason as the line above:
    // `shell.ts` puts it on the agent's PATH, and without this the binary ships and is unreachable —
    // a capability that exists on disk and not in the product.
    env.NOVACLAW_IMAGEMAGICK_PATH = join(process.resourcesPath, "third-party", "imagemagick")
  }
  return env
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack }
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
