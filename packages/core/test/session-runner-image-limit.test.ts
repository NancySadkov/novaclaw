import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@novaclaw/core/model"
import { SessionRunnerModel } from "@novaclaw/core/session/runner/model"

/**
 * How many images one request may carry — the owner's ruling of 2026-08-20, made reachable.
 *
 * 🔴 Why this file exists: the floor was changed from "unlimited" to 1 and the ENTIRE core suite
 * stayed green — 2905 tests, 0 fail — because the precedence chain lived inline in a ~1500-line
 * generator where no test could reach it. A rule nothing can see is a rule that rots silently.
 *
 * The measured stakes, on holo3.1 (vLLM `--limit-mm-per-prompt {"image": 3}`):
 *  · assume too FEW  → more requests, every image still described. Slower, correct.
 *  · assume too MANY → `HTTP 400 At most 3 image(s)`, then `budgetImages` elides to recover, and
 *    what it elides may never have been described. That produced five wrong filenames out of six.
 */

const resolve = SessionRunnerModel.resolveImageLimit

describe("the floor — assume ONE image unless something knows better", () => {
  test("nothing known at all resolves to 1, never to unlimited", () => {
    // ⚠️ The whole ruling in one line. Before this, an empty chain meant "pass everything", so a
    // COLD process — no catalog entry, nothing learned yet — spent its first turn over-sending and
    // discovered the cap only by being refused.
    expect(resolve({})).toBe(1)
    expect(resolve({ declared: undefined, discovered: undefined, persisted: undefined })).toBe(1)
  })

  test("the constant is 1, and it is the same one the resolver uses", () => {
    // Pinned as a NUMBER as well as by identity: a future edit that redefines the constant to 3
    // would keep every other test here passing while silently restoring the dead-end.
    expect(ModelV2.DEFAULT_IMAGE_LIMIT).toBe(1)
    expect(resolve({})).toBe(ModelV2.DEFAULT_IMAGE_LIMIT)
  })
})

describe("precedence — each source outranks the ones that know less", () => {
  test("a declared catalog limit wins over every measurement", () => {
    // The operator's statement beats an inference, even a fresher one. Someone who types 8 into the
    // model dialog has told us something a 400 never can: what the server is CONFIGURED to allow.
    expect(resolve({ declared: 8, discovered: 3, persisted: 2 })).toBe(8)
    expect(resolve({ declared: 8 })).toBe(8)
  })

  test("this run's measurement outranks a previous run's", () => {
    // Both are inferences, so the newer one wins: the endpoint may have been reconfigured since.
    expect(resolve({ discovered: 3, persisted: 12 })).toBe(3)
  })

  test("a persisted value is used when nothing newer exists", () => {
    // ⭐ This is what spares a fresh CLI process its first-turn losses — the cap outlives the process
    // that learned it, so the withholding gate can fire on turn one.
    expect(resolve({ persisted: 3 })).toBe(3)
  })

  test("the floor never overrides a real source, so the harness can still learn UP", () => {
    // 🔴 The failure mode if the floor were placed any higher in the chain: it would pin every model
    // at 1 forever, and a server that happily takes 32 would be driven one picture at a time for the
    // life of the install — with nothing in the logs to say why.
    expect(resolve({ declared: 32 })).toBe(32)
    expect(resolve({ discovered: 32 })).toBe(32)
    expect(resolve({ persisted: 32 })).toBe(32)
  })
})

describe("the values a real endpoint actually produces", () => {
  test("holo3.1's measured cap of 3 survives the chain intact", () => {
    // Measured, not invented: `HTTP 400 — At most 3 image(s) may be provided in one prompt`.
    expect(resolve({ discovered: 3 })).toBe(3)
  })

  test("a server that refuses even two resolves to 1 and still works", () => {
    // A cap of 1 is a legitimate configuration, not a degenerate case — it is `--limit-mm-per-prompt
    // {"image": 1}`, and it must resolve to 1 rather than being mistaken for "unset".
    expect(resolve({ declared: 1 })).toBe(1)
  })
})
