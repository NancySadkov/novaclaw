import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, makeRunnerHarness, type RunnerHarness } from "./fixture/runner-harness"
import { runBounded } from "./fixture/bounded"

/**
 * PORTED CLAIMS — turn start and request assembly.
 *
 * These are `session-runner.test.ts` claims rewritten against the current runner on a harness that
 * runs on **win32** (S3; see `session-runner-claims.test.ts` for the ledger and
 * todo/v0.2.0-prep.md for the ruling). The claim TITLES are the spec and are carried verbatim so the
 * ledger can match them. **Their old expectations are not automatically carried** — the old fixture
 * counted post-drain memory extraction as an interactive request, so an assertion there may encode
 * fixture staleness rather than runner behaviour. Each one below was re-derived.
 */

const drive = <A, E>(harness: RunnerHarness, body: Effect.Effect<A, E, any>, label: string) =>
  runBounded(
    Effect.gen(function* () {
      yield* harness.seed
      return yield* body
    }).pipe(Effect.scoped, Effect.provide(harness.layer)) as unknown as Effect.Effect<A, E, never>,
    { ms: 60_000, label },
  )

describe("SessionRunnerLLM — turn start", () => {
  test("streams one request with registry definitions from chronological V2 user history", async () => {
    // Two prompts recorded without draining, then one resume: the request must carry BOTH user
    // messages in order, plus the registry's tools.
    const harness = makeRunnerHarness({ turns: [[]] })

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Second" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
        expect(yield* session.messages({ sessionID: HARNESS_SESSION })).toHaveLength(2)
      }),
      "claim — one request from chronological history",
    )

    expect(harness.requests).toHaveLength(1)
    expect(harness.requests[0]?.model).toBe(harness.model)
    expect(harness.requests[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "defect"])
    expect(
      harness.requests[0]?.messages.map((message) => ({ role: message.role, content: message.content })),
    ).toEqual([
      { role: "user", content: [{ type: "text", text: "First" }] },
      { role: "user", content: [{ type: "text", text: "Second" }] },
    ])
  })
})
