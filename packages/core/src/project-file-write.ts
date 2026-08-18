export * as ProjectFileWrite from "./project-file-write"

import path from "node:path"
import { Effect } from "effect"
import { ProjectFile } from "@novaclaw/schema/project-file"
import { FSUtil } from "./fs-util"
import { FILENAME } from "./project-file"

/**
 * Create or update a folder's `novaclaw.json`, replacing **only the sections supplied**.
 *
 * `todo/projects.md`: *"Write path: create or update `novaclaw.json`, replacing only the sections
 * supplied. Refuse when the existing file does not parse — an edit is a merge onto the raw object,
 * and there is none."*
 *
 * 🔴 **An edit is a merge onto the RAW object, never a re-serialisation of the decoded view.** The
 * decoded `ProjectFile.Info` is what THIS build understands; a file may carry sections a newer
 * NovaClaw wrote and this one has no type for, and `parse` decodes with `onExcessProperty: "ignore"`
 * precisely so an older build can still read one. Writing the decoded view back would delete every
 * such section silently — the user flips one switch in the Tuning panel and loses the rest, with no
 * error anywhere. `ProjectFile.merge` puts the change onto the bytes that were actually read, so a
 * field this build has never heard of survives an edit untouched.
 *
 * 🔴 **A file that does not parse is REFUSED, not repaired and not overwritten.** There is no raw
 * object to merge onto, so every possible write is a guess about what the user meant, and the two
 * plausible guesses — "start over" and "keep going" — differ by the whole content of their file.
 * The user's broken file is data. It is also the same posture the resolver takes: `walk` STOPS at an
 * invalid file rather than routing around it.
 *
 * ⚠️ **Write scope (AGENTS.md principle 11c).** The only path this module ever opens for writing is
 * `<directory>/novaclaw.json`, with `FILENAME` a module constant — there is no caller-supplied path
 * component, so no traversal is expressible. `directory` is the session's working/project folder,
 * which is one of the three places NovaClaw may write.
 */

/** The sections a write may supply. A key that is absent is LEFT ALONE; sections are replaced whole. */
export interface Changes {
  readonly name?: string
  readonly permissions?: ProjectFile.Info["permissions"]
  readonly tune?: ProjectFile.Tune
  readonly exclude?: readonly string[]
  readonly policies?: readonly string[]
}

/** Which top-level sections a write is allowed to name, in the order a receipt should list them. */
export const SECTIONS = ["name", "permissions", "tune", "exclude", "policies"] as const
export type Section = (typeof SECTIONS)[number]

export type Result =
  | {
      readonly ok: true
      readonly file: string
      /** `true` when there was no file before. The receipt says "created" rather than "updated". */
      readonly created: boolean
      /** The sections this write replaced. Everything else in the file is byte-identical in meaning. */
      readonly sections: readonly Section[]
      /**
       * Supervision switches the caller asked to record as `false` and which were NOT written.
       *
       * See `ProjectFile.writableTune`: absent means inherit, which is the honest encoding of "this
       * folder takes no position", and the read side would refuse the `false` anyway.
       */
      readonly refusedTune: readonly ProjectFile.TuneFeature[]
    }
  | {
      readonly ok: false
      readonly file: string
      /**
       * ⚠️ The first three are `ProjectFile.ParseResult`'s own reasons, deliberately spelled the
       * same. A surface already renders "this file is from a newer NovaClaw" differently from "this
       * file is corrupt", and a write that invented a fourth vocabulary for the identical condition
       * would make the two screens disagree about the same file.
       */
      readonly reason: "unreadable" | "not-an-object" | "future-version" | "would-not-parse" | "unwritable"
      readonly detail: string
    }

/**
 * Everything about a write except the filesystem, so the merge semantics are testable without one.
 *
 * `existing` is the file's current text, or `undefined` when there is no file. ⚠️ "There is no file"
 * and "I could not read the file" are NOT the same input and the caller must not collapse them —
 * see {@link write}, which checks existence before reading.
 */
