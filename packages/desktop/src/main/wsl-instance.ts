import { registerWslIpcHandlers } from "./wsl/ipc"
import type { WslServersController } from "./wsl/servers"

export function createWslInstanceHost(
  version: string,
  logger: {
    log(message: string, metadata?: unknown): void
    error(message: string, metadata?: unknown): void
  },
) {
  let closed = false
  let loading: Promise<WslServersController | undefined> | undefined
  const prepare = () =>
    (loading ??= (async () => {
      if (closed) return
      if (process.platform !== "win32") {
        registerWslIpcHandlers(undefined)
        return
      }
      const [{ createWslServersController }, { spawnWslSidecar }] = await Promise.all([
        import("./wsl/servers"),
        import("./wsl/sidecar"),
      ])
      if (closed) return
      const controller = createWslServersController(
        version,
        (distro) => {
          logger.log("spawning wsl sidecar", { distro })
          return spawnWslSidecar(distro, {
            onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
          })
        },
        { logger },
      )
      registerWslIpcHandlers(controller)
      return controller
    })())
  return {
    prepare,
    initialize() {
      void prepare()
        .then((controller) => {
          if (!closed) return controller?.initialize()
        })
        .catch((error) => logger.error("wsl server initialization failed", error))
    },
    async stop() {
      closed = true
      const controller = await loading?.catch(() => undefined)
      await controller?.stopAll()
    },
  }
}
