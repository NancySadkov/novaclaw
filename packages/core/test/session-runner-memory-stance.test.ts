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

const withMemory = (memory: "own" | "none") =>
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.transform((draft) => {
      draft.update(AgentV2.defaultID, (item) => {
        item.memory = memory
      })
    })
  })

const runTurn = (harness: ReturnType<typeof makeRunnerHarness>, memory: "own" | "none") =>
  drive(
    harness,
    Effect.gen(function* () {
      yield* withMemory(memory)
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

  test("the text in the prompt is the section's own, not a second copy", async () => {
    // ⚠️ A parallel wording in the runner would drift from the module the tests measure. Asserting
    // the exact string keeps one source.
    const harness = makeRunnerHarness({ turns: [completeTurn("call_1", "ok")] })
    await runTurn(harness, "none")
    const section = SystemCompose.memoryStanceSection("none")!
    expect(systemOf(harness)).toContain(section.slice(0, 60))
  })
})
