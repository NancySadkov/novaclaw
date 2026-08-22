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
//
// 🔴 **AND THE EXISTING CHAT DOES NOT MOVE, which the notice used to deny.** Measured 2026-08-22: a
// colleague reassigned from `folderA` to `folderB` was told *"you now work on folderB, not folderA"*
// while its session's `location.directory` stayed `folderA` — so every tool call it made would still
// land in the old folder while it believed otherwise. Worse than silence: it would look for the new
// project's files where they are not and conclude the project is empty.
//
// Repointing a live session across PROJECTS is not a supported operation — `control-plane/move-session.ts`
// refuses it outright (`DestinationProjectMismatchError`); it moves a session between worktrees of one
// project, not between projects. So the notice now says what is true: the assignment changed, this
// conversation did not, and the way to start work on the new folder is to clear the chat. Making the
// chat follow the colleague is filed in `todo/named-agents.md`.

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
  /**
   * Where THIS chat actually runs, read from the session.
   *
   * ⚠️ **Not `from`.** `from` is the config's previous value, and the two diverge the moment a
   * colleague is reassigned twice: the chat is still rooted wherever it was CREATED, while `from`
   * has moved on. Measured 2026-08-22 — the second reassignment told a colleague it was rooted in
   * the folder it had just been moved off, which is the same false statement this notice was
   * rewritten to remove, one level deeper.
   */
  readonly rooted: string
}): string =>
  input.ownScratch
    ? `You have been reassigned: you are no longer on ${input.from}, and your folder is your own ` +
      `workspace (${input.to}) again. ⚠️ THIS conversation is still rooted in ${input.rooted}, so every ` +
      `file you read or write here still happens there. Anything you were part-way through is not ` +
      `yours to finish — say so if it matters, and wait for the next thing you are asked.`
    : `You have been reassigned: your folder is now ${input.to}, not ${input.from}. ⚠️ THIS ` +
      `conversation is still rooted in ${input.rooted}, so every file you read or write here still ` +
      `happens there — you cannot work on ${input.to} in this chat. Do not go looking for the new ` +
      `project's files; you will not find them and the folder will look empty or wrong. Say what you ` +
      `were part-way through, and tell the user to clear this chat so your next one starts in ` +
      `${input.to}.`
