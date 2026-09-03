export * as Vcs from "./vcs"

import { Schema } from "effect"

/**
 * THE VCS WIRE SHAPES, in the package both sides of the contract can reach.
 *
 * 🔴 These lived in `novaclaw/src/project/vcs.ts`, beside the SERVICE that produces them, and that
 * is why the five `/vcs*` routes were still legacy-shaped long after every sibling family had moved
 * to `/api`: `packages/protocol` declares the one contract (ruling 11) and cannot import from
 * `packages/novaclaw`, so the routes could not be declared where they belong while their schemas
 * lived where they did. The schemas are pure `Schema` with no service in them, so the split costs
 * nothing and unblocks the move. `project/vcs.ts` re-exports them, so there is still one definition.
 *
 * ⚠️ The service stays in `novaclaw` and so does its handler: it needs that package's `Git`,
 * `InstanceState` and `EventV2Bridge`. Declaring a route and serving it are different jobs, and only
 * the declaration has to be shared.
 */

/**
 * Which comparison a diff is against: the working tree (`git`) or the default branch (`branch`).
 */
export const Mode = Schema.Literals(["git", "branch"])
export type Mode = Schema.Schema.Type<typeof Mode>

export const Info = Schema.Struct({
  branch: Schema.optional(Schema.String),
  default_branch: Schema.optional(Schema.String),
}).annotate({ identifier: "VcsInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export const FileDiff = Schema.Struct({
  file: Schema.String,
  // Mirrors Snapshot.FileDiff (see #26574). The current producer always
  // populates patch, but loosening matches the sibling schema so a
  // future code path that omits it can't crash the diff route.
  patch: Schema.optional(Schema.String),
  patchUnavailableReason: Schema.optional(Schema.Literals(["binary", "too_large", "metadata_only"])),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
}).annotate({ identifier: "VcsFileDiff" })
export type FileDiff = Schema.Schema.Type<typeof FileDiff>

export const FileStatus = Schema.Struct({
  file: Schema.String,
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.Literals(["added", "deleted", "modified"]),
}).annotate({ identifier: "VcsFileStatus" })
export type FileStatus = Schema.Schema.Type<typeof FileStatus>

export const ApplyInput = Schema.Struct({
  patch: Schema.String,
})
export type ApplyInput = Schema.Schema.Type<typeof ApplyInput>

export const ApplyResult = Schema.Struct({
  applied: Schema.Boolean,
})
export type ApplyResult = Schema.Schema.Type<typeof ApplyResult>

/** The service's own failure. The route's error shape wraps this; see `groups/vcs.ts`. */
export class PatchApplyError extends Schema.TaggedErrorClass<PatchApplyError>()("VcsPatchApplyError", {
  message: Schema.String,
  reason: Schema.Literals(["non-git", "not-clean"]),
}) {}
