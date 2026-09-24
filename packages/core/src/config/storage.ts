export * as ConfigStorage from "./storage"

import { Schema } from "effect"

export const DEFAULT_DATABASE_MIB = 2048
export const DEFAULT_PRUNE_HOURS = 3

export class Info extends Schema.Class<Info>("ConfigV2.Storage")({
  max_database_mib: Schema.Int.check(Schema.isBetween({ minimum: 512, maximum: 32768 })).pipe(Schema.optional),
  prune_interval_hours: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 24 })).pipe(Schema.optional),
}) {}
