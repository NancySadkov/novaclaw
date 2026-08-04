export * as PermissionSaved from "./permission-saved"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { statics } from "./schema"

export const ID = Schema.String.pipe(
  Schema.brand("PermissionSaved.ID"),
  statics((schema) => ({ create: () => schema.make("psv_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Info = Schema.Struct({
  id: ID,
  /** T2 (entities.md): scoped by the rename-stable origin hash, not a project entity. */
  origin: Schema.String,
  action: Schema.String,
  resource: Schema.String,
  /** 1K: persistent denies. Absent on legacy rows = "allow". */
  effect: Schema.optional(Schema.Literals(["allow", "deny"])),
}).annotate({ identifier: "PermissionSaved.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
