import { app } from "electron"
import { createDesktopDiagnostics } from "./diagnostics"
import { prepareInstanceHome } from "./instance-home"
import { createLocalInstance } from "./local-instance"
import { write as writeLog } from "./logging"
import { prepareLocalEnvironment, prepareProcessEnvironment } from "./process-environment"
import { spawnLocalServer, superviseLocalServer } from "./server"
import type { DesktopLaunchOptions } from "./desktop-cli"

/** Run the packaged server without constructing a window or renderer. */
export async function runHeadlessServer(options: DesktopLaunchOptions) {
  prepareInstanceHome("server", true)
  const { logger } = createDesktopDiagnostics()
  prepareProcessEnvironment(logger)
  prepareLocalEnvironment(logger)

  if (!app.requestSingleInstanceLock()) {
    process.stderr.write("NovaClaw server: this home already has a headless server process.\n")
    app.exit(1)
    return
  }

  await app.whenReady()
  const runtime = {
    username: options.server.username,
    cors: options.server.cors,
    mdns: options.server.mdns,
    mdnsDomain: options.server.mdnsDomain,
  }
  const local = createLocalInstance({
    prepare: () => undefined,
    requestedPort: options.server.port,
    hostname: options.server.hostname,
    username: options.server.username,
    // Server-only follows `nova-cli serve`: no launch password means stored password, otherwise open.
    password: options.server.password ?? null,
    log: (message, metadata) => logger.log(message, metadata),
    spawn: (port, password, signal, report) => {
      const callbacks = {
        signal,
        onStdout: (message: string) => writeLog("server", "stdout", { message }),
        onStderr: (message: string) => {
          writeLog("server", "stderr", { message }, "warn")
          process.stderr.write(`${message}\n`)
        },
        onExit: (code: number) => {
          writeLog("utility", "headless sidecar exited", { code }, "warn")
          if (!options.server.supervise && !stopping) void stop(code === 0 ? 0 : 1)
        },
      }
      if (!options.server.supervise)
        return spawnLocalServer(options.server.hostname, port, password, callbacks, runtime)
      return superviseLocalServer(
        options.server.hostname,
        port,
        password,
        {
          ...callbacks,
          onState: (state) => {
            report(state)
            if (state.phase === "restarting")
              process.stderr.write(`[supervise] restarting server in ${state.nextAttemptInMs / 1000}s\n`)
            if (state.phase === "gave-up") {
              process.stderr.write("[supervise] server crash loop; giving up.\n")
              if (!stopping) void stop(1)
            }
          },
        },
        runtime,
      )
    },
  })

  let stopping: Promise<void> | undefined
  const stop = (code: number) => {
    if (stopping) return stopping
    stopping = local
      .stop()
      .catch((error) => process.stderr.write(`NovaClaw server shutdown failed: ${String(error)}\n`))
      .then(() => app.exit(code))
    return stopping
  }
  app.on("before-quit", (event) => {
    if (stopping) return
    event.preventDefault()
    void stop(0)
  })
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void stop(0))

  try {
    const started = await local.start(new AbortController().signal)
    await started.healthy
    const port = new URL(started.credentials.url).port
    process.stdout.write(`novaclaw server listening on ${listenUrl(options.server.hostname, port)}\n`)
    if (!options.server.password)
      process.stdout.write(
        "note: no --password given; the stored server.password applies, otherwise this bind is unauthenticated.\n",
      )
    if (!isLoopback(options.server.hostname))
      process.stderr.write(
        "warning: this endpoint uses plain HTTP. Keep it on a trusted network or put TLS in front of it before exposing it to the public Internet.\n",
      )
  } catch (error) {
    process.stderr.write(`NovaClaw server failed to start: ${error instanceof Error ? error.message : String(error)}\n`)
    await stop(1)
  }
}

function listenUrl(hostname: string, port: string) {
  const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname
  return `http://${host}:${port}`
}

function isLoopback(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]"
}
