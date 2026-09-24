import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { unlinkSync } from "node:fs"
import { createConnection, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { app } from "electron"
import { ServerToken } from "@novaclaw/core/server-token"
import { Presence } from "@novaclaw/core/presence"
import type { SuperviseStatus } from "@novaclaw/script/supervise"
import type { ServerReadyData } from "../preload/types"
import type { DesktopLaunchOptions } from "./desktop-cli"
import type { LocalInstanceOwner } from "./lifecycle"
import { checkHealth } from "./server"
import { serviceHomeArgs, type ServiceInstancePaths } from "./instance-home-path"

type Descriptor = {
  id: string
  hostname: string
  port: number
  username: string
  password: string
  pipe: string
  watchdogPid: number
  databaseFile?: string
  closeRequested?: boolean
}

export function servicePath(home: string) {
  return join(home, "desktop-service.sqlite")
}

export function watchdogStatePath(home: string) {
  return join(home, "desktop-watchdog")
}

function pathPresent(target: string) {
  const reading = Presence.read(target)
  if (reading.answer === "unreadable")
    throw new Error(`Cannot inspect ${target}: ${reading.code ?? "unknown filesystem error"}`)
  return reading.answer === "present"
}

export function readService(home: string): Descriptor | undefined {
  const path = servicePath(home)
  if (!pathPresent(path)) return undefined
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(path, { readOnly: true })
    const row = database.prepare("SELECT value FROM desktop_service WHERE slot = 1").get() as { value?: string } | undefined
    const value: unknown = row?.value ? JSON.parse(row.value) : undefined
    if (!value || typeof value !== "object") throw new Error("Service descriptor is invalid")
    const item = value as Partial<Descriptor>
    if (typeof item.id !== "string" || typeof item.hostname !== "string" ||
      !Number.isInteger(item.port) || item.port! < 1 || item.port! > 65535 ||
      typeof item.username !== "string" || typeof item.password !== "string" ||
      typeof item.pipe !== "string" || !Number.isInteger(item.watchdogPid))
      throw new Error("Service descriptor is invalid")
    return item as Descriptor
  } catch (error) {
    throw new Error(`Cannot read NovaClaw service descriptor at ${path}`, { cause: error })
  } finally {
    database?.close()
  }
}

export function writeService(home: string, descriptor: Descriptor) {
  const database = new DatabaseSync(servicePath(home))
  try {
    database.exec("CREATE TABLE IF NOT EXISTS desktop_service (slot INTEGER PRIMARY KEY CHECK (slot = 1), value TEXT NOT NULL)")
    database.prepare("INSERT OR REPLACE INTO desktop_service (slot, value) VALUES (1, ?)").run(JSON.stringify(descriptor))
  } finally {
    database.close()
  }
}

export function clearService(home: string, id: string) {
  if (!pathPresent(servicePath(home))) return
  const database = new DatabaseSync(servicePath(home))
  try {
    database.prepare("DELETE FROM desktop_service WHERE slot = 1 AND json_extract(value, '$.id') = ?").run(id)
  } finally {
    database.close()
  }
}

