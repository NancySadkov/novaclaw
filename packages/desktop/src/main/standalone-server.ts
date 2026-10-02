import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { statSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "electron"
import { ServerToken } from "@novaclaw/core/server-token"
import { killTreeSync } from "@novaclaw/core/util/kill-tree"
import type { SuperviseStatus } from "@novaclaw/script/supervise"
import type { ServerReadyData } from "../preload/types"
import type { DesktopLaunchOptions } from "./desktop-cli"
import { pollUntilHealthy } from "./health-poll"
import { serviceHomeArgs, type ServiceInstancePaths } from "./instance-home-path"
import { probeLocalPort } from "./local-instance"
import type { LocalInstanceOwner } from "./lifecycle"
import { write as writeLog } from "./logging"
import { checkHealth, createLocalServerEnvironment } from "./server"

const START_TIMEOUT_MS = 60_000
const STOP_TIMEOUT_MS = 8_000
const HEALTH_INTERVAL_MS = 100

/**
 * The standalone headless server, run as an ordinary child process.
 *
 * This is the fully-separated server from `packages/novaclaw`: the compiled `novaclaw` binary runs
 * `serve` under a plain Node/Bun runtime, with no Electron and no Chromium anywhere in its process
 * tree. It is already supervised and already settles its instances on the way out, so this owner
 * delegates recovery to it and keeps only what the desktop owns: locating the binary, resolving the
 * one credential, discovering whether a retained server is already up, and stopping the tree.
 *
 * The Electron sidecar owner in `desktop-service.ts` stays as the fallback for development builds,
 * where the compiled binary has not been staged.
 */
export function bundledServerBinary(): string | undefined {
  const override = process.env.NOVACLAW_SERVER_BINARY
  if (!override && !app.isPackaged) return undefined
  const binary = override ?? join(process.resourcesPath, "server", serverExecutableName())
  if (!statSync(binary, { throwIfNoEntry: false })?.isFile())
    throw new Error(`NovaClaw's bundled server is missing or incomplete: ${binary}. Restore the NovaClaw distribution.`)
  return binary
}

function serverExecutableName() {
  return process.platform === "win32" ? "novaclaw.exe" : "novaclaw"
}

type StandaloneDescriptor = {
  readonly id: string
  readonly port: number
  readonly hostname: string
  readonly username: string
  readonly password: string
  readonly pid: number
}

function descriptorPath(instanceRoot: string) {
  return join(instanceRoot, "standalone-server.json")
}

function readDescriptor(instanceRoot: string): StandaloneDescriptor | undefined {
  try {
    const parsed = JSON.parse(readFileSync(descriptorPath(instanceRoot), "utf8")) as Partial<StandaloneDescriptor>
    if (
      typeof parsed.id === "string" &&
      Number.isInteger(parsed.port) &&
      parsed.port! > 0 &&
      typeof parsed.hostname === "string" &&
      typeof parsed.username === "string" &&
      typeof parsed.password === "string" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid! > 0
    )
      return parsed as StandaloneDescriptor
  } catch {}
  return undefined
}

function writeDescriptor(instanceRoot: string, descriptor: StandaloneDescriptor) {
  const target = descriptorPath(instanceRoot)
  writeFileSync(`${target}.tmp`, JSON.stringify(descriptor))
  renameSync(`${target}.tmp`, target)
}

function clearDescriptor(instanceRoot: string, id: string) {
  if (readDescriptor(instanceRoot)?.id !== id) return
  try {
    rmSync(descriptorPath(instanceRoot), { force: true })
  } catch {}
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function loopbackUrl(hostname: string, port: number) {
  const host = hostname === "0.0.0.0" || hostname === "::" || hostname === "[::]" ? "127.0.0.1" : hostname
  const shown = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
  return `http://${shown}:${port}`
}

/** `POST /global/dispose` — the child's own settle path, reachable over HTTP so it runs on Windows,
 *  where a kill is `TerminateProcess` and no signal handler ever fires. Mirrors the CLI supervisor. */
async function disposeRemote(url: string, password: string): Promise<boolean> {
  try {
    const headers = new Headers()
    headers.set("authorization", `Basic ${Buffer.from(`novaclaw:${password}`).toString("base64")}`)
    const response = await fetch(`${url}/global/dispose`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(STOP_TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}

export type StandaloneLaunch = {
  readonly command: string
  readonly args: (port: number, password: string) => string[]
}

export function createStandaloneServer(
  instance: ServiceInstancePaths,
  options: DesktopLaunchOptions["server"],
  launch?: StandaloneLaunch,
): LocalInstanceOwner & {
  state(): SuperviseStatus
  subscribe(listener: (state: SuperviseStatus) => void): () => void
  retain(): void
} {
  const databaseFile = join(instance.dataPath, "novaclaw.db")
  const listeners = new Set<(state: SuperviseStatus) => void>()
  /**
   * 🔴 `starting`, NOT `running`.
   *
   * This owner is constructed before it spawns anything, and `df1606bb1` made `start()` publish
   * credentials to the renderer at spawn — so between construction and the first health answer the
   * renderer is already asking "is my instance up?". Reporting `running` here answered yes, and the
   * gate then burned its whole 10 s budget and rendered "Could not reach Local Server" against a
   * server that was 8.7 s from healthy (packaged 0.1.81, 2026-09-28).
   */
  let status: SuperviseStatus = { phase: "starting" }
  let retained = false
  let stopped = false
  let child: ChildProcess | undefined

  const report = (next: SuperviseStatus) => {
    status = next
    for (const listener of listeners) {
      try {
        listener(next)
      } catch {}
    }
  }

  const serveArgs = (port: number, password: string) => [
    "serve",
    `--port=${port}`,
    `--hostname=${options.hostname}`,
    `--username=${options.username}`,
    `--password=${password}`,
    ...(options.maxUptime ? [`--max-uptime=${options.maxUptime}`] : []),
    ...(options.mdns ? ["--mdns", `--mdns-domain=${options.mdnsDomain}`] : []),
    ...serviceHomeArgs(instance),
  ]

  const command = launch?.command ?? bundledServerBinary()
  if (!command) throw new Error("the standalone NovaClaw server binary is not present in this build")
  const argsFor = launch?.args ?? serveArgs

  const waitHealthy = (url: string, password: string, cancelled: () => boolean) =>
    pollUntilHealthy({
      probe: () => checkHealth(url, password),
      cancelled,
      intervalMs: HEALTH_INTERVAL_MS,
      timeoutMs: START_TIMEOUT_MS,
    })

  return {
    state: () => status,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    retain: () => {
      retained = true
    },
    async start(signal) {
      signal.throwIfAborted()
      const existing = readDescriptor(instance.instanceRoot)
      if (existing && existing.hostname === options.hostname && alive(existing.pid)) {
        const url = loopbackUrl(existing.hostname, existing.port)
        if (await checkHealth(url, existing.password)) {
          writeLog("server", "reusing the running NovaClaw server", { url })
          // Reuse is the ONE path that has already proven health, at the top of this function.
          report({ phase: "running" })
          return {
            credentials: { url, username: existing.username, password: existing.password },
            healthy: Promise.resolve(),
          }
        }
        clearDescriptor(instance.instanceRoot, existing.id)
      }

      const port = options.port && options.port > 0 ? options.port : await probeLocalPort(signal)
      const password = ServerToken.storedPassword(databaseFile) ?? options.password ?? randomUUID()
      signal.throwIfAborted()
      const started = spawn(command, argsFor(port, password), {
        cwd: process.cwd(),
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: createLocalServerEnvironment(),
      })
      child = started
      const url = loopbackUrl(options.hostname, port)
      const id = randomUUID()
      started.stdout?.on("data", (chunk: Buffer) =>
        writeLog("server", "stdout", { message: chunk.toString("utf8").trimEnd() }),
      )
      started.stderr?.on("data", (chunk: Buffer) => {
        const message = chunk.toString("utf8").trimEnd()
        writeLog("server", "stderr", { message }, "warn")
        process.stderr.write(`${message}\n`)
      })
      started.once("exit", (code) => {
        if (stopped || child !== started) return
        // The standalone server supervises its own child, so an exit here means it gave up or was
        // asked to stop. Either way the desktop reports the loss; the reconnect banner is the surface.
        writeLog("server", "standalone server exited", { code }, code === 0 ? "info" : "warn")
        report({ phase: "gave-up", reason: "crash", attempts: 1 })
      })
      if (started.pid === undefined) {
        started.kill()
        throw new Error("the standalone NovaClaw server did not start")
      }
      writeDescriptor(instance.instanceRoot, {
        id,
        port,
        hostname: options.hostname,
        username: options.username,
        password,
        pid: started.pid,
      })

      const healthy = waitHealthy(url, password, () => signal.aborted || stopped || child !== started)
        .then((result) => {
          if (result === "cancelled") throw signal.reason ?? new Error("the standalone server start was cancelled")
          writeLog("server", "standalone server ready", { url })
          // Observed to answer, and only now. The renderer is already holding these credentials and
          // is asking; `running` is the answer to that question, not a default.
          report({ phase: "running" })
        })
        .catch(async (error) => {
          await stopChild(started)
          clearDescriptor(instance.instanceRoot, id)
          throw error
        })
      return { credentials: { url, username: options.username, password }, healthy }
    },
    async stop() {
      if (stopped) return
      stopped = true
      report({ phase: "stopped" })
      const current = child
      child = undefined
      if (retained) return
      const descriptor = readDescriptor(instance.instanceRoot)
      if (descriptor) {
        // Graceful first: the child's own settle path, over HTTP so it runs on Windows too.
        await disposeRemote(loopbackUrl(descriptor.hostname, descriptor.port), descriptor.password)
      }
      if (current) await stopChild(current)
      else if (descriptor && alive(descriptor.pid)) killTreeSync(descriptor.pid)
      if (descriptor) clearDescriptor(instance.instanceRoot, descriptor.id)
    },
  }

  async function stopChild(current: ChildProcess) {
    if (current.exitCode !== null || current.pid === undefined) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, STOP_TIMEOUT_MS)
      current.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
      // Tree, not root: the standalone `serve` parent owns the server child that binds the port.
      killTreeSync(current.pid)
    })
  }
}
