import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLMEvent } from "@novaclaw/llm"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, makeRunnerHarness, type RunnerHarness } from "./fixture/runner-harness"
import { runBounded } from "./fixture/bounded"

/**
 * S2's ADMISSION TEST. Not a ported claim — the thing that must be true before any claim can be
 * ported, and the thing that was false for nine hypotheses: **can this harness drive the real drain to
 * a written assistant message, on win32, without hanging?**
 *
 * The failure it replaces was specific and worth keeping in view: a re-derived graph called the
 * provider, got a canonical complete turn back, wrote **no assistant message**, retried the identical
 * request three times (each carrying `msgs = 1`, so no progress between attempts) and then settled
 * reporting `Exit { _tag: "Success" }`. If this file goes red in that shape again, the harness is the
 * suspect, not the claim under test.
 */

/** The canonical complete turn, byte-identical in shape to the old fixture's `fragmentFixture("text")`. */
const completeTurn = (id: string, text: string): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id }),
  LLMEvent.textDelta({ id, text }),
  LLMEvent.textEnd({ id }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

/** Seed the session, run `body` against the harness graph, and bound the whole thing against a hang. */
const drive = <A, E>(harness: RunnerHarness, body: Effect.Effect<A, E, any>, label: string) =>
  runBounded(
    Effect.gen(function* () {
      yield* harness.seed
      return yield* body
    }).pipe(Effect.scoped, Effect.provide(harness.layer)) as unknown as Effect.Effect<A, E, never>,
    // Generous, because this is the bound against a HANG, not a latency budget: a graph of ~19 nodes is
    // built per case and the first one pays for module init. A case that trips this is wedged.
    { ms: 60_000, label },
  )

describe("the harness drives the real drain", () => {
  test("🔴 S2 admission — one scripted turn writes one assistant message", async () => {
    const harness = makeRunnerHarness({ turns: [completeTurn("text-1", "Hello from the drain.")] })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Say hello" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "S2 admission — scripted turn",
    )

    // ① The assistant message EXISTS. This is the assertion the re-derived graph could never satisfy.
    expect(context).toMatchObject([
      { type: "user", text: "Say hello" },
      { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-1", text: "Hello from the drain." }] },
    ])
    // ② And exactly ONE INTERACTIVE provider request. The old symptom was identical retries reported as
    // a successful drain, so a passing ① with a request count above 1 would still be the bug.
    //
    // 🔴 This doubles as the OUT_OF_BAND exhaustiveness ratchet. A plain scripted turn triggers the
    // post-drain passes too; if a new one is added to the runner and not classified in the harness, it
    // lands here as an interactive request and this line goes red **naming the file to fix** — instead
    // of silently skewing every count assertion in the suite and consuming the next test's scripted
    // turn, which is exactly how the old fixture rotted (memory extraction, added after it was
    // written, is why the Linux run reported `toHaveLength(1)` receiving 2).
    expect(harness.requests, "a completed turn must not be retried").toHaveLength(1)
    // The maintenance pass DID run — so the assertion above is passing because it was classified, not
    // because it never happened. Without this, deleting the classification would look like a fix.
    expect(harness.maintenanceRequests, "post-drain maintenance must be classified, not absent").toHaveLength(1)
  })

  test("two harnesses in one file do not share a drain", async () => {
    // The per-test-state property, asserted through the real graph rather than on the arrays alone:
    // each harness gets its own database, its own session row and its own request log.
    const first = makeRunnerHarness({ turns: [completeTurn("text-a", "First.")] })
    const second = makeRunnerHarness({ turns: [completeTurn("text-b", "Second.")] })

    const run = (harness: RunnerHarness, text: string, label: string) =>
      drive(
        harness,
        Effect.gen(function* () {
          const session = yield* SessionV2.Service
          yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text }), resume: false })
          yield* session.resume(HARNESS_SESSION)
          return yield* session.context(HARNESS_SESSION)
        }),
        label,
      )

    const a = await run(first, "Ask first", "isolation — first")
    const b = await run(second, "Ask second", "isolation — second")

    expect(a).toMatchObject([{ type: "user", text: "Ask first" }, { content: [{ text: "First." }] }])
    expect(b).toMatchObject([{ type: "user", text: "Ask second" }, { content: [{ text: "Second." }] }])
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(1)
  })
})
