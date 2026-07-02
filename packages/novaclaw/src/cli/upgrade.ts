import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@novaclaw/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@novaclaw/core/installation/version"
import { GlobalBus } from "@/bus/global"

export async function upgrade() {
  // jh fork: never check for upstream releases. Kept reachable (instead of a bare
  // top-level `return`) so the upstream body below still type-checks and rebases
  // cleanly; `enabled` is always false at runtime, so we return before any check.
  const enabled = false as boolean
  if (!enabled) return
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  if (config.autoupdate === false || Flag.NOVACLAW_DISABLE_AUTOUPDATE) return
  const method = await Installation.method()
  const latest = await Installation.latest(method).catch(() => undefined)
  if (!latest) return

  if (Flag.NOVACLAW_ALWAYS_NOTIFY_UPDATE) {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  if (InstallationVersion === latest) return

  const kind = Installation.getReleaseType(InstallationVersion, latest)

  if (config.autoupdate === "notify" || kind !== "patch") {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  if (method === "unknown") return
  await Installation.upgrade(method, latest)
    .then(() =>
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: latest },
        },
      }),
    )
    .catch(() => {})
}
