export * as ProjectFile from "./project-file"

import { Schema } from "effect"
import { Permission } from "./permission"

/**
 * `novaclaw.json` — the portable declaration that a folder is a NovaClaw **Project**.
 *
 * `todo/projects.md`: a folder becomes a Project when it contains a valid `novaclaw.json`; before
 * that it is only a session working folder. This file is the FORMAT. Resolution, precedence and the
 * UI that edits it are separate items and deliberately not here.
 *
 * ⚠️ **This does not resurrect the Project ENTITY.** T3 removed that on purpose — sessions are the
 * one kernel entity, and `core/src/project.ts` derives a location's VCS root and origin hash without
 * persisting anything. A file read on demand is not an entity, and nothing here may be written into
 * the session graph as one.
 *
 * ⚠️ The NAME is reused. `novaclaw.json` in the GLOBAL CONFIG directory is a `Config.Info` document
 * that seeds agents and the catalog into SQLite; this is a different schema in a different place.
 * They do not currently collide — `agent-config-seed.ts` reads the config dir and says *"the launch
 * directory is deliberately NOT a source"* — but the two meanings share a filename, and anyone
 * moving either file between those directories will get surprising results.
 */

/**
 * The only version this build understands.
 *
 * 🔴 Bump when a change would make an OLDER NovaClaw misread the file — not for additions. An added
 * optional section is invisible to an older build (it preserves what it does not know), so bumping
 * for one would refuse files that are in fact perfectly readable. Bump when meaning CHANGES.
 */
export const VERSION = 1

/** What a folder may declare about itself. Every section optional: an empty project is still valid. */
export const Info = Schema.Struct({
  version: Schema.Number,
  /** Human-facing. Absent means "use the folder name" — never invent an identifier from it. */
  name: Schema.optional(Schema.String),
  /**
   * Ordered permission rules this folder starts sessions with.
   *
   * ⚠️ These may only NARROW. The operator's safety floor is not expressible here and may never be
   * widened by a file inside a folder — a project the user just cloned is not a trusted author.
   * Enforcing that belongs to resolution; this type only says what the file may CONTAIN.
   */
  permissions: Schema.optional(Permission.Ruleset),
  /** Paths this project asks NOT to be read. Globs, matched against the project root. */
  exclude: Schema.optional(Schema.Array(Schema.String)),
  /** IDs of installed pre-action policies. ⛔ IDs only — never a command, and never anything run. */
  policies: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "Project.File" })
export type Info = typeof Info.Type

export type ParseResult =
  | { readonly ok: true; readonly info: Info; readonly raw: Record<string, unknown> }
  /**
   * ⚠️ A refusal, never a throw, and it names WHICH failure. "This file is from a newer NovaClaw"
   * and "this file is corrupt" call for opposite reactions from the reader — upgrade, or fix the
   * file — and a single `invalid` would send half of them to the wrong one.
   */
  | { readonly ok: false; readonly reason: "unreadable" | "not-an-object" | "future-version"; readonly detail: string }

// `onExcessProperty: "ignore"` is what lets an OLDER build read a NEWER file at all: unknown
// sections decode away rather than failing, and `parse` hands back the raw object so `merge` can put
// them back. Rejecting them here would make forward compatibility impossible by construction.
const decode = Schema.decodeUnknownResult(Info, { errors: "all", onExcessProperty: "ignore" })

/**
 * Read a `novaclaw.json`.
 *
 * Returns the decoded view AND the raw object, because the raw one is what makes an edit safe — see
 * {@link merge}.
 */
export function parse(text: string): ParseResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    return { ok: false, reason: "unreadable", detail: cause instanceof Error ? cause.message : String(cause) }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, reason: "not-an-object", detail: `expected an object, found ${Array.isArray(value) ? "an array" : typeof value}` }
  const raw = value as Record<string, unknown>
  const version = raw["version"]
  // 🔴 The version is checked BEFORE the shape. A file from a newer NovaClaw will often fail to
  // decode as well, and reporting that as a validation error tells the user their file is broken
  // when the truth is that their NovaClaw is old. Order decides which sentence they read.
  if (typeof version !== "number" || !Number.isInteger(version))
    return { ok: false, reason: "not-an-object", detail: "`version` is missing or is not an integer" }
  if (version > VERSION)
    return {
      ok: false,
      reason: "future-version",
      detail: `this file declares version ${version}; this NovaClaw understands up to ${VERSION}`,
    }
  const decoded = decode(raw)
  if (decoded._tag === "Failure")
    return { ok: false, reason: "not-an-object", detail: String(decoded.failure) }
  return { ok: true, info: decoded.success, raw }
}

/**
 * Apply `changes` to the file's raw object, preserving everything this build does not understand.
 *
 * 🔴 THE POINT OF THE RAW OBJECT. `todo/projects.md` requires that a newer file edited by an older
 * NovaClaw keeps its unknown fields. Serialising the DECODED view would silently delete every
 * section this build has no type for — the user edits one setting in the UI and loses the rest, with
 * no error anywhere. So an edit is a merge onto what was actually read.
 *
 * ⚠️ Top-level merge, deliberately. A deep merge cannot distinguish "leave this alone" from "empty
 * this list", so replacing a section wholesale is the only honest option for a caller that holds the
 * whole section anyway. A section this build does not know is never a key in `changes`, so it is
 * never touched.
 *
 * ⚠️ `undefined` REMOVES a key rather than writing `undefined`, which is not valid JSON. That is the
 * only way a caller can clear a section, and it must not silently do nothing.
 */
export function merge(raw: Record<string, unknown>, changes: Partial<Info>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw }
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next
}

/** Serialise for writing. Two-space indent and a trailing newline — a file people diff and commit. */
export function format(raw: Record<string, unknown>): string {
  return `${JSON.stringify(raw, null, 2)}\n`
}
