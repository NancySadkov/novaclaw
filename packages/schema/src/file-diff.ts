export * as FileDiff from "./file-diff"

import { Schema } from "effect"
import { optional } from "./schema"

export const Info = Schema.Struct({
  file: optional(Schema.String),
  patch: optional(Schema.String),
  patchUnavailableReason: optional(Schema.Literals(["binary", "too_large", "metadata_only"])),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: optional(Schema.Literals(["added", "deleted", "modified"])),
}).annotate({ identifier: "SnapshotFileDiff" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
