export * as ProjectFileWrite from "./project-file-write"

import path from "node:path"
import { Effect } from "effect"
import { Permission } from "@novaclaw/schema/permission"
import { ProjectFile } from "@novaclaw/schema/project-file"
import { FSUtil } from "./fs-util"
import { FILENAME } from "./project-file"

/**
 * Create or update a folder's `novaclaw.json`, replacing **only the sections supplied**.
 *
 * The contract: *"write path: create or update `novaclaw.json`, replacing only the sections
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
  /**
   * The installed pre-action policies this folder opts INTO, by id.
   *
   * ⚠️ Only an ID survives the write — see {@link writablePolicies}. A command-shaped entry is
   * dropped and reported in `refusedPolicies` rather than written into a file whose reader would
   * then refuse the whole document.
   */
  readonly policies?: readonly string[]
  /**
   * Per-skill slash-menu choices for this folder.
   *
   * ⚠️ Only `show:false` survives the write — see `ProjectFile.writableSkills`. A folder may hide a
   * skill and may never un-hide one the instance hid, so a `show:true` here is dropped and reported
   * in `refusedSkills` rather than written into a file whose reader is guaranteed to ignore it.
   */
  readonly skills?: ProjectFile.Skills
  /**
   * Sections to REMOVE from the file entirely.
   *
   * 🔴 **Why an explicit list and not `undefined`.** `ProjectFile.merge` already deletes a key whose
   * value is `undefined`, and that is the whole mechanism — but nothing could reach it from a
   * client, because `Schema.optional` makes "absent" and "sent as undefined" the same bytes on the
   * wire. So *"remove all of this folder's permission rules"* was not expressible at all, and the
   * two plausible spellings are both worse than this one: overloading `permissions: []` would mean
   * a folder could never declare an empty-but-present section, and a `null` per section would make
   * every field a three-state union that every future reader has to think about.
   *
   * A separate list keeps "replace" and "remove" as two different sentences, which is what they are.
   *
   * ⚠️ Naming a section here AND supplying it is a CONTRADICTION and is refused without writing —
   * see {@link plan}. Silently letting one win would make a client bug land as a file the user did
   * not ask for, and the two orders ("clear then set" / "set then clear") give opposite results.
   */
  readonly clear?: readonly Section[]
}

/**
 * Which top-level sections a write is allowed to name, in the order a receipt should list them.
 *
 * ⚠️ Re-exported from `@novaclaw/schema/project-file` rather than declared here. The HTTP payload
 * needs the same list as a `Schema.Literals`, and a second copy in this file is exactly the drift a
 * `clear` list cannot afford: a section missing from one of them would be silently unremovable.
 */
export const SECTIONS = ProjectFile.SECTIONS
export type Section = ProjectFile.Section

export type Result =
  | {
      readonly ok: true
      readonly file: string
      /** `true` when there was no file before. The receipt says "created" rather than "updated". */
      readonly created: boolean
      /** The sections this write replaced. Everything else in the file is byte-identical in meaning. */
      readonly sections: readonly Section[]
      /**
       * The sections this write REMOVED. Disjoint from `sections` by construction — supplying and
       * clearing the same section is refused rather than resolved.
       */
      readonly cleared: readonly Section[]
      /**
       * Supervision switches the caller asked to record as `false` and which were NOT written.
       *
       * See `ProjectFile.writableTune`: absent means inherit, which is the honest encoding of "this
       * folder takes no position", and the read side would refuse the `false` anyway.
       */
      readonly refusedTune: readonly ProjectFile.TuneFeature[]
      /**
       * Permission rules the caller asked to record and which were NOT written.
       *
       * See `ProjectFile.writablePermissions`: a project ruleset is folded in as a NARROWING
       * constraint, so an `allow` rule can never change a verdict. Writing one would put a sentence
       * in the user's file that the reader provably ignores.
       */
      readonly refusedPermissions: Permission.Ruleset
      /**
       * Skill ids the caller asked to record as SHOWN in this folder, which were NOT written.
       *
       * See `ProjectFile.writableSkills`: a project may hide a skill and may never un-hide one the
       * instance hid, so `ProjectFile.narrowSkills` drops a `show:true` on every read. Writing one
       * would put a sentence in the user's file that the reader provably ignores.
       */
      readonly refusedSkills: readonly string[]
      /**
       * Policy ids the caller asked to record, which were NOT written.
       *
       * See {@link writablePolicies}: an entry that is not id-shaped would make the whole FILE fail
       * to parse, so it is dropped rather than allowed to fail the save. Reported in the caller's own
       * order so a surface can name what did not land.
       */
      readonly refusedPolicies: readonly string[]
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
      readonly reason:
        | "unreadable"
        | "not-an-object"
        | "future-version"
        | "would-not-parse"
        | "unwritable"
        /** A section was both supplied and named in `clear`. See {@link Changes.clear}. */
        | "contradictory"
      readonly detail: string
    }

