import { MainLogger } from "electron-log"
import log from "electron-log/main.js"
import { app, crashReporter, netLog, shell } from "electron"
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { ZipWriter, BlobWriter, BlobReader } from "@zip.js/zip.js"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { describeLogDirectory, resolveLogDirectory, type LogDirectory } from "./log-directory"
import { collectRecentFiles, type DebugExportEntry } from "./debug-export"

const MAX_LOG_AGE_DAYS = 7
const TAIL_LINES = 1000
const EXPORT_WINDOW = 24 * 60 * 60 * 1000
const NET_LOG_SIZE = 20 * 1024 * 1024

let root = ""
let run = ""
let netLogPath: string | undefined
let directory: LogDirectory = { kind: "unavailable", attempted: [], reason: "logging has not been initialised" }
// `write()` used to gate on `run`, which conflated "not initialised yet" with "no file destination".
// Keep the pre-init guard, but let the console transport carry the run once the file leg is off.
let initialised = false

let logger: MainLogger
export const getLogger = () => logger

/** What happened to this run's log directory. `index.ts` reads it to decide whether to say so. */
export const getLogDirectory = (): LogDirectory => directory

export function initLogging() {
  directory = initRunDirectory()

  if (directory.kind === "unavailable") {
    // ⚠️ Do NOT leave the file transport pointing at `join("", "main.log")` — that resolves to the
    // process cwd, which `index.ts` has set to the user's home. Scattering a log file across a
    // stranger's home directory is exactly what AGENTS.md principle 11 forbids. Off is honest.
    log.transports.file.level = false
  } else {
    log.transports.file.maxSize = 5 * 1024 * 1024
    log.transports.file.resolvePathFn = (_vars, message) =>
      join(
        run,
        `${safeLogName(message?.scope ?? (message?.variables?.processType === "renderer" ? "renderer" : "main"))}.log`,
      )
  }

  log.initialize({ preload: false, spyRendererConsole: true })
  initConsoleTransport()
  cleanup()
  initialised = true
  logger = log

  const report = describeLogDirectory(directory)
  if (report) write("logging", report.message, report.meta, report.level)
  return logger
}

export function initCrashReporter() {
  // Same shape as the log directory: an unguarded mkdirSync here died before any window existed.
  try {
    const dir = join(app.getPath("userData"), "Crashpad")
    mkdirSync(dir, { recursive: true })
    app.setPath("crashDumps", dir)
    crashReporter.start({ uploadToServer: false, compress: true })
    write("crash", "crash reporter started", { path: dir })
  } catch (error) {
    write("crash", "crash reporter unavailable", { error: String(error) }, "warn")
  }
}

export async function startNetLog() {
  if (netLog.currentlyLogging) return
  if (!run) {
    write("network", "net log skipped — no writable log directory", undefined, "warn")
    return
  }
  netLogPath = join(run, "network.netlog")
  await netLog.startLogging(netLogPath, { captureMode: "default", maxFileSize: NET_LOG_SIZE })
  write("network", "net log started", { path: netLogPath })
}

export async function exportDebugLogs(serverLogDirectory?: string) {
  const restartNetLog = netLog.currentlyLogging
  if (restartNetLog) {
    await netLog.stopLogging().catch((error) => write("network", "failed to stop net log", { error }))
  }

  const output = join(app.getPath("downloads"), `novaclaw-debug-${stamp()}.zip`)
  try {
    write("main", "exporting debug logs", { output })
    await writeZip(output, [
      { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest(serverLogDirectory), null, 2)) },
      ...collectRecentFiles(root, "desktop", EXPORT_WINDOW),
      ...(serverLogDirectory ? collectRecentFiles(serverLogDirectory, "server", EXPORT_WINDOW) : []),
      ...collectRecentFiles(app.getPath("crashDumps"), "crashpad", EXPORT_WINDOW),
    ])
    shell.showItemInFolder(output)
    return output
  } finally {
    if (restartNetLog) {
      await startNetLog().catch((error) => write("network", "failed to restart net log", { error }))
    }
  }
}

export function write(
  name: string,
  message: string,
  extra?: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info",
) {
  if (!initialised) return
  const scoped = log.scope(safeLogName(name))
  if (extra !== undefined) {
    scoped[level](message, extra)
    return
  }
  scoped[level](message)
}

export function tail(): string {
  try {
    const path = log.transports.file.getFile().path
    const contents = readFileSync(path, "utf8")
    const lines = contents.split("\n")
    return lines.slice(Math.max(0, lines.length - TAIL_LINES)).join("\n")
  } catch {
    return ""
  }
}

function initRunDirectory(): LogDirectory {
  // The profile folder first; the OS temp dir second. Both are locations AGENTS.md principle 11
  // allows NovaClaw to write to, and the second exists so an unwritable profile degrades to
  // "logs land somewhere else and say so" instead of killing the process.
  const result = resolveLogDirectory(
    [join(app.getPath("userData"), "logs"), join(tmpdir(), "novaclaw-logs")],
    stamp(),
    (dir) => mkdirSync(dir, { recursive: true }),
  )
  root = result.kind === "unavailable" ? "" : result.root
  run = result.kind === "unavailable" ? "" : result.run
  return result
}

function stamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
}

function safeLogName(name: string) {
  return name.replace(/[^a-z0-9_.-]/gi, "_") || "main"
}

function cleanup() {
  // ⚠️ Both `getFile()` and `readdirSync` throw on an unwritable/absent profile folder, and this
  // runs inside initLogging — i.e. before the logger exists and before any window does. Retiring
  // old logs is housekeeping; it must never be the reason the app fails to start.
  let dir: string
  try {
    dir = root || dirname(log.transports.file.getFile().path)
  } catch {
    return
  }
  if (!dir) return

  const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  for (const entry of entries) {
    const file = join(dir, entry)
    try {
      const info = statSync(file)
      if (info.mtimeMs < cutoff) rmSync(file, { recursive: true, force: true })
    } catch {
      continue
    }
  }
}

function manifest(serverLogDirectory?: string) {
  return {
    generated: new Date().toISOString(),
    version: app.getVersion(),
    name: app.getName(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    versions: process.versions,
    uptime: process.uptime(),
    userData: app.getPath("userData"),
    logs: root,
    currentRun: run,
    crashDumps: app.getPath("crashDumps"),
    serverLog: serverLogDirectory,
    netLog: netLogPath,
  }
}

async function writeZip(output: string, entries: DebugExportEntry[]) {
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  for (const entry of entries) {
    const data = entry.data ?? readFileSync(entry.path!)
    await writer.add(entry.name, new BlobReader(new Blob([new Uint8Array(data)])))
  }
  const zip = await writer.close()
  writeFileSync(output, Buffer.from(await zip.arrayBuffer()))
}

function initConsoleTransport() {
  const write = log.transports.console.writeFn.bind(log.transports.console)
  log.transports.console.writeFn = (options) => {
    try {
      write(options)
    } catch (err) {
      if (!isBrokenPipe(err)) throw err
      log.transports.console.level = false
    }
  }
}

function isBrokenPipe(err: unknown) {
  return typeof err === "object" && err !== null && "code" in err && err.code === "EPIPE"
}
