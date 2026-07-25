export * as Session from "./session"

import { Schema } from "effect"
import { Agent } from "./agent"
import { Location } from "./location"
import { Model } from "./model"
import { DateTimeUtcFromMillis, optional, RelativePath } from "./schema"
import { SessionEvent } from "./session-event"
import { SessionID } from "./session-id"
import { SessionStrict } from "./session-strict"
import { SessionType } from "./session-type"
import { Revert } from "./revert"
import { PermissionRuleset } from "./permission-ruleset"

export const ID = SessionID
export type ID = SessionID

export const Event = SessionEvent

/** One changed file in the drain-end changes summary (row-faithful to the stored diff JSON). */
export const ChangeDiff = Schema.Struct({
  file: Schema.String.pipe(optional),
  patch: Schema.String.pipe(optional),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.Literals(["added", "deleted", "modified"]).pipe(optional),
}).annotate({ identifier: "Session.ChangeDiff" })
export interface ChangeDiff extends Schema.Schema.Type<typeof ChangeDiff> {}

export const ChangesSummary = Schema.Struct({
  additions: Schema.Finite,
  deletions: Schema.Finite,
  files: Schema.Finite,
  diffs: Schema.Array(ChangeDiff).pipe(optional),
}).annotate({ identifier: "Session.ChangesSummary" })
export interface ChangesSummary extends Schema.Schema.Type<typeof ChangesSummary> {}

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  parentID: ID.pipe(optional),
  // Row-truth provenance (V1-nuke slice D: the record events carry the FULL row, so these ride
  // the native Info now; the columns are NOT NULL).
  slug: Schema.String,
  version: Schema.String,
  // The saved permission ruleset (written at create/setPermission; the whole-row Updated
  // projector must never lose it).
  permission: PermissionRuleset.Ruleset.pipe(optional),
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
  agent: Agent.ID.pipe(optional),
  model: Model.Ref.pipe(optional),
  systemPromptOverride: Schema.String.pipe(optional),
  type: SessionType.Info.pipe(optional),
  priority: Schema.Finite.pipe(optional),
  responder: Schema.Literals(["nova", "operator"]).pipe(optional),
  permissionMode: Schema.Literals(["plan", "ask", "surgical", "bypass", "yolo"]).pipe(optional),
  strict: SessionStrict.Override.pipe(optional),
  // Per-session harness-feature overrides (the composer's Tuning control); absent = inherit.
  introspection: Schema.Boolean.pipe(optional),
  quality: Schema.Boolean.pipe(optional),
  affective: Schema.Boolean.pipe(optional),
  thinkingBudget: Schema.Boolean.pipe(optional),
  surgicalEdits: Schema.Boolean.pipe(optional),
  askBeforeChanges: Schema.Boolean.pipe(optional),
  result: Schema.Unknown.pipe(optional),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    archived: DateTimeUtcFromMillis.pipe(optional),
  }),
  title: Schema.String,
  location: Location.Ref,
  subpath: RelativePath.pipe(optional),
  revert: Revert.State.pipe(optional),
  // The drain-end CHANGES summary (the runner's git tree-diff over the whole transcript — feeds
  // the Changes badge/review). Row-faithful to the stored columns; V1-nuke slice A surfaced it
  // natively (the V1 wire shape was the only carrier before).
  summary: ChangesSummary.pipe(optional),
}).annotate({ identifier: "SessionV2.Info" })

export const ListAnchor = Schema.Struct({
  id: ID,
  time: Schema.Finite,
  direction: Schema.Literals(["previous", "next"]),
}).annotate({ identifier: "Session.ListAnchor" })
export interface ListAnchor extends Schema.Schema.Type<typeof ListAnchor> {}
