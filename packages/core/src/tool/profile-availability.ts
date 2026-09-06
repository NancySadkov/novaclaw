import { Effect } from "effect"
import { Config } from "../config"

/** The privacy switch is read at horizon construction, even before the implementation is loaded. */
export const sharingEnabled = Effect.gen(function* () {
  const config = yield* Config.Service
  return Config.latest(yield* config.entries(), "user_profile")?.enabled !== false
})
