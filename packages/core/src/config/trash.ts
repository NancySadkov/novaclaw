export * as ConfigTrash from "./trash"

import { Schema } from "effect"

const RetentionDays = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 }))

/** Instance-wide safe-delete retention, in human-sized days. */
export class Info extends Schema.Class<Info>("ConfigV2.Trash")({
  retention_days: RetentionDays.pipe(Schema.optional).annotate({
    description: "How many days deleted files remain restorable (1–365)",
  }),
}) {}
