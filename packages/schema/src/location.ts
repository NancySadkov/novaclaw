export * as Location from "./location"

import { Schema } from "effect"
import { AbsolutePath, optional } from "./schema"
import { WorkspaceID } from "./workspace-id"

export interface Ref extends Schema.Schema.Type<typeof Ref> {}
export const Ref = Schema.Struct({
  directory: AbsolutePath,
  workspaceID: optional(WorkspaceID),
}).annotate({ identifier: "Location.Ref" })

// T2 (notes/entities.md): a project is not an entity — a location carries two derived
// substrate attributes instead: `root` (the VCS root / path root the directory lives in)
// and `origin` (the rename-stable git-derived identity hash; "global" outside any repo).
export class Info extends Schema.Class<Info>("Location.Info")({
  directory: AbsolutePath,
  workspaceID: optional(WorkspaceID),
  root: AbsolutePath,
  origin: Schema.String,
}) {}

export function response<S extends Schema.Top>(data: S) {
  return Schema.Struct({ location: Info, data })
}
