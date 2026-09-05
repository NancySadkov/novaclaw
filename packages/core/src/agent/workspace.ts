export * as AgentWorkspace from "./workspace"

import { Scratch } from "../scratch"
import type { SessionMessage } from "../session/message"
import { applySteerProvenance } from "../session/steer-provenance"

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
// chat follow the colleague is filed in `notes/named-agents.md`.

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
 * Whether a transcript has given the model anything back yet.
 *
 * A session's assistant row is created before generation starts, so the row's existence is not
 * enough: a cleared/new chat and an interrupted turn can both contain an assistant with no output.
 * Tool calls count as output once they have input or have advanced past pending; a compaction counts
 * because its summary is the durable replacement for earlier model output.
 */
export const hasModelOutput = (messages: readonly SessionMessage.Message[]): boolean =>
  messages.some(
    (message) =>
      message.type === "compaction" ||
      (message.type === "assistant" &&
        message.content.some((part) => {
          if (part.type === "text" || part.type === "reasoning") return part.text.trim().length > 0
          return part.state.status !== "pending" || part.state.input.trim().length > 0
        })),
  )

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
  applySteerProvenance(
    input.ownScratch
      ? `Your assignment changed: you are no longer on ${input.from}, and your folder is your own ` +
        `workspace (${input.to}) again. Your previous conversation has been filed and THIS chat starts ` +
        `fresh, rooted in ${input.to} — so everything you read or write here happens in the right ` +
        `place. Anything you were part-way through in the old chat is not yours to finish; say so if ` +
        `it matters, and wait for the next thing you are asked.`
      : `Your assignment changed: your folder is now ${input.to}, not ${input.from}. Your previous ` +
        `conversation has been filed and THIS chat starts fresh, rooted in ${input.to} — so the new ` +
        `project's files are the ones you will find here. Anything you were part-way through in the ` +
        `old chat is not yours to carry over; say so if it matters, and wait for the next thing you ` +
        `are asked.`,
  )
