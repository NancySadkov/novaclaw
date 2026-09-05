import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, completeTurn, conversation, drive, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * PORTED CLAIMS — turn start and request assembly.
 *
 * These are `session-runner.test.ts` claims rewritten against the current runner on a harness that
 * runs on **win32** (S3; see `session-runner-claims.test.ts` for the ledger and
 *  for the ruling). The claim TITLES are the spec and are carried verbatim so the
 * ledger can match them. **Their old expectations are not automatically carried** — the old fixture
 * counted post-drain memory extraction as an interactive request, so an assertion there may encode
 * fixture staleness rather than runner behaviour. Each one below was re-derived.
 */

describe("SessionRunnerLLM — turn start", () => {
  test("streams one request with registry definitions from chronological V2 user history", async () => {
    // Two prompts recorded without draining, then one resume: the request must carry BOTH user
    // messages in order, plus the registry's tools.
    const harness = makeRunnerHarness({ turns: [completeTurn("t1", "One")] })

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Second" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
        // Both prompts plus the one reply they drew. (Was 2 while an unscripted turn produced no
        // assistant message at all — see the empty-response claim in `session-runner-errors.test.ts`.)
        expect(yield* session.messages({ sessionID: HARNESS_SESSION })).toHaveLength(3)
      }),
      "claim — one request from chronological history",
    )

    expect(harness.requests).toHaveLength(1)
    expect(harness.requests[0]?.model).toBe(harness.model)
    expect(harness.requests[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "defect"])
    // `conversation` drops what the harness appended to the tail (project grounding here) — this
    // claim is about the CHRONOLOGICAL USER HISTORY, and the cadence of the tail injections is
    // asserted by `session-runner-grounding.test.ts` rather than re-litigated in every claim.
    expect(
      conversation(harness.requests[0]!).map((message) => ({ role: message.role, content: message.content })),
    ).toEqual([
      { role: "user", content: [{ type: "text", text: "First" }] },
      { role: "user", content: [{ type: "text", text: "Second" }] },
    ])
  })

  test("bounds 64-character session prompt cache keys", async () => {
    // Two sessions whose ids are far longer than the provider's 64-character cache-key limit. The keys
    // must be bounded AND still distinct — a truncation that collided would silently share a prompt
    // cache between unrelated sessions, which is a correctness bug wearing a performance hat.
    const longSessionID = SessionV2.ID.make(`ses_${"a".repeat(64)}`)
    const otherLongSessionID = SessionV2.ID.make(`ses_${"b".repeat(64)}`)
    const harness = makeRunnerHarness()

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* harness.seedSession(longSessionID)
        yield* harness.seedSession(otherLongSessionID)
        yield* session.prompt({
          sessionID: longSessionID,
          prompt: Prompt.make({ text: "Run long session" }),
          resume: false,
        })
        yield* session.prompt({
          sessionID: otherLongSessionID,
          prompt: Prompt.make({ text: "Run other long session" }),
          resume: false,
        })
        yield* session.resume(longSessionID)
        yield* session.resume(otherLongSessionID)
      }),
      "claim — bounded prompt cache keys",
    )

    const keys = harness.requests.map((request) => request.providerOptions?.openai?.promptCacheKey)
    expect(keys).toEqual([longSessionID.slice(4), otherLongSessionID.slice(4)])
    expect(keys.every((key) => typeof key === "string" && key.length === 64)).toBe(true)
    expect(keys[0]).not.toBe(keys[1])
  })
})
