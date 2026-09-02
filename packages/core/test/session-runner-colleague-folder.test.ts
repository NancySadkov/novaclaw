import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { AgentWorkspace } from "@novaclaw/core/agent/workspace"
import { Database } from "@novaclaw/core/database/database"
import { Scratch } from "@novaclaw/core/scratch"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { SessionTable } from "@novaclaw/core/session/sql"
import { HARNESS_SESSION, completeTurn, drive, isHarnessInjected, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * DOES A COLLEAGUE WITH A STORED FOLDER GET TOLD WHERE IT IS?
 *
 * 🔴 The claim under test is a JOIN, and it is the half nobody had observed. `session-runner-grounding.test.ts`
 * proves the runner emits a location horizon on the first turn and not on the second — with the
 * harness's own `/project`, which no colleague ever chose. `agent-workspace.test.ts` proves
 * `AgentWorkspace.folderFor` picks a colleague's project or its scratch. Between them sits the thing
 * that actually matters to a user who assigned a folder in the agent-config dialog: **that the
 * message the model reads names THAT folder and lists what is in it.**
 *
 * `packages/server/src/handlers/session-agent-location.test.ts` closes the other end — a
 * `session.create` naming a colleague and no location files the chat at `folderFor(...)`. This file
 * starts from the same function's output and follows it to the provider request. The two meet at
 * `folderFor`, which is the ONE definition of where a colleague works.
 *
 * ⚠️ **THE PAIR IS THE PROOF.** A runner that hard-coded any single folder into the grounding
 * message would satisfy either case alone. So the assigned colleague and the unassigned one are
 * driven separately and their messages must name DIFFERENT folders — and each must enumerate the
 * file that only its own folder holds.
 *
 * ⚠️ **Three postures, three different answers, and only one of them is guessable from the source.**
 * The cadence's `enabled` line reads `!strictEnabled && !ShortChat.enabled(...)`, which invites the
 * conclusion that Strict and Fast Chat are both blind. Measured, they are not the same case at all:
 * Strict supplies its own, richer horizon (the step prompt inlines the folder's files), while Fast
 * Chat is told nothing anywhere in the request. The last two cases record that, each with the
 * control that makes it a measurement rather than a reading.
 *
 * ⚠️ **What this file does NOT claim.** Whether the model then *behaves* correctly — reads and
 * writes in that folder rather than wandering to its scratch — needs a turn against the one Spark
 * test model, and no scripted provider can stand in for it. This is the harness half: the horizon is
 * delivered, and it is the right horizon.
 */

// ⚠️ Read on EVERY call by `Scratch.root()` rather than captured at import, so setting it here is
// enough to keep a colleague's derived workspace out of the developer's instance data.
//
// ⚠️ **And put back afterwards, because `process.env` is the whole PROCESS.** The gate runs a unit's
// files in one bun process, so a variable set at module scope and left there is not this file's
// isolation, it is every later file's environment — and `Scratch.root()` is the kind of thing that
// fails somewhere else entirely and gets blamed on whatever changed that day.
const PREVIOUS_SCRATCH_ROOT = process.env["NOVACLAW_SCRATCH_ROOT"]
const SCRATCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "novaclaw-colleague-folder-"))
process.env["NOVACLAW_SCRATCH_ROOT"] = SCRATCH_ROOT
afterAll(() => {
  if (PREVIOUS_SCRATCH_ROOT === undefined) delete process.env["NOVACLAW_SCRATCH_ROOT"]
  else process.env["NOVACLAW_SCRATCH_ROOT"] = PREVIOUS_SCRATCH_ROOT
})

/** The colleague the user pointed at a project through the folder picker. */
const ASSIGNED = "daedalus"
/** The colleague nobody pointed anywhere — the ordinary state of a fresh hire. */
const UNASSIGNED = "myron"

/** A real project folder on disk, with one distinctive file in it. */
const ASSIGNED_PROJECT = fs.mkdtempSync(path.join(os.tmpdir(), "novaclaw-colleague-project-"))
fs.writeFileSync(path.join(ASSIGNED_PROJECT, "ledger.md"), "the books\n")

