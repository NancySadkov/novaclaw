export * as AgentWorkspace from "./workspace"

import { Scratch } from "../scratch"

// WHERE a colleague works, and what happens when you move it (owner, 2026-08-21).
//
// 🔴 **The folder belongs to the COLLEAGUE, not to a chat.** The prompt area used to ask which folder
// a new chat should run in, which made "where does this work happen" a question the user answered
// again every time — and left a named officer with no project of its own. Under the roster it is part
// of the job: you assign the bookkeeper to the books once, and it stays there.
//
// ⚠️ **Reassignment MESSAGES the colleague.** A model whose folder changed under it goes on describing
// the project it was moved off — its system prompt still names the old one, its plan still refers to
// files that are no longer under it, and nothing in a fresh turn says otherwise. Being interrupted is
// cheaper than being confidently wrong about where you are.

/** Where a colleague works: its configured folder, or its own scratch when it has none. */
export const folderFor = (input: {
  readonly agentID: string
  readonly directory: string | undefined
}): string => {
  const configured = input.directory?.trim()
  return configured ? configured : Scratch.forAgent(input.agentID)
}

/** Is this colleague working in its own scratch rather than a project the user chose? */
export const isOwnScratch = (input: { readonly agentID: string; readonly directory: string | undefined }): boolean =>
  folderFor(input) === Scratch.forAgent(input.agentID)

/**
 * Did the folder actually change? Compared as TRIMMED strings, with "unset" and "the scratch path
 * spelled out" treated as the same place — a user who picks the scratch folder explicitly has not
 * moved the colleague anywhere, and telling it so would be a message about nothing.
 */
export const moved = (input: {
  readonly agentID: string
  readonly from: string | undefined
  readonly to: string | undefined
}): boolean =>
  folderFor({ agentID: input.agentID, directory: input.from }) !==
  folderFor({ agentID: input.agentID, directory: input.to })

/**
 * What the colleague is told when its folder changes.
 *
 * ⚠️ Written as an instruction about the WORLD, not as a task. "You have been moved" invites a model
 * to do something about it; what it needs is the fact plus permission to carry on. It names both
 * ends, because a colleague that knows only where it is now cannot tell which half of its plan is
 * stale.
 */
export const reassignmentNotice = (input: {
  readonly from: string
  readonly to: string
  readonly ownScratch: boolean
}): string =>
  input.ownScratch
    ? `Your working folder has changed: you are no longer on ${input.from}, and are back in your own ` +
      `workspace (${input.to}). Anything you were part-way through in the old folder is not yours to ` +
      `finish any more — say so if it matters, and wait for the next thing you are asked.`
    : `Your working folder has changed: you now work on ${input.to}, not ${input.from}. Treat anything ` +
      `you remember about the old folder's files as out of date — it may not exist here. If you were ` +
      `part-way through something there, say so rather than continuing it against the new project.`
