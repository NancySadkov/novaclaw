export * as ConfigFormatter from "./formatter"

import { Schema } from "effect"
import { ConfigAnnotation } from "@novaclaw/schema/config-annotation"

export class Entry extends Schema.Class<Entry>("ConfigV2.Formatter.Entry")({
  disabled: Schema.Boolean.pipe(Schema.optional),
  command: Schema.String.pipe(Schema.Array, Schema.optional),
  // Same argument as `mcp.servers.<n>.environment`: a registry token lives here as often as a PATH.
  environment: ConfigAnnotation.secret(
    Schema.Record(Schema.String, Schema.String).pipe(Schema.optional).annotate({
      description: "Environment variables for the formatter process. Values are credentials as often as not.",
    }),
  ),
  extensions: Schema.String.pipe(Schema.Array, Schema.optional),
}) {}

export const Info = Schema.Union([Schema.Boolean, Schema.Record(Schema.String, Entry)])
