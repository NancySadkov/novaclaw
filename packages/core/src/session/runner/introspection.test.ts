import { describe, expect, test } from "bun:test"
import {
  DEFAULT_CADENCE,
  DEFAULT_INTERJECTION,
  DEFAULT_PROMPT,
  MAX_EXCERPT_CHARS,
  generatePrompt,
  isYesVerdict,
  judgeExcerpt,
  judgePrompt,
  parseModelRef,
  resolve,
  shouldJudge,
} from "./introspection"
import type { SessionMessage } from "../message"

describe("resolve", () => {
  test("defaults: disabled, cadence 3, canonical prompt + interjection", () => {
    const resolved = resolve(undefined)
    expect(resolved.enabled).toBe(false)
    expect(resolved.cadence).toBe(DEFAULT_CADENCE)
    expect(resolved.prompt).toBe(DEFAULT_PROMPT)
    expect(resolved.interjection).toBe(DEFAULT_INTERJECTION)
    expect(resolved.generateInterjection).toBe(false)
    expect(resolved.model).toBeUndefined()
  })
  test("config overrides apply; blank strings fall back to defaults", () => {
    const resolved = resolve({
      enabled: true,
      cadence: 5,
      model: "dgx-spark/qwen3.6-35b",
      prompt: "  ",
      interjection: "Change course.",
      generateInterjection: true,
    })
    expect(resolved.enabled).toBe(true)
    expect(resolved.cadence).toBe(5)
    expect(resolved.model).toEqual({ providerID: "dgx-spark", id: "qwen3.6-35b" })
    expect(resolved.prompt).toBe(DEFAULT_PROMPT)
    expect(resolved.interjection).toBe("Change course.")
    expect(resolved.generateInterjection).toBe(true)
  })
  test("nonsense cadence falls back", () => {
    expect(resolve({ cadence: 0 }).cadence).toBe(DEFAULT_CADENCE)
    expect(resolve({ cadence: -3 }).cadence).toBe(DEFAULT_CADENCE)
    expect(resolve({ cadence: 2.9 }).cadence).toBe(2)
  })
})

describe("parseModelRef", () => {
  test("provider/model splits on the FIRST slash (model ids may contain slashes)", () =>
    expect(parseModelRef("dgx-spark/openai/gpt-oss-120b")).toEqual({
      providerID: "dgx-spark",
      id: "openai/gpt-oss-120b",
    }))
  test("missing or degenerate refs parse to undefined", () => {
    expect(parseModelRef(undefined)).toBeUndefined()
    expect(parseModelRef("no-slash")).toBeUndefined()
    expect(parseModelRef("/leading")).toBeUndefined()
    expect(parseModelRef("trailing/")).toBeUndefined()
  })
})

describe("shouldJudge", () => {
  test("never judges the first provider step", () => expect(shouldJudge(1, 3)).toBe(false))
  test("judges every cadence-th continuation step", () => {
    expect(shouldJudge(4, 3)).toBe(true)
    expect(shouldJudge(7, 3)).toBe(true)
    expect(shouldJudge(5, 3)).toBe(false)
    expect(shouldJudge(2, 1)).toBe(true)
    expect(shouldJudge(3, 1)).toBe(true)
  })
})

const assistant = (content: SessionMessage.Assistant["content"]) =>
  ({ type: "assistant", id: "msg_a", content, time: { created: 0 } }) as unknown as SessionMessage.Message

const toolPart = (name: string, input: unknown, output: string) =>
  ({
    type: "tool",
    id: "call_1",
    name,
    state: { status: "completed", input, output, time: { start: 0, end: 1 } },
  }) as never

const textPart = (text: string) => ({ type: "text", id: "text-0", text }) as never

describe("judgeExcerpt", () => {
  test("undefined when there is nothing to judge", () => {
    expect(judgeExcerpt([])).toBeUndefined()
    expect(judgeExcerpt([assistant([])])).toBeUndefined()
  })
  test("carries recent tool calls + the last assistant text", () => {
    const excerpt = judgeExcerpt([
      assistant([toolPart("bash", { command: "ls" }, "a.txt b.txt"), textPart("Listing files…")]),
    ])
    expect(excerpt).toContain("tool bash")
    expect(excerpt).toContain("a.txt b.txt")
    expect(excerpt).toContain("Listing files…")
  })
  test("clips a giant context to the excerpt cap", () => {
    const excerpt = judgeExcerpt([assistant([textPart("x".repeat(20_000))])])
    expect(excerpt!.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS)
  })
})

describe("isYesVerdict (tolerant parse)", () => {
  test("plain yes/no", () => {
    expect(isYesVerdict("YES")).toBe(true)
    expect(isYesVerdict("no")).toBe(false)
  })
  test("decorated verdicts", () => {
    expect(isYesVerdict("**Yes** — the agent keeps re-running the same command.")).toBe(true)
    expect(isYesVerdict("No. It is making steady progress.")).toBe(false)
  })
  test("reasoning followed by a final verdict line", () => {
    expect(isYesVerdict("The agent retried the same edit four times.\nYES")).toBe(true)
    expect(isYesVerdict("It reads different files each step.\nno")).toBe(false)
  })
  test("ambiguity is NO — never interject on an unclear verdict", () => {
    expect(isYesVerdict("Maybe? Hard to tell.")).toBe(false)
    expect(isYesVerdict("")).toBe(false)
    expect(isYesVerdict("The answer is unclear but yes-adjacent behavior appears mid-sentence")).toBe(false)
  })
})

describe("prompts", () => {
  test("judgePrompt wraps the excerpt in the context tag", () => {
    const prompt = judgePrompt("Is it stuck?", "tool bash(ls) -> ok")
    expect(prompt).toContain("Is it stuck?")
    expect(prompt).toContain("<recent-agent-context>")
    expect(prompt).toContain("tool bash(ls) -> ok")
  })
  test("generatePrompt demands interjection-only output", () =>
    expect(generatePrompt("ctx")).toContain("ONLY the interjection text"))
})