/**
 * The `policies` section a WRITE may record — the fourth twin of {@link ProjectFile.writableTune},
 * `writablePermissions` and `writableSkills`.
 *
 * 🔴 **The one property this enforces: a `novaclaw.json` names a policy by ID and may NEVER carry a
 * command.** The grammar (`ProjectFile.POLICY_ID_PATTERN`) makes a command unspellable, and a
 * violating entry makes the WHOLE FILE fail to parse — deliberately, because a file trying to carry
 * a command is not one to act on any part of. That is right for a file we READ and wrong as the
 * answer to a write: `plan` re-parses its own output, so one command-shaped entry would come back as
 * `would-not-parse` — a refusal whose copy says *"your novaclaw.json is broken"* about a file that is
 * perfectly fine, and which takes every other edit in the same save down with it. So it is dropped
 * and REPORTED, exactly as an `allow` rule is, and the rest of the write lands.
 *
 * ⚠️ **An ALWAYS-ON id is written, and an earlier version of this function refused it. That was
 * wrong and the reasoning is worth keeping, because it looked right.** The argument was: the gate's
 * filter is `alwaysOn(provider) || wanted.has(provider.id)`, so naming an always-on policy cannot
 * turn it on; and the one path where it is NOT inert — `screen` refuses every tool call in a folder
 * whose file names a policy the user switched OFF — is a folder overruling an instance-level switch.
 *
 * Two things break that. First, `config.ts`'s sentence PERMITS it: *"a folder's novaclaw.json may
 * opt IN to an installed policy; only this key can switch one off."* Naming an always-on policy is
 * opting in; what the folder still cannot do is switch one off, and no spelling for that exists.
 * Second, and decisively: `ToolPolicy.alwaysOn` is `provider.alwaysOn !== false`, so always-on is the
 * DEFAULT and neither shipped policy opts out — under that rule this section could never write an id
 * that names anything installed, which is a write surface that cannot write.
 *
 * ⭐ And the behaviour it enables is the SAFE direction: the folder is saying *"never run me
 * unpoliced"*. If the user later switches that policy off, every tool call in the folder is refused
 * with a message naming the file. It cannot make the folder run anything the user forbade; it can
 * only decline to run at all.
 *
 * ⚠️ **An id nothing here installs is written too**, and that is the same judgement one step further
 * out: the file travels, so an id installed on a colleague's machine is a legitimate declaration, and
 * dropping it would mean that editing one entry silently deletes another person's. The surface says
 * what it costs — every tool call in this folder is refused until that policy is installed — BEFORE
 * the control rather than in a receipt afterwards.
 *
 * ⚠️ **Not the enforcement**, for the reason all three twins state about themselves: an attacker's
 * `novaclaw.json` never goes through our writer. `ProjectFile.parse` refuses a command-carrying file
 * on every read, including files this build never wrote. This is a truthfulness rule for our output.
 *
 * ⚠️ Duplicates collapse to their first occurrence. `screen` builds a `Set` from the list, so a
 * repeat is already nothing to the reader; leaving one in the file makes every surface that lists the
 * section say one name twice.
 *
 * @param declared the ids the caller asked to record, in its own order
 */
