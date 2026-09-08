import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "./instance-fetch"

/**
 * What `novaclaw.json` governs the routed folder.
 *
 * The rule: *"never make a person infer project state from a hidden dotfile."* A project
 * file can NARROW a session's permissions, so a user whose tool call was refused needs somewhere to
 * see which file did it.
 */
export type ProjectState =
  | {
      readonly kind: "project"
      readonly root: string
      readonly file: string
      readonly name?: string
      /** How many permission rules the file contributes. For the chips, which want a number. */
      readonly permissionRules: number
      /**
       * The rules themselves, verbatim and in file order.
       *
       * ⚠️ The route used to carry only the count, on the reasoning that another surface rendered
       * the rules. None did. Settings → Project is that surface now, and it needs to be able to
       * point at the ONE rule that refused a tool call rather than at a total.
       */
      readonly permissions: readonly ProjectPermissionRule[]
      readonly exclude: readonly string[]
      /**
       * Skill ids this folder hides from your own slash menu, sorted.
       *
       * ⚠️ Already narrowed by the server: a folder may HIDE a skill and may never un-hide one you
       * hid, so this is a list of what the folder hides and never a list of what it wants shown.
       */
      readonly skills: readonly string[]
      /**
       * Skill ids the folder asked to SHOW, which NovaClaw does not act on.
       *
       * Not an error — the file is valid and every other section is honoured. It is reported so the
       * person who wrote the line is told it does nothing, rather than discovering it by surprise.
       */
      readonly skillsRefused: readonly string[]
      /**
       * The stance a chat CREATED IN THIS FOLDER would start with — the folder's tune, folded by
       * the kernel.
       *
       * 🔴 **Render it; never re-derive it.** A folder may raise a supervision switch and may never
       * lower one (`narrowTune`), and only some components are wired to fold at all. Both rules are
       * applied server-side, with the instance's ceilings on top. `config-provenance.ts` records the
       * run where a browser-side re-derivation of this produced toggles that were the exact inverse
       * of what the runner resolved.
       *
       * ⚠️ Optional on the type, not on the wire: an older instance answers without it, and a draft
       * must then fall back to saying nothing rather than to saying "off".
       */
      readonly tune?: ProjectTuneStance
      /**
       * What importing the project root's `.gitignore` WOULD add. A suggestion, never a sync.
       *
       * ⚠️ Absent when there is no `.gitignore` beside the project file. "Nothing to import" and
       * "no file to import from" are different sentences, and this is what tells them apart.
       */
      readonly gitignore?: ProjectGitignoreProposal
    }
  /**
   * Found and unusable. ⚠️ Carried through rather than collapsed into `none`: "there is no project
   * here" and "your project file is broken" are the two answers a user acts on differently, and
   * `future-version` means *upgrade* where `unreadable` means *fix the file*.
   */
  | { readonly kind: "invalid"; readonly file: string; readonly reason: string; readonly detail: string }
  | { readonly kind: "none" }

/**
 * What a folder alone decides about a chat's switches, as the kernel folded it.
 *
 * `applied` is `features`' key set, restated so a reader never has to decide what an absent key
 * means; `refused` and `deferred` are what the file asked for and did not get, carried so a surface
 * can SAY so rather than leaving a line in someone's file that silently does nothing.
 */
export interface ProjectTuneStance {
  readonly features: Readonly<Record<string, boolean>>
  readonly applied: readonly string[]
  readonly refused: readonly string[]
  readonly deferred: readonly string[]
}

/** One ordered permission rule as a `novaclaw.json` carries it. */
export interface ProjectPermissionRule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

/**
 * What a `.gitignore` import would contribute, already screened by the matcher that enforces it.
 *
 * 🔴 The product distinction this type exists to keep visible: a `.gitignore` says what should not
 * be COMMITTED; `exclude` says what a model must never READ. They overlap and they disagree, so
 * this is a proposal a person confirms — not a list that syncs.
 */
export interface ProjectGitignoreProposal {
  /** The file it was read from, so the suggestion names its source. */
  readonly file: string
  /** Patterns not already present, in file order. */
  readonly add: readonly string[]
  /** Lines already in `exclude` — why an import can offer nothing and still be working. */
  readonly already: readonly string[]
  /** Lines this build cannot honour, with the reason, reported rather than skipped in silence. */
  readonly dropped: readonly { readonly source: string; readonly reason: string }[]
  /** The `!` lines among `add`. Appending one can UNDO an exclusion the user wrote by hand. */
  readonly reincludes: readonly string[]
}

export function projectState(server: ServerConnection.HttpBase, directory: string, signal?: AbortSignal) {
  // The header channel, because that is the one this route was verified through end to end
  // (`httpapi-project.test.ts` drives it with `x-novaclaw-directory`). A caller that picks the other
  // spelling gets a 400 from a server that cannot see its directory.
  return instanceFetch<ProjectState>(server, { route: "api/project", directory, directoryVia: "header", signal })
}

