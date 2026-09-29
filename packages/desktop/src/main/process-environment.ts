import * as http from "node:http"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import { app } from "electron"
import { preferAppEnv } from "./server"

type Logger = { warn(message: string, error?: unknown): void }

export function refreshProxyEnvironment(logger: Logger) {
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      if (!items.some((value) => value.toLowerCase() === host)) items.push(host)
    }
    process.env[key] = items.join(",")
  }
  try {
    // Electron's Node API is newer than the installed @types/node declarations.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

export function prepareProcessEnvironment(logger: Logger) {
  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }
  refreshProxyEnvironment(logger)
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")
  else {
    // 🔴 A PACKAGED BUILD IS STILL DRIVABLE, BUT ONLY WHEN A PERSON ASKS.
    //
    // The owner's 0.1.81 froze reproducibly on a packaged install — clicking a roster officer with no
    // open tab — and the only way to study it was to photograph the window. A frozen window cannot be
    // photographed twice the same way, and it cannot be clicked at all, so the bug could not be
    // reproduced, bisected or regression-tested; every hypothesis about it was a story. The fix is to
    // be able to drive the real artifact.
    //
    // ⚠️ `--debug-port` is opt-in and never a default. An open debugging port on a shipped desktop app
    // is a way for any local process to read the renderer's memory, so this stays behind an explicit
    // flag rather than becoming a convenience.
    const requested = process.argv
      .map((arg) => /^--debug-port(?:=(.*))?$/.exec(arg))
      .find((match) => match !== null)?.[1]
    if (requested !== undefined) {
      const port = Number(requested === "" ? 9222 : requested)
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        app.commandLine.appendSwitch("remote-debugging-port", String(port))
        logger.warn("remote debugging enabled by --debug-port", { port })
      } else {
        logger.warn("ignoring an invalid --debug-port", { requested })
      }
    }
  }
}

/** Login-shell probes run only from the local owner's start, after a window has opened. */
export function prepareLocalEnvironment(logger: Logger) {
  preferAppEnv()
  refreshProxyEnvironment(logger)
}
