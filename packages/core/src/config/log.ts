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

/**
 * The ceiling on ONE agent's work-log, in megabytes.
 *
 * Written because the work-log was unbounded until 2026-09-29: compaction minted a fresh
 * `oldctx-<DATETIME>.txt` per fold, and Nova's `tmp` reached 5,187 files / 0.66 GB. The log is now one
 * file per agent, which is only an improvement while it is CAPPED — a single uncapped file is the same
 * disk problem in one lump, and a worse one for the agent, which can no longer find anything in a pile.
 *
 * 1–4096 MB. The floor is 1 MB because below that a single compaction's text can be trimmed away by
 * the next one; the ceiling is 4096 MB because past that the cap is not a retention policy but an
 * outage.
 */
export const WorkLogMaxMb = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4096 }))

/** Instance-owned local-log preferences. Correctness parameters remain private to the writer. */
export class Info extends Schema.Class<Info>("ConfigV2.Log")({
  level: Level.pipe(Schema.optional).annotate({ description: "Minimum level written to the instance log" }),
  retention_days: RetentionDays.pipe(Schema.optional).annotate({
    description: "Minimum number of days of local activity history to keep (1–365; the byte ceiling still applies)",
  }),
  work_log_max_mb: WorkLogMaxMb.pipe(Schema.optional).annotate({
    description: "Maximum size of one agent's work-log in megabytes (1–4096; older messages are halved away)",
  }),
  subsystems: Subsystems.pipe(Schema.optional).annotate({
    description: "Minimum levels for declared log subsystems; each override wins over the global level",
  }),
}) {}