/** The unassigned colleague's own workspace, with a different distinctive file. */
const UNASSIGNED_SCRATCH = Scratch.forAgent(UNASSIGNED)
fs.mkdirSync(UNASSIGNED_SCRATCH, { recursive: true })
fs.writeFileSync(path.join(UNASSIGNED_SCRATCH, "sketch.txt"), "notes\n")

/**
 * Where the chat runs, derived by the SAME function the server's create uses. Typing the path out
 * here instead would make the file agree with itself rather than with the product.
 */
const folderOf = (agentID: string, directory: string | undefined) =>
  AbsolutePath.make(AgentWorkspace.folderFor({ agentID, directory }))

/**
 * Seed a colleague, point the harness session at it, take one turn, and return what the runner
 * injected into the provider request.
 *
 * `directory` is what the agent-config dialog stored (or `undefined` for a colleague with no
 * project); the harness's location and the session row both come from `folderOf`, which is exactly
 * the invariant `session.create` establishes and `runner/llm.ts` then re-checks before it will run a
 * turn at all (*"Not ours"* — a session whose directory differs from the node's is refused).
 */
const groundingFor = async (input: {
  readonly agentID: string
  readonly directory: string | undefined
  readonly shortChat?: boolean
  readonly strict?: boolean
}) => {
  const harness = makeRunnerHarness({
    turns: [completeTurn("t1", "One")],
    directory: folderOf(input.agentID, input.directory),
  })

  await drive(
    harness,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make(input.agentID), (agent) => {
          agent.name = input.agentID
          agent.mode = "primary"
          if (input.directory !== undefined) agent.directory = input.directory
        }),
      )
      yield* db
        .update(SessionTable)
        .set({
          agent: input.agentID,
          ...(input.shortChat === undefined ? {} : { short_chat: input.shortChat }),
          ...(input.strict === undefined ? {} : { strict: { enabled: input.strict } }),
        })
        .where(eq(SessionTable.id, HARNESS_SESSION))
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
      yield* session.resume(HARNESS_SESSION)
    }),
    `colleague folder — ${input.agentID}`,
  )

  const injected = (harness.requests[0]?.messages ?? []).filter(isHarnessInjected)
  /** Every word the provider was sent, across every request of the drive — system parts included. */
  const everything = harness.requests
    .flatMap((request) => [
      ...(request.system ?? []).map((part) => part.text),
      ...request.messages.flatMap((message) =>
        message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
      ),
    ])
    .join("\n")
  return {
    requests: harness.requests.length,
    injected: injected.length,
    text: injected
      .flatMap((message) => message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])))
      .join("\n"),
    everything,
  }
}

