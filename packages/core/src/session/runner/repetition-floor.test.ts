import { afterEach, describe, expect, it } from "bun:test"
import type { ModelV2 } from "../../model"
import {
  clearFloorRejections,
  DEFAULT_REPETITION_PENALTY,
  endpointKey,
  isFloorRejected,
  rejectsRepetitionPenalty,
  rememberFloorRejected,
  withRepetitionFloor,
} from "./repetition-floor"

// Only `request.body` matters to the floor; a minimal cast keeps the test free of the full
// ModelV2.Info schema construction.
const model = (body: Record<string, unknown>): ModelV2.Info =>
  ({ request: { body, headers: {}, variant: "default" } }) as unknown as ModelV2.Info

describe("withRepetitionFloor", () => {
  it("defaults repetition_penalty to 1.05 when the model sets none", () => {
    expect(DEFAULT_REPETITION_PENALTY).toBe(1.05)
    const out = withRepetitionFloor(model({}))
    expect(out.request.body.repetition_penalty).toBe(1.05)
  })

  it("respects an explicit value — including 1.0 (off)", () => {
    expect(withRepetitionFloor(model({ repetition_penalty: 1.1 })).request.body.repetition_penalty).toBe(1.1)
    expect(withRepetitionFloor(model({ repetition_penalty: 1 })).request.body.repetition_penalty).toBe(1)
  })

  it("preserves other sampling fields and does not mutate the input", () => {
    const input = model({ temperature: 0.6, top_p: 0.95 })
    const out = withRepetitionFloor(input)
    expect(out.request.body.temperature).toBe(0.6)
    expect(out.request.body.top_p).toBe(0.95)
    expect(out.request.body.repetition_penalty).toBe(1.05)
    // The input is left untouched (immer copy-on-write).
    expect((input.request.body as Record<string, unknown>).repetition_penalty).toBeUndefined()
  })
})

/**
 * The measured contract from OpenCode Go: a strict hosted upstream refuses the whole body over the
 * unknown field. These pin the reading and the endpoint-scoped memory the runner recovers through.
 */
describe("repetition floor rejection", () => {
  afterEach(() => clearFloorRejections())

  it("recognises the endpoint's own refusal, and nothing weaker", () => {
    expect(
      rejectsRepetitionPenalty(
        'HTTP 400: {"error":{"param":"repetition_penalty","message":"invalid request body: json: unknown field \\"repetition_penalty\\""}}',
      ),
    ).toBe(true)
    expect(rejectsRepetitionPenalty('unknown field "repetition_penalty"')).toBe(true)
    // A healthy reply that merely mentions the parameter is not evidence about the endpoint.
    expect(rejectsRepetitionPenalty("repetition_penalty accepted")).toBe(false)
    expect(rejectsRepetitionPenalty("temperature must be between 0 and 2")).toBe(false)
  })

  it("normalizes one endpoint's identity and refuses a malformed URL", () => {
    expect(endpointKey("https://OpenCode.ai/zen/go/v1/")).toBe("https://opencode.ai/zen/go/v1")
    expect(endpointKey("https://opencode.ai/zen/go/v1?x=1")).toBe("https://opencode.ai/zen/go/v1")
    expect(endpointKey("not a url")).toBeUndefined()
    expect(endpointKey(undefined)).toBeUndefined()
  })

  it("remembers a refusal for exactly that endpoint", () => {
    expect(isFloorRejected("https://opencode.ai/zen/go/v1")).toBe(false)
    rememberFloorRejected("https://opencode.ai/zen/go/v1/")
    // Trailing slash is the same endpoint; a sibling is not.
    expect(isFloorRejected("https://opencode.ai/zen/go/v1")).toBe(true)
    expect(isFloorRejected("https://api.deepseek.com/v1")).toBe(false)
    // A URL with no identity is never remembered, so the floor keeps applying (the safe direction).
    rememberFloorRejected("not a url")
    expect(isFloorRejected("not a url")).toBe(false)
  })
})
