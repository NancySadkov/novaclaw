import { app } from "electron"
import { createDesktopService, readService } from "./desktop-service"
import { prepareInstanceHome } from "./instance-home"
import type { DesktopLaunchOptions } from "./desktop-cli"

export async function runServerOnlyLauncher(options: DesktopLaunchOptions) {
  const home = prepareInstanceHome("launcher", true)
  if (!app.requestSingleInstanceLock()) {
    process.stderr.write("NovaClaw server: a launcher is already running for this home.\n")
    app.exit(1)
    return
  }
  await app.whenReady()
  const service = createDesktopService(home, options.server)
  let ending: Promise<void> | undefined
  let monitor: ReturnType<typeof setInterval> | undefined
  const stop = (code: number) => {
    if (ending) return ending
    if (monitor) clearInterval(monitor)
    ending = service.stop()
      .catch((error) => process.stderr.write(`NovaClaw server shutdown failed: ${String(error)}\n`))
      .then(() => app.exit(code))
    return ending
  }
  app.on("before-quit", (event) => {
    event.preventDefault()
    void stop(0)
  })
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void stop(0))
  try {
    const started = await service.start(new AbortController().signal)
    await started.healthy
    const id = readService(home.instanceRoot)?.id
    process.stdout.write(`novaclaw server listening on ${started.credentials.url}\n`)
    monitor = setInterval(() => {
      if (readService(home.instanceRoot)?.id !== id) {
        clearInterval(monitor)
        app.exit(0)
      }
    }, 2000)
  } catch (error) {
    process.stderr.write(`NovaClaw server failed to start: ${error instanceof Error ? error.message : String(error)}\n`)
    await stop(1)
  }
}
