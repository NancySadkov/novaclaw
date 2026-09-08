export * as FileSystem from "./filesystem"

import { Schema } from "effect"
import { optional } from "./schema"
import { define, inventory } from "./event"
import { NonNegativeInt, PositiveInt, RelativePath } from "./schema"

const Edited = define({
  type: "file.edited",
  schema: { file: Schema.String },
})
export const Event = { Edited, Definitions: inventory(Edited) }

export interface Entry extends Schema.Schema.Type<typeof Entry> {}
export const Entry = Schema.Struct({
  path: RelativePath,
  type: Schema.Literals(["file", "directory"]),
}).annotate({ identifier: "FileSystem.Entry" })

export interface Submatch extends Schema.Schema.Type<typeof Submatch> {}
export const Submatch = Schema.Struct({
  text: Schema.String,
  start: NonNegativeInt,
  end: NonNegativeInt,
}).annotate({ identifier: "FileSystem.Submatch" })

export interface Match extends Schema.Schema.Type<typeof Match> {}
export const Match = Schema.Struct({
  entry: Entry,
  line: PositiveInt,
  offset: NonNegativeInt,
  text: Schema.String,
  submatches: Schema.Array(Submatch),
}).annotate({ identifier: "FileSystem.Match" })

export interface SnapshotContent extends Schema.Schema.Type<typeof SnapshotContent> {}
export const SnapshotContent = Schema.Struct({
  type: Schema.Literal("binary"),
  content: Schema.String,
  encoding: Schema.Literal("base64"),
  mimeType: Schema.String.pipe(optional),
}).annotate({ identifier: "FileSystem.SnapshotContent" })

export class FindInput extends Schema.Class<FindInput>("FileSystem.FindInput")({
  query: Schema.String,
  type: Schema.Literals(["file", "directory"]).pipe(optional),
  limit: PositiveInt.pipe(optional),
}) {}
