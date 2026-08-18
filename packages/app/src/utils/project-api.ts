import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "./instance-fetch"

/**
 * What `novaclaw.json` governs the routed folder.
 *
 * `todo/projects.md`: *"Never make a person infer project state from a hidden dotfile."* A project
 * file can NARROW a session's permissions, so a user whose tool call was refused needs somewhere to
 * see which file did it.
 */
export type ProjectState =
  | {
      readonly kind: "project"
      readonly root: string
      readonly file: string
      readonly name?: string
      /** How many permission rules the file contributes; the rules themselves live on that surface. */
      readonly permissionRules: number
      readonly exclude: readonly string[]
    }
  /**
   * Found and unusable. ⚠️ Carried through rather than collapsed into `none`: "there is no project
   * here" and "your project file is broken" are the two answers a user acts on differently, and
   * `future-version` means *upgrade* where `unreadable` means *fix the file*.
   */
  | { readonly kind: "invalid"; readonly file: string; readonly reason: string; readonly detail: string }
  | { readonly kind: "none" }

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
  readonly tune?: { readonly mode?: "interactive"; readonly features?: ProjectTuneFeatures }
  readonly exclude?: readonly string[]
  readonly policies?: readonly string[]
}

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
      /**
       * Supervision switches asked for as OFF and dropped instead: a folder may raise a safety rail,
       * never lower one. Absent in the file means inherit, which is what those switches now do.
       */
      readonly refusedTune: readonly string[]
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
