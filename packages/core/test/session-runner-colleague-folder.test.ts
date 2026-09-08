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
 * ⚠️ **FOUR postures, and reading one `enabled` line gets three of them wrong.** That line used to
 * read `!strictEnabled && !ShortChat.enabled(...)`, which invites the conclusion that Strict and Fast
 * Chat are equally blind. Measured, all four differ: an ordinary chat gets the cadence; a Strict
 * message routed to the step engine gets its own, richer horizon (the step prompt inlines the
 * folder's files); **Fast Chat was told nothing anywhere in the request**; and **a Strict session
 * whose message routes to CHAT falls through to the ordinary assembly and was told nothing either**.
 * The last two for the same reason: `<env>` omitted the folder on the grounds that the cadence owned
 * it, and the cadence had stood down. A chat request now always owns its horizon
 * (`ProjectGrounding.HORIZON`, a total table with no "nobody" in it) and the step prompt owns its own
 * path. The cases below measure that rather than read it — one per posture, plus the unassigned
 * control that stops the fix from firing where no project was ever assigned.
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
  /** What the user typed. Defaults to an ordinary opener; the Strict cases below vary it. */
  readonly prompt?: string
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
      yield* session.prompt({
        sessionID: HARNESS_SESSION,
        prompt: Prompt.make({ text: input.prompt ?? "First" }),
        resume: false,
      })
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

    // 🔴 **AND IT STILL PAYS FOR THE HORIZON EXACTLY ONCE.** The Fast Chat fix below adds a second
    // way to deliver the folder, and the cheap wrong version of it is one that fires in every
    // posture — an ordinary chat would then carry the cadence AND a system line saying the same
    // thing, which is a regression dressed as a fix. The ownership table is what forbids that, and
    // this is where it is measured: the ordinary chat gets the cadence, and nothing else.
    expect(
      assigned.everything,
      "an ordinary chat now carries the Fast Chat working-folder line as well as the grounding cadence — the horizon is being paid for twice",
    ).not.toContain("this conversation belongs to")
    expect(
      unassigned.everything,
      "an ordinary chat now carries the Fast Chat working-folder line as well as the grounding cadence",
    ).not.toContain("this conversation belongs to")
  })

  /**
   * 🔴 **FAST CHAT IS TOLD WHERE IT IS — in one line, and only that line.**
   *
   * **What this case used to record.** Measured 2026-09-02, over every system part and every message
   * of the turn: the assigned folder's path never appeared, its contents never appeared, and neither
   * did the cadence message. The cadence read `!strictEnabled && !ShortChat.enabled(...)` and stood
   * down; `system-context/builtins.ts` left the working folder out of `<env>` *"deliberately"*
   * because the cadence was meant to own it — and stood down too. **A Fast Chat with a project
   * assigned to it was a chat that had never been told about the project.** Nothing anywhere in the
   * request could have told it: Fast Chat loads no system context at all, so there is not even an
   * `<env>` block for a folder line to have been forgotten from.
   *
   * **What it records now.** `ProjectGrounding.HORIZON` names an owner for every chat posture and has
   * no "nobody" to return; Fast Chat's owner is a system line, `SystemCompose.workingFolderSection`.
   *
   * ⚠️ **The line, and NOT the cadence — the cost decision, asserted rather than described.** Fast
   * Chat exists to be cheap, so it gets the PATH and not the listing: the `readdir` and the
   * re-delivered `user`-role message stay off, and the enumeration would be dead weight under a
   * ruleset that denies every tool but `upgrade_chat` anyway. `ledger.md` staying absent is that
   * decision; if a later change enumerates the folder here, this is the case that must be re-argued.
   */
  test("🔴 Fast Chat names the assigned folder — the path in one system line, and no listing", async () => {
    const fast = await groundingFor({ agentID: ASSIGNED, directory: ASSIGNED_PROJECT, shortChat: true })
    expect(fast.requests, "the Fast Chat turn never reached the provider — this case would prove nothing").toBe(1)

    // THE FIX. Over the WHOLE request, the way the broken case was measured — not over one part.
    expect(
      fast.everything,
      "a Fast Chat with an assigned project does not name it anywhere in the request — the assignment is inert again, which is the defect this case closes",
    ).toContain(ASSIGNED_PROJECT)
    expect(fast.everything, "the working-folder line is not the one the composer renders").toContain(
      "this conversation belongs to",
    )
    // It must not promise reach this posture does not have: every tool but `upgrade_chat` is denied.
    expect(fast.everything, "the folder line does not point at the one door Fast Chat can open").toContain(
      "upgrade_chat",
    )

    // THE COST. A line, not the cadence: no listing, and no cadence message.
    expect(
      fast.everything,
      "Fast Chat now enumerates the folder — that is a readdir and a listing on the mode whose whole point is being cheap, and it needs its own argument",
    ).not.toContain("ledger.md")
    expect(
      fast.everything,
      "Fast Chat now carries the grounding cadence itself — if that is intended, this case is the record of the change, not a failure",
    ).not.toContain("Current working folder")
  })

  /**
   * 🔴 **AND A FAST CHAT WITH NO PROJECT GAINS NOTHING.** The other half of the fix, and the half a
   * line that simply always fires would get wrong.
   *
   * An unassigned colleague's chat already runs IN its own scratch workspace — `folderFor` says so —
   * so announcing that folder as the project this conversation belongs to would be a misleading line
   * where there had merely been a missing one. Same predicate `workspaceSection` uses, and shared
   * with it so the two cannot come to disagree about whether a project was ever assigned.
   */
  test("🔴 a Fast Chat with no assigned project is told nothing — a missing line, never a misleading one", async () => {
    const fast = await groundingFor({ agentID: UNASSIGNED, directory: undefined, shortChat: true })
    expect(fast.requests, "the Fast Chat turn never reached the provider — this case would prove nothing").toBe(1)
    expect(
      fast.everything,
      "an unassigned colleague's own scratch folder is now announced as the project this conversation belongs to",
    ).not.toContain("this conversation belongs to")
    expect(fast.everything, "the unassigned Fast Chat names its scratch workspace as a project folder").not.toContain(
      UNASSIGNED_SCRATCH,
    )
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
   *
   * ⚠️ **Deliberately still open, 2026-09-02.** It was weighed alongside the Fast Chat fix and left:
   * that block is rendered by `jh/engine.ts`, whose `listFiles` dependency has no notion of a path at
   * all, and the step prompt's shape is validated by measured conversion on the model floor — so
   * changing it is a measurement, not an edit. It is a different defect from Fast Chat's in kind, not
   * degree: Strict is told what is in the folder and merely not where, while Fast Chat was told
   * nothing. `ProjectGrounding.HORIZON`'s comment carries the same note at the seam.
   *
   * ⚠️ **The step-engine path is UNCHANGED by the Fast Chat fix, and this is where that is
   * enforced.** The last two assertions fail if either chat-side owner ever reaches a Strict message
   * that went to the engine — the cadence, or the Fast Chat working-folder line.
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
    expect(
      strict.everything,
      "Strict now carries the Fast Chat working-folder line — the fix was supposed to leave the step engine's own horizon alone",
    ).not.toContain("this conversation belongs to")
  })

  /**
   * 🔴 **THE FOURTH POSTURE — a Strict session answering CONVERSATIONALLY, and the sibling the
   * three-posture reading hides.**
   *
   * Turning Strict on does not send every message to the step engine. `strict-drain.ts` routes each
   * one, and an explicit CHAT verdict — or, as here, a bare *"resume"* with nothing saved to resume —
   * **returns `"chat"` and falls THROUGH to the ordinary chat loop**, with `strict.enabled` still
   * true. That turn is assembled by exactly the code the Fast Chat defect lived in, and before this
   * fix it hit exactly the same hole from the other direction: the cadence stood down because the
   * session was Strict, the step prompt never ran because this message never reached the engine, and
   * `<env>` omitted the folder because the cadence was supposed to own it. **Told by nobody, again.**
   *
   * ⚠️ **Why removing `!strictEnabled` from the cadence gate is safe, measured rather than argued.**
   * Poisoning the ownership so that a Strict session resolves to the ORDINARY owner changed nothing
   * observable in the case above — the step-engine path never reaches this assembly at all, so the
   * flag was inert there. It was live in exactly one place: this fall-through. So the horizon owner
   * is now a property of the REQUEST (a chat request always has one) rather than of the session's
   * mode, and the step engine keeps its own horizon on its own path, untouched.
   */
  test("🔴 a Strict session that answers conversationally still gets the cadence — the fall-through nobody served", async () => {
    const fallthrough = await groundingFor({
      agentID: ASSIGNED,
      directory: ASSIGNED_PROJECT,
      strict: true,
      // Routes to CHAT without asking the model: "resume" with nothing resumable is a conversation.
      prompt: "resume",
    })
    expect(
      fallthrough.everything,
      "the Strict session sent this message to the step engine after all — it never reached the chat loop, so this case would prove nothing",
    ).not.toContain("# Working directory")
    expect(
      fallthrough.everything,
      "a conversational turn in a Strict session is told nothing about its working folder — the cadence stood down for Strict and the step prompt never ran, which is the Fast Chat defect from the other direction",
    ).toContain(`Current working folder: ${ASSIGNED_PROJECT}`)
  })
})
