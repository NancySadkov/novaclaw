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
  const feature = "DocumentPolicyIncludeJSCallStacksInCrashReports"
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${feature},${features}` : feature)
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")
}

/** Login-shell probes run only from the local owner's start, after a window has opened. */
export function prepareLocalEnvironment(logger: Logger) {
  preferAppEnv()
  refreshProxyEnvironment(logger)
}
