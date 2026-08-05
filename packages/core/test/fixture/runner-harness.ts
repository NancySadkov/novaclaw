import { Effect, Layer, Stream } from "effect"
import { LLMClient, Model, type LLMEvent, type LLMRequest, type LLMClientShape } from "@novaclaw/llm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-chat"

/**
 * A drain harness with NO shared state — the one property the old suite lacks.
 *
 * ⚠️ **Why this exists rather than a port.** `session-runner.test.ts` drives its mock through **six
 * module-level mutable variables** (`requests`, `response`, `responses`, `streamGate`, `streamStarted`,
 * `streamFailure`) which individual tests reset **by hand — sixty resets across the file**. Every other
 * part of that fixture is already per-test (the node graph is rebuilt by each `Effect.provide`); the
 * script is the sole exception, and it is shared by all 77 tests. A test that forgets one reset
 * silently inherits its predecessor's stream, tools or gate, so **order-dependence is designed in** —
 * which is the property that makes a suite pass alone and fail in a full run.
 *
 * Here the script is created by the factory, so there is nothing to forget and nothing to reset. Two
 * tests cannot see each other's requests.
 *
 * ⚠️ This is deliberately NOT the old fixture with the globals lifted out. The scriptable-stream idea
 * is sound and is re-derived; what is not carried across is the 653-line artefact, including its
 * Windows singleton lock — that lock guarded against runs piling up when a case wedged, and
 * `runBounded` plus `script/test.ts`'s wall-clock kill is what replaces it.
 */
export interface RunnerScript {
  /** Events the provider returns for the next request, and for each request after it. A turn that
   * asks more times than there are entries gets an empty stream, which ends the drain. */
  turns?: LLMEvent[][]
}

/**
 * Build one harness. Call it INSIDE a test, never at module scope — module scope is how the shared
 * state got there in the first place.
 */
export function makeRunnerHarness(script: RunnerScript = {}) {
  const requests: LLMRequest[] = []
  const turns = [...(script.turns ?? [])]

  const clientLayer = Layer.succeed(
    LLMClient.Service,
    LLMClient.Service.of({
      prepare: () => Effect.die("the harness has no prepare path — a test that needs one should say so"),
      stream: ((request: LLMRequest) => {
        requests.push(request)
        // Shift rather than index: the drain may issue more requests than the script anticipates, and
        // an exhausted script returning an EMPTY stream settles the turn instead of replaying the last
        // response forever. A replay would look like a working test right up until it looped.
        return Stream.fromIterable(turns.shift() ?? [])
      }) as unknown as LLMClientShape["stream"],
      generate: () => Effect.die("the harness has no non-streaming path — a test that needs one should say so"),
    }),
  )

  return {
    /** Every request the drain issued, in order. Per-harness: another test cannot append to it. */
    requests,
    model: Model.make({ id: "harness-model", provider: "harness", route: OpenAIChat.route }),
    clientLayer,
  }
}

/** Derived rather than declared, so the factory stays the single description of its own shape. */
export type RunnerHarness = ReturnType<typeof makeRunnerHarness>
