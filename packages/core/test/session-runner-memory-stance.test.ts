import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { SystemCompose } from "@novaclaw/core/session/runner/system-compose"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * THE STANCE REACHES A REAL PROMPT — the join, not the rule.
 *
 * 🔴 `system-compose-memory.test.ts` proves what the section SAYS and when it is absent. It says
 * nothing about whether the runner ever asks for it, and reads the agent's memory setting rather than
 * something else. This session has shipped four features whose halves were each right and whose join
 * was never made, so the join is driven: a real turn, on a colleague configured `memory: "none"`, and
 * the request the provider actually received.
 */

const withMemory = (memory: "own" | "none", archiveChats?: boolean) =>
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.transform((draft) => {
      draft.update(AgentV2.defaultID, (item) => {
        item.memory = memory
        if (archiveChats !== undefined) item.archiveChats = archiveChats
      })
    })
  })

const runTurn = (harness: ReturnType<typeof makeRunnerHarness>, memory: "own" | "none", archiveChats?: boolean) =>
  drive(
    harness,
    Effect.gen(function* () {
      yield* withMemory(memory, archiveChats)
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID: HARNESS_SESSION,
        prompt: Prompt.make({ text: "Remember the review is on the 14th" }),
        resume: false,
      })
      yield* session.resume(HARNESS_SESSION)
    }),
    `memory stance — ${memory}`,
  )

/** The system text the provider was actually handed. `harness.requests` is what the LLM seam saw. */
const systemOf = (harness: ReturnType<typeof makeRunnerHarness>): string => JSON.stringify(harness.requests)

describe("SessionRunnerLLM — memory stance", () => {
  test("a `memory: none` colleague is TOLD it keeps nothing", async () => {
    const harness = makeRunnerHarness({ turns: [completeTurn("call_1", "ok")] })
    await runTurn(harness, "none")
    expect(systemOf(harness)).toContain("NO long-term memory")
  })

  test("a colleague WITH memory is told nothing — the ordinary prompt is unchanged", async () => {
    const harness = makeRunnerHarness({ turns: [completeTurn("call_1", "ok")] })
    await runTurn(harness, "own")
    expect(systemOf(harness)).not.toContain("NO long-term memory")
  })

  // 🔴 A SECOND FIELD read from the same record, and reading one correctly says nothing about the
  // other — a `memoryStance` wired only to `memory` would pass every test above while a colleague
  // with archiving off is told nothing.
  test("a colleague with archiving OFF is told, from the same record", async () => {
    const harness = makeRunnerHarness({ turns: [completeTurn("call_1", "ok")] })
    await runTurn(harness, "own", false)
    expect(systemOf(harness)).toContain("NOT archived")
  })

  test("archiving ON leaves the prompt alone", async () => {
    const harness = makeRunnerHarness({ turns: [completeTurn("call_1", "ok")] })
    await runTurn(harness, "own", true)
    expect(systemOf(harness)).not.toContain("NOT archived")
  })

  // 🔴 BOTH FOLDERS reach a real prompt. The harness session runs in a project directory while the
  // agent's workspace is derived from its id, so the two differ and the section must appear — a
  // `workspace` wired to the session's own folder instead of the agent's would pass every unit test
  // above while telling every colleague it has a workspace it does not have.
  test("an assigned colleague is told about its own workspace", async () => {
    const harness = makeRunnerHarness({ turns: [completeTurn("call_1", "ok")] })
    await runTurn(harness, "own")
    expect(systemOf(harness)).toContain("Your own workspace")
  })

  test("the text in the prompt is the section's own, not a second copy", async () => {
    // ⚠️ A parallel wording in the runner would drift from the module the tests measure. Asserting
    // the exact string keeps one source.
    const harness = makeRunnerHarness({ turns: [completeTurn("call_1", "ok")] })
    await runTurn(harness, "none")
    const section = SystemCompose.memoryStanceSection({ memory: "none", archiveChats: undefined })!
    expect(systemOf(harness)).toContain(section.slice(0, 60))
  })
})