export function writablePolicies(declared: readonly string[] | undefined): {
  readonly policies: readonly string[] | undefined
  readonly refused: readonly string[]
} {
  if (!declared) return { policies: undefined, refused: [] }
  const policies: string[] = []
  const refused: string[] = []
  const seen = new Set<string>()
  for (const id of declared) {
    if (!ProjectFile.POLICY_ID_PATTERN.test(id)) {
      // Reported once even if the caller repeated it — a receipt naming one id twice reads as two
      // separate refusals.
      if (!refused.includes(id)) refused.push(id)
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    policies.push(id)
  }
  // An empty result is written as `[]` rather than dropped, exactly as `writableTune` writes an
  // empty `features`: the caller SUPPLIED the section and the receipt has to stay honest about which
  // sections the write touched. Removing it is a different sentence — {@link Changes.clear}.
  return { policies, refused }
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
  | {
      readonly ok: true
      readonly text: string
      readonly created: boolean
      readonly sections: readonly Section[]
      readonly cleared: readonly Section[]
      readonly refusedTune: readonly ProjectFile.TuneFeature[]
      readonly refusedPermissions: Permission.Ruleset
      readonly refusedSkills: readonly string[]
      readonly refusedPolicies: readonly string[]
    }
  | (Result & { readonly ok: false }) {
  // ⚠️ Checked BEFORE the file is even read, because a contradiction is a fault in the REQUEST and
  // says nothing about the file. Reporting "your novaclaw.json is broken" for a caller that asked
  // to both set and clear one section would point the user at the wrong thing entirely.
  const clear = changes.clear ?? []
  const contradictory = clear.filter((section) => section in changes && changes[section] !== undefined)
  if (contradictory.length > 0)
    return {
      ok: false,
      file,
      reason: "contradictory",
      detail: `asked to both replace and remove: ${contradictory.join(", ")}`,
    }

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
  const { permissions, refused: refusedPermissions } = ProjectFile.writablePermissions(changes.permissions)
  const { skills, refused: refusedSkills } = ProjectFile.writableSkills(changes.skills)
  const { policies, refused: refusedPolicies } = writablePolicies(changes.policies)
  // Mutable, because `ProjectFile.Info`'s properties are `readonly` (Effect schema types are) and
  // this is the one place that assembles a change set key by key.
  const applied: { -readonly [K in keyof ProjectFile.Info]?: ProjectFile.Info[K] } = {}
  const sections: Section[] = []
  const cleared: Section[] = []
  for (const section of SECTIONS) {
    // A removal is an `undefined` value in the change set — `ProjectFile.merge` deletes the key
    // rather than writing `undefined`, which is not valid JSON. The two loops are ONE loop so the
    // receipt's ordering matches `SECTIONS` for both lists.
    if (clear.includes(section)) {
      cleared.push(section)
      applied[section] = undefined
      continue
    }
    if (!(section in changes)) continue
    if (changes[section] === undefined) continue
    sections.push(section)
    switch (section) {
      case "name":
        applied.name = changes.name
        break
      case "permissions":
        applied.permissions = permissions
        break
      case "tune":
        applied.tune = tune
        break
      case "exclude":
        applied.exclude = changes.exclude
        break
      case "policies":
        applied.policies = policies
        break
      case "skills":
        applied.skills = skills
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
  return {
    ok: true,
    text,
    created,
    sections,
    cleared,
    refusedTune: refused,
    refusedPermissions,
    refusedSkills,
    refusedPolicies,
  }
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
export const write = Effect.fn("ProjectFileWrite.write")(function* (
  directory: string,
  changes: Changes,
) {
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
    cleared: planned.cleared,
    refusedTune: planned.refusedTune,
    refusedPermissions: planned.refusedPermissions,
    refusedSkills: planned.refusedSkills,
    refusedPolicies: planned.refusedPolicies,
  } satisfies Result
})
