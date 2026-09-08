export * as SessionStrict from "./session-strict"

import { Schema } from "effect"
import { optional } from "./schema"

// The per-session Strict-harness override (the composer's Strict switch). Strict mode is the
// Juvenile Harness posture (jh.md): the harness owns decomposition, per-step verification, and
// recovery. Globally it is configured under Settings → Strict mode (`config.strict`); this override
// lets ONE chat opt in/out and set its own racing width + time budget. `undefined` (no override)
// = inherit: the parent chain, then the global config. Group lever toggles (verification/recovery/…)
// stay global-only — per-session we surface exactly what a user tunes per task.
export const Override = Schema.Struct({
  enabled: Schema.Boolean.pipe(optional),
  attempts: Schema.Finite.pipe(optional),
  wallMinutes: Schema.Finite.pipe(optional),
}).annotate({ identifier: "Session.StrictOverride" })
export interface Override extends Schema.Schema.Type<typeof Override> {}