/** The switches a `novaclaw.json` may declare. Absent = inherit; it is never "off". */
export type ProjectTuneFeatures = Partial<
  Record<
    "safeMode" | "askBeforeChanges" | "surgicalEdits" | "contextBudget" | "memory" | "introspection" | "quality" | "affective",
    boolean
  >
>

/**
 * What a write supplies. **An absent section is LEFT ALONE; a supplied one is replaced whole.**
 *
 * ⚠️ This is not a whole `novaclaw.json`. The server merges onto the file's raw object so that
 * sections this build has never heard of survive an edit — sending a document would be the write
 * that silently deletes them.
 */
export interface ProjectWriteInput {
  readonly name?: string
  /**
   * The folder's ordered permission rules, replacing the section whole.
   *
   * ⚠️ An `allow` rule is DROPPED by the server and reported in `refusedPermissions`. A project's
   * ruleset is applied as a narrowing constraint, so an `allow` can never change a verdict — saving
   * one would write a grant into the user's file that the reader provably ignores. Same shape as
   * `refusedTune` on the Tune half.
   */
  readonly permissions?: readonly ProjectPermissionRule[]
  readonly tune?: { readonly mode?: "interactive"; readonly features?: ProjectTuneFeatures }
  readonly exclude?: readonly string[]
  /**
   * The installed pre-action policies this folder opts INTO, by id.
   *
   * ⚠️ An entry that is not id-shaped is DROPPED by the server and reported in `refusedPolicies`: a
   * `novaclaw.json` names a policy and can never carry a command. Everything else is written —
   * naming a policy is opting IN, which a folder may do; what it cannot do, and has no spelling for,
   * is switch an installed policy off.
   */
  readonly policies?: readonly string[]
  /**
   * Per-skill slash-menu choices for this folder, keyed by the skill's name verbatim.
   *
   * ⚠️ A `show:true` is DROPPED by the server and reported in `refusedSkills`, for the same reason
   * an `allow` permission rule is: a folder may hide a skill and may never un-hide one you hid, so
   * the reader ignores it and saving one would write a sentence into your file that does nothing.
   */
  readonly skills?: Readonly<Record<string, { readonly show?: boolean }>>
  /**
   * Sections to REMOVE from the file — the other half of "an absent section is left alone".
   *
   * Without this there is no way to say *"this folder declares no permission rules any more"*: an
   * absent key means "leave it", and an empty array means "declare an empty list", which is not the
   * same statement. Naming a section here AND supplying it above is refused as `contradictory`.
   */
  readonly clear?: readonly ProjectSection[]
}

/** The top-level sections of a `novaclaw.json` that a write may replace or clear. */
export type ProjectSection = "name" | "permissions" | "tune" | "exclude" | "policies" | "skills"

/**
 * The receipt, or the refusal.
 *
 * ⚠️ A refusal is a 200 body, not an HTTP error, so it never reaches the caller as a thrown
 * `InstanceFetchError`. A broken `novaclaw.json` is something the user fixes with the detail in
 * front of them — the same posture `projectState` takes with `kind: "invalid"` — and turning it into
 * a red "request failed" toast would replace an explanation with a dead end.
 */
export type ProjectWriteResult =
  | {
      readonly ok: true
      readonly file: string
      /** `true` when there was no file before — say "created", not "updated". */
      readonly created: boolean
      /** The sections this write replaced. */
      readonly sections: readonly string[]
      /** The sections this write REMOVED. Disjoint from `sections`; asking for both is refused. */
      readonly cleared: readonly string[]
      /**
       * Supervision switches asked for as OFF and dropped instead: a folder may raise a safety rail,
       * never lower one. Absent in the file means inherit, which is what those switches now do.
       */
      readonly refusedTune: readonly string[]
      /**
       * Permission rules asked for and dropped instead: a folder may only ever NARROW, and an
       * `allow` rule can never narrow anything. Reported so the surface says it out loud.
       */
      readonly refusedPermissions: readonly ProjectPermissionRule[]
      /**
       * Skill ids asked for as SHOWN here and dropped instead: a folder may only ever hide.
       * Reported so the surface says it out loud rather than writing an inert line.
       */
      readonly refusedSkills: readonly string[]
      /**
       * Policy ids asked for and dropped instead: an entry that is not id-shaped. The grammar is
       * what keeps a command out of a `novaclaw.json`, and one bad entry would otherwise make the
       * whole file unreadable rather than the one line unwritable.
       */
      readonly refusedPolicies: readonly string[]
    }
  | { readonly ok: false; readonly file: string; readonly reason: string; readonly detail: string }

/** Create or update `<directory>/novaclaw.json`, replacing only the sections supplied. */
export function projectWrite(
  server: ServerConnection.HttpBase,
  directory: string,
  input: ProjectWriteInput,
  signal?: AbortSignal,
) {
  return instanceFetch<ProjectWriteResult>(server, {
    method: "POST",
    route: "api/project",
    directory,
    directoryVia: "header",
    body: input,
    signal,
  })
}