function alive(pid: number) {
  if (pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function control(descriptor: Descriptor, command: "ping" | "stop"): Promise<boolean> {
  return new Promise((resolveResult) => {
    const socket = createConnection(descriptor.pipe)
    let settled = false
    const settle = (ok: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveResult(ok)
    }
    socket.setTimeout(1500, () => settle(false))
    socket.on("error", () => settle(false))
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: descriptor.id, command })}\n`))
    socket.on("data", (data) => settle(data.toString() === "ok\n"))
    socket.on("end", () => settle(false))
  })
}

export function serveControl(descriptor: Descriptor, stop: () => Promise<void>) {
  if (process.platform !== "win32" && pathPresent(descriptor.pipe)) unlinkSync(descriptor.pipe)
  const server = createServer((socket) => {
    let data = ""
    socket.setTimeout(2000, () => socket.destroy())
    socket.on("data", (chunk) => {
      data += chunk.toString()
      if (data.length > 1024) return socket.destroy()
      if (!data.includes("\n")) return
      try {
        const request = JSON.parse(data.slice(0, data.indexOf("\n"))) as { id?: string; command?: string }
        if (request.id !== descriptor.id || (request.command !== "ping" && request.command !== "stop")) {
          socket.end("denied\n")
          return
        }
        if (request.command === "ping") {
          socket.end("ok\n")
          return
        }
        void stop().then(() => socket.end("ok\n"), () => socket.end("failed\n"))
      } catch {
        socket.end("denied\n")
      }
    })
  })
  return new Promise<() => void>((resolveReady, reject) => {
    server.once("error", reject)
    server.listen(descriptor.pipe, () => {
      server.removeListener("error", reject)
      resolveReady(() => server.close())
    })
  })
}

function pipeName(id: string) {
  return process.platform === "win32" ? `\\\\.\\pipe\\novaclaw-${id}` : join(tmpdir(), `novaclaw-${id}.sock`)
}

function watchdogBinary() {
  const filename = process.platform === "win32" ? "novaclaw-watchdog.exe" : "novaclaw-watchdog"
  return app.isPackaged
    ? join(process.resourcesPath, "watchdog", filename)
    : resolve(app.getAppPath(), "..", "watchdog", "build", filename)
}

async function freePort(): Promise<number> {
  const server = createServer()
  return new Promise((resolvePort, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("Could not reserve a service port"))
      server.close(() => resolvePort(address.port))
    })
  })
}

export function createDesktopService(instance: ServiceInstancePaths, options: DesktopLaunchOptions["server"]): LocalInstanceOwner & {
  state(): SuperviseStatus
  subscribe(listener: (state: SuperviseStatus) => void): () => void
  retain(): void
} {
  const home = instance.instanceRoot
  const databaseFile = join(instance.dataPath, "novaclaw.db")
  let descriptor: Descriptor | undefined
  let retained = false
  let stopping = false
  const state = (): SuperviseStatus => ({ phase: stopping ? "stopped" : "running" })
  return {
    state,
    subscribe: () => () => undefined,
    retain: () => { retained = true },
    async start(signal) {
      signal.throwIfAborted()
      descriptor = readService(home)
      if (descriptor && alive(descriptor.watchdogPid) && descriptor.databaseFile !== databaseFile)
        throw new Error(`A previous NovaClaw server is using a different database. Close that server before opening ${databaseFile}.`)
      if (descriptor?.closeRequested && alive(descriptor.watchdogPid)) {
        const deadline = Date.now() + 10_000
        while (alive(descriptor.watchdogPid) && Date.now() < deadline) {
          signal.throwIfAborted()
          await new Promise((resolveWait) => setTimeout(resolveWait, 100))
        }
        if (alive(descriptor.watchdogPid)) throw new Error("The previous server is still shutting down")
        descriptor = undefined
      }
      if (!descriptor || !alive(descriptor.watchdogPid)) {
        const id = randomUUID()
        const binary = watchdogBinary()
        if (!pathPresent(binary)) throw new Error(`NovaClaw watchdog is missing: ${binary}`)
        if (stopping) throw new Error("NovaClaw is shutting down")
        descriptor = {
          id,
          hostname: options.hostname,
          port: options.port && options.port > 0 ? options.port : await freePort(),
          username: options.username,
          password: ServerToken.storedPassword(databaseFile) ?? options.password ?? randomUUID(),
          pipe: pipeName(id),
          watchdogPid: 0,
          databaseFile,
        }
        writeService(home, descriptor)
        const executableArgs = app.isPackaged ? [] : [app.getAppPath()]
        const args = ["--state", watchdogStatePath(home), "--", process.execPath, ...executableArgs,
          "--server-only", "--desktop-service", ...serviceHomeArgs(instance),
          ...(options.supervise ? [] : ["--no-supervise"]),
          ...(options.mdns ? ["--mdns"] : []),
          `--mdns-domain=${options.mdnsDomain}`,
          ...options.cors.flatMap((origin) => [`--cors=${origin}`])]
        const child = spawn(binary, args, { detached: true, stdio: "ignore", windowsHide: true })
        child.unref()
        descriptor.watchdogPid = child.pid ?? 0
        if (!descriptor.watchdogPid) throw new Error("NovaClaw watchdog did not start")
        if (stopping && !retained) descriptor.closeRequested = true
        writeService(home, descriptor)
      }
      const active = descriptor
      const deadline = Date.now() + 40_000
      while (Date.now() < deadline) {
        signal.throwIfAborted()
        if (await control(active, "ping")) {
          const hostname = active.hostname === "0.0.0.0" || active.hostname === "::" || active.hostname === "[::]"
            ? "127.0.0.1"
            : active.hostname
          const clientHostname = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname
          const credentials: ServerReadyData = {
            url: `http://${clientHostname}:${active.port}`,
            username: active.username,
            password: ServerToken.storedPassword(databaseFile) ?? active.password,
          }
          return {
            credentials,
            healthy: checkHealth(credentials.url, credentials.password).then((healthy) => {
              if (!healthy) throw new Error("The retained server did not pass its health check")
            }),
          }
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 250))
      }
      throw new Error("NovaClaw's background server did not start")
    },
    async stop() {
      stopping = true
      if (retained || !descriptor) return
      const current = readService(home)
      if (current?.id === descriptor.id) writeService(home, { ...current, closeRequested: true })
      if (!await control(descriptor, "stop") && await control(descriptor, "ping"))
        throw new Error("The background server did not acknowledge shutdown")
    },
  }
}
