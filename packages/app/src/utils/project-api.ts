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