describe("the folder a colleague was assigned is the folder its turn is grounded in", () => {
  test("🔴 the assigned project is named AND enumerated — and the unassigned colleague gets its own scratch instead", async () => {
    const assigned = await groundingFor({ agentID: ASSIGNED, directory: ASSIGNED_PROJECT })
    const unassigned = await groundingFor({ agentID: UNASSIGNED, directory: undefined })

    expect(
      assigned.text,
      "the first turn for a colleague with a stored folder did not name that folder — the model is left to infer a cwd it was never given, which is the failure `project-grounding.ts` exists for",
    ).toContain(`Current working folder: ${ASSIGNED_PROJECT}`)
    expect(
      unassigned.text,
      "a colleague with no project was not grounded in its own workspace",
    ).toContain(`Current working folder: ${UNASSIGNED_SCRATCH}`)

    // The CONTENTS, not just the path. This is the half that converted on a real model: asked about
    // the files in its folder, the model invented a filename from the folder's own name rather than
    // listing it. A message naming the right folder while listing the wrong one is the same defect
    // with better manners.
    expect(assigned.text, "the grounding listing did not enumerate the assigned project").toContain("ledger.md")
    expect(unassigned.text, "the grounding listing did not enumerate the colleague's own workspace").toContain(
      "sketch.txt",
    )

    // 🔴 THE PAIR. Either assertion above passes on a runner that grounds every chat in one fixed
    // folder; these are what make the claim discriminating.
    expect(assigned.text, "the assigned colleague was grounded in the OTHER colleague's workspace").not.toContain(
      "sketch.txt",
    )
    expect(unassigned.text, "the unassigned colleague was grounded in the assigned project").not.toContain("ledger.md")
    expect(unassigned.text).not.toContain(ASSIGNED_PROJECT)
  })

  /**
   * 🔴 **FAST CHAT IS NEVER TOLD WHERE IT IS — AT ALL.** Measured over the whole request, not read
   * off the `enabled` line.
   *
   * `runner/llm.ts` builds the decision with `enabled: !strictEnabled && !ShortChat.enabled(...)`, so
   * the cadence is off in Fast Chat. The question that decides whether that matters is whether
   * anything ELSE supplies the horizon, and nothing does: `system-context/builtins.ts` leaves the
   * working folder out of `<env>` **on purpose** — *"the working folder/project horizon is
   * deliberately NOT frozen into this baseline"* — precisely because the grounding cadence was meant
   * to own it. Two mechanisms each correctly deferring to the other is how a horizon goes missing.
   *
   * So this is asserted over EVERY system part and EVERY message of the turn: the assigned folder's
   * path does not appear, its contents do not appear, and neither does the cadence message. **A Fast
   * Chat with a project assigned to it is a chat where that assignment is inert**, and a model asked
   * to touch a file in it is guessing.
   *
   * ⚠️ A measurement with a control, not a preference: the same colleague and the same folder are
   * grounded three ways in this file, and only this one is told nothing.
   */
  test("🔴 Fast Chat is told NOTHING about the folder — not the path, not the contents, not the cadence", async () => {
    const fast = await groundingFor({ agentID: ASSIGNED, directory: ASSIGNED_PROJECT, shortChat: true })
    expect(fast.requests, "the Fast Chat turn never reached the provider — this case would prove nothing").toBe(1)
    expect(
      fast.everything,
      "Fast Chat now carries the location cadence — if that is intended, this case is the record of the change, not a failure",
    ).not.toContain("Current working folder")
    expect(fast.everything, "Fast Chat now names the assigned folder somewhere").not.toContain(ASSIGNED_PROJECT)
    expect(fast.everything, "Fast Chat now enumerates the assigned folder somewhere").not.toContain("ledger.md")
  })

  /**
   * 🔴 **STRICT IS A DIFFERENT ANSWER, NOT THE SAME ONE.** The same `enabled` line turns the chat-level
   * cadence off in Strict as well — but Strict does not leave the model blind. Its step prompt carries
   * a *"# Working directory (the ACTUAL files on disk …)"* section that inlines the working folder's
   * files, and that folder is the colleague's assigned one. **The assignment IS in force here**; it is
   * delivered by the step engine instead of by a chat message, which is why reading the `enabled` line
   * alone gives the wrong answer for Strict and the right one for Fast Chat.
   *
   * ⚠️ **The honest limit, measured: Strict never states the folder's PATH.** It shows the model what
   * is in the folder and never says where the folder is — a difference in kind from the ordinary turn
   * above, written down here rather than left to be discovered when a Strict run is asked for an
   * absolute path.
   */
  test("🔴 Strict carries the assigned folder's CONTENTS instead of the cadence — and never its path", async () => {
    const strict = await groundingFor({ agentID: ASSIGNED, directory: ASSIGNED_PROJECT, strict: true })
    expect(
      strict.requests,
      "the Strict run produced at most one provider request — the step engine did not run, so this case would prove nothing",
    ).toBeGreaterThan(1)
    expect(
      strict.everything,
      "a Strict step prompt did not carry the assigned folder's files — the colleague's project assignment is not reaching the step engine",
    ).toContain("ledger.md")
    expect(strict.everything, "the Strict run was given the OTHER colleague's workspace").not.toContain("sketch.txt")
    expect(
      strict.everything,
      "Strict now carries the chat-level location cadence — if that is intended, this case is the record of the change",
    ).not.toContain("Current working folder")
    expect(
      strict.everything,
      "Strict now states the working folder's absolute path — a welcome change, and this case is where it is recorded",
    ).not.toContain(ASSIGNED_PROJECT)
  })
})
