// `nova-cli run --model <ref>` used to drop the caller's instruction in two ways, both silently and
// both at exit 0 — the same class the `--agent` refusal next to it in `run.ts` was fixed for:
//
//   1. **A ref with no `/` skipped the switch ENTIRELY.** `if (providerID && modelID)` had no
//      `else`, so a bare `opus`, a typo, or a model id pasted without its provider ran the turn on
//      whatever model the session already had. `--variant` rides that same call and went with it.
//   2. **A refused or failed switch was swallowed.** `.catch(() => undefined)` folded the failure
//      into the value a success produces.
//
// ⚠️ The existing "unknown model exits nonzero" test in `run-process.test.ts` covers NEITHER: it
// passes `test/nonexistent-model`, a well-formed ref that `V2Session.switchModel` stores without
// validating (it only publishes a ModelSwitched event) and that fails much later, at generation. So
// it exercises the generation path, not this branch. These tests exercise the branch.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../../lib/cli-process"

describe("novaclaw run — a --model that cannot be honoured", () => {
  cliIt.concurrent(
    "refuses a model ref with no provider instead of running on the session's own model",
    ({ llm, novaclaw }) =>
      Effect.gen(function* () {
        yield* llm.text("should never be reached")
        // `--variant` rides the very `switchModel` call this branch used to skip, so it is passed
        // here too: the refusal must cover it rather than let it be dropped alongside the model.
        const result = yield* novaclaw.run("summarize the thing", {
          model: "opus",
          extraArgs: ["--variant", "thinking"],
          timeoutMs: 25_000,
        })

        expect(result.outputDiscarded ?? false).toBe(false)
        expect(result.exitCode).not.toBe(0)
        // Names the offending value AND the shape expected — a refusal that does not say what is
        // wrong sends the caller back to the source.
        expect(result.stderr).toContain("opus")
        expect(result.stderr).toContain("providerID/modelID")
        // Nothing was sent to the provider: with the defect the turn RAN, on the wrong model, and
        // its output would have looked authoritative.
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )

  cliIt.concurrent(
    "refuses a --model whose provider half is empty",
    ({ llm, novaclaw }) =>
      Effect.gen(function* () {
        yield* llm.text("should never be reached")
        const result = yield* novaclaw.run("summarize the thing", { model: "/test-model", timeoutMs: 25_000 })
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("providerID/modelID")
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )

  // The control that stops the refusals above from being a threshold that fires on normal input: a
  // well-formed ref still switches and still runs, and `--variant` still reaches the switch with it.
  cliIt.concurrent(
    "control: a well-formed --model runs, and --variant rides the same switch",
    ({ llm, novaclaw }) =>
      Effect.gen(function* () {
        // `novaclaw.run` always passes `--model test/test-model`, so this IS the well-formed ref
        // going through the same branch the two refusals above guard.
        yield* llm.text("ran on the named model")
        const plain = yield* novaclaw.run("do the work")
        novaclaw.expectExit(plain, 0)
        expect(yield* llm.calls).toBeGreaterThan(0)

        // And the other half of that A/B, OBSERVED rather than assumed: the same run with a variant
        // the test model does not have fails at model resolution, naming it. That is only possible
        // if `--variant` actually reached `switchModel` — a dropped variant would resolve to the
        // plain model and succeed, exactly as the line above does.
        yield* llm.text("should not be reached with an unknown variant")
        const variant = yield* novaclaw.run("do the work", { extraArgs: ["--variant", "thinking"] })
        expect(variant.exitCode).not.toBe(0)
        expect(variant.stderr).toContain("unavailable")
      }),
    90_000,
  )
})
