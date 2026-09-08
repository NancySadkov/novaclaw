import { Config } from "@/config/config"
import { Config as ConfigV2 } from "@novaclaw/core/config"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { Effect, Schema } from "effect"
import type { HttpServerRequest } from "effect/unstable/http"
import { InvalidRequestError } from "../errors"
import { CONFIG_WRITE_REFUSED_KIND, rejectNullConfigValues, rejectUnknownConfigKeys } from "../groups/config"

type ConfigReadView = "instance" | "global"

/**
 * The one HTTP mutation path for runtime configuration.
 *
 * Store writes dispatch their registered domain reloads before returning. The explicit invalidation
 * keeps the process-global read view honest even when no location graph is currently alive to own
 * the config-domain reload registration. Neither route tears down an instance to apply a setting.
 */
export const mutateConfig = Effect.fn("ConfigHttpApi.mutate")(function* (input: {
  readonly request: HttpServerRequest.HttpServerRequest
  readonly payload: ConfigV2.Info
  readonly readView: ConfigReadView
}) {
  const config = yield* Config.Service

  yield* rejectUnknownConfigKeys(input.request)
  yield* rejectNullConfigValues(input.request)

  const consumed = yield* ConfigStoreWrite.apply(input.payload).pipe(
    Effect.catchTag(
      "ConfigStoreWrite.ConfigWriteRefused",
      (error) => new InvalidRequestError({ kind: CONFIG_WRITE_REFUSED_KIND, message: error.message }),
    ),
  )
  if (consumed.size > 0) yield* config.invalidate()

  const base = (yield* (input.readView === "global" ? config.getGlobal() : config.get())) as Record<string, unknown>
  return Schema.decodeUnknownSync(ConfigV2.Info)(yield* ConfigStoreWrite.overlay(base))
})
