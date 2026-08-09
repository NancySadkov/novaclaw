import { CrashCapture } from "@novaclaw/core/observability/crash-capture"
import { Telemetry } from "@novaclaw/core/observability/telemetry"
import { Offline } from "@novaclaw/core/offline"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const TelemetryHandler = HttpApiBuilder.group(Api, "server.telemetry", (handlers) =>
  Effect.gen(function* () {
    const settingsStore = yield* SettingsConfigStore.Service
    return handlers.handle(
      "telemetry.status",
      Effect.fn("TelemetryHandler.status")(function* () {
        const config = yield* settingsStore.all().pipe(Effect.orElseSucceed(() => ({})))
        return Telemetry.status({
          config,
          policy: {
            enabled: CrashCapture.airgapFrom({
              builds: Offline.serviceBuilds(),
              enabled: Offline.currentPolicy().enabled,
            }),
          },
          endpoint: Telemetry.endpointFromEnv(),
          host: Telemetry.host(),
        })
      }),
    )
  }),
)