export function plan(
  file: string,
  existing: string | undefined,
  changes: Changes,
):
  | { readonly ok: true; readonly text: string; readonly created: boolean; readonly sections: readonly Section[]; readonly refusedTune: readonly ProjectFile.TuneFeature[] }
  | (Result & { readonly ok: false }) {
  let raw: Record<string, unknown>
  const created = existing === undefined
  if (existing === undefined) {
    // A fresh file declares the version THIS build writes. Nothing else is invented — an empty
    // project is valid, and inventing a `name` from the folder is exactly what the schema forbids.
    raw = { version: ProjectFile.VERSION }
  } else {
    const parsed = ProjectFile.parse(existing)
    if (!parsed.ok) return { ok: false, file, reason: parsed.reason, detail: parsed.detail }
    raw = parsed.raw
  }

  const { tune, refused } = ProjectFile.writableTune(changes.tune)
  // Mutable, because `ProjectFile.Info`'s properties are `readonly` (Effect schema types are) and
  // this is the one place that assembles a change set key by key.
  const applied: { -readonly [K in keyof ProjectFile.Info]?: ProjectFile.Info[K] } = {}
  const sections: Section[] = []
  for (const section of SECTIONS) {
    if (!(section in changes)) continue
    if (changes[section] === undefined) continue
    sections.push(section)
    switch (section) {
      case "name":
        applied.name = changes.name
        break
      case "permissions":
        applied.permissions = changes.permissions
        break
      case "tune":
        applied.tune = tune
        break
      case "exclude":
        applied.exclude = changes.exclude
        break
      case "policies":
        applied.policies = changes.policies
        break
    }
  }

  const next = ProjectFile.merge(raw, applied)
  const text = ProjectFile.format(next)
  // ⚠️ The output is parsed before it is written. Nothing here is supposed to be able to produce a
  // file this build cannot read back, which is exactly why an unnoticed way to do it would be
  // expensive: the failure would land on the user as "your project file is broken" the next time
  // anything read it, pointing at a file NovaClaw wrote itself. Cheap to check, and it turns a
  // silent corruption into a refusal that still leaves the previous file intact.
  const verify = ProjectFile.parse(text)
  if (!verify.ok)
    return {
      ok: false,
      file,
      reason: "would-not-parse",
      detail: `the merged file would not read back (${verify.reason}: ${verify.detail})`,
    }
  return { ok: true, text, created, sections, refusedTune: refused }
}

/**
 * The same write against the real filesystem.
 *
 * ⚠️ Existence is checked BEFORE reading, and the order is load-bearing. `readFileStringSafe`
 * answers `undefined` both for "no such file" and for "exists but could not be read" (a permissions
 * problem, a directory in its place, a race with another writer). Treating the second as the first
 * would CREATE a file over one that is really there — destroying content because we could not see
 * it, which is the same class of mistake as overwriting a file that does not parse.
 */
export const write = Effect.fn("ProjectFileWrite.write")(function* (directory: string, changes: Changes) {
  const fs = yield* FSUtil.Service
  const file = path.join(path.resolve(directory), FILENAME)

  const exists = yield* fs.existsSafe(file)
  let existing: string | undefined
  if (exists) {
    existing = yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
    if (existing === undefined)
      return {
        ok: false as const,
        file,
        reason: "unreadable" as const,
        detail: "the file is there and could not be read",
      }
  }

  const planned = plan(file, existing, changes)
  if (!planned.ok) return planned

  // ⚠️ `writeWithDirs` writes the string verbatim — no newline translation — so the `\n` line
  // endings `ProjectFile.format` produces are what lands on disk on Windows too. A CRLF file is
  // invisible to `git status` under `text=auto` and only a source ledger ever notices.
  const failure = yield* fs.writeWithDirs(file, planned.text).pipe(
    Effect.match({
      onSuccess: () => undefined,
      onFailure: (error: Error) => error.message || String(error),
    }),
  )
  if (failure !== undefined) return { ok: false as const, file, reason: "unwritable" as const, detail: failure }

  return {
    ok: true as const,
    file,
    created: planned.created,
    sections: planned.sections,
    refusedTune: planned.refusedTune,
  } satisfies Result
})
