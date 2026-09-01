// V1-nuke slice D: re-homed from schema/src/v1/permission.ts — this is the LIVE permission
// ruleset vocabulary (saved rules, replies, mode overlays), never V1-dead; only its address was.
export * as PermissionRuleset from "./permission-ruleset"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { statics } from "./schema"
import { SessionID } from "./session-id"

export const ID = Schema.String.check(Schema.isStartsWith("per")).pipe(
  Schema.brand("PermissionID"),
  statics((schema) => ({ ascending: (id?: string) => schema.make(id ?? "per_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Action = Schema.Literals(["allow", "deny", "ask"]).annotate({ identifier: "PermissionAction" })
export type Action = typeof Action.Type

export const Rule = Schema.Struct({ permission: Schema.String, pattern: Schema.String, action: Action }).annotate({
  identifier: "PermissionRule",
})
export type Rule = typeof Rule.Type

export const Ruleset = Schema.Array(Rule).annotate({ identifier: "PermissionRuleset" })
export type Ruleset = typeof Ruleset.Type

export const Request = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  always: Schema.Array(Schema.String),
  tool: Schema.optional(Schema.Struct({ messageID: Schema.String, callID: Schema.String })),
}).annotate({ identifier: "PermissionRequest" })
export type Request = typeof Request.Type

// 1K: six explicit verdict-scope replies (allow/deny x once/file/always). The legacy trio stays
// as aliases: once=allow-once, always=allow-always, reject=deny-once. Mirrors the V2 Reply union.
export const Reply = Schema.Literals([
  "once",
  "always",
  "reject",
  "allow-once",
  "allow-file",
  "allow-always",
  "deny-once",
  "deny-file",
  "deny-always",
])
export type Reply = typeof Reply.Type

export const ReplyBody = Schema.Struct({ reply: Reply, message: Schema.optional(Schema.String) }).annotate({
  identifier: "PermissionReplyBody",
})
export type ReplyBody = typeof ReplyBody.Type

export const ReplyInput = Schema.Struct({ requestID: ID, ...ReplyBody.fields }).annotate({
  identifier: "PermissionReplyInput",
})
export type ReplyInput = typeof ReplyInput.Type

const Asked = define({ type: "permission.asked", schema: Request.fields })
const Replied = define({
  type: "permission.replied",
  schema: { sessionID: SessionID, requestID: ID, reply: Reply },
})
export const Event = { Asked, Replied, Definitions: inventory(Asked, Replied) }

// ⚠️ **Five members were DELETED here 2026-08-06** — `AskInput`, and the outcome errors
// `RejectedError` / `CorrectedError` / `DeniedError` / `NotFoundError` (plus their `Error` union).
// They went with the V1 permission service in `novaclaw/src/permission/index.ts`, which was the only
// thing that raised them. The comment they carried claimed they were "live vocabulary: the ask/reply
// pipeline and the tool gate raise these" — that had stopped being true when the V1 wrapper died.
//
// The live enforcement vocabulary is `PermissionV2.DeniedError` in `core/src/permission.ts`.
// Checked before deleting, because this is the SCHEMA package and a reference count is not the test:
// zero hits across the generated SDK, `openapi.json`, the event codecs and the UI.
