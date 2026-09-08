export * as ConfigLog from "./log"

import { SUBSYSTEMS } from "@novaclaw/schema/log-events"
import { Schema } from "effect"

export const Level = Schema.Literals(["debug", "info", "warn", "error"])
export type Level = typeof Level.Type

const subsystemFields = Object.fromEntries(
  Object.keys(SUBSYSTEMS).map((subsystem) => [subsystem, Level.pipe(Schema.optional)]),
)

/** Per-subsystem overrides are closed over the event registry's first segment. */
export const Subsystems = Schema.Struct(subsystemFields)

const RetentionDays = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 }))

/** Instance-owned local-log preferences. Correctness parameters remain private to the writer. */
export class Info extends Schema.Class<Info>("ConfigV2.Log")({
  level: Level.pipe(Schema.optional).annotate({ description: "Minimum level written to the instance log" }),
  retention_days: RetentionDays.pipe(Schema.optional).annotate({
    description: "Minimum number of days of local activity history to keep (1–365; the byte ceiling still applies)",
  }),
  subsystems: Subsystems.pipe(Schema.optional).annotate({
    description: "Minimum levels for declared log subsystems; each override wins over the global level",
  }),
}) {}
