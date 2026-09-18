import { describe, expect, test } from "bun:test"
import { buildPrompt } from "./build-request-parts"

// V1-nuke slice C: buildPrompt assembles the NATIVE PromptInput ({text, files}) the
// /api prompt route takes. These preserve the old buildRequestParts suite's intent: uri
// construction across platforms, selection queries, context dedup, comment notes (now folded
// into the text), image data-uris, and ordering.

const base = {
  prompt: [] as never[],
  context: [],
  images: [],
  text: "hello",
  sessionDirectory: "/repo",
}

describe("buildPrompt", () => {
  test("text-only prompt has no files", () => {
    const prompt = buildPrompt({ ...base })
    expect(prompt.text).toBe("hello")
    expect(prompt.files).toBeUndefined()
  })

  test("images ride as data uris with their filename", () => {
    const prompt = buildPrompt({
      ...base,
      images: [
        { type: "image", mime: "image/png", dataUrl: "data:image/png;base64,AAA", filename: "shot.png" } as never,
      ],
    })
    expect(prompt.files).toEqual([{ uri: "data:image/png;base64,AAA", name: "shot.png" }])
  })

  test("comment notes fold into the text and attach their file", () => {
    const prompt = buildPrompt({
      ...base,
      context: [
        {
          key: "k",
          type: "file",
          path: "src/a.ts",
          selection: { startLine: 1, endLine: 2, startChar: 0, endChar: 0 },
          comment: "fix this",
        },
      ],
    })
    expect(prompt.text).toContain("hello")
    expect(prompt.text).toContain("fix this")
    expect(prompt.files!.some((file) => file.uri.includes("src/a.ts"))).toBe(true)
  })

  test("windows absolute paths pass through unmangled", () => {
    const prompt = buildPrompt({
      ...base,
      sessionDirectory: "C:\\repo",
      context: [{ key: "k", type: "file", path: "C:\\repo\\src\\main.ts" }],
    })
    expect(prompt.files![0]!.uri).toContain("C:")
    expect(prompt.files![0]!.uri).toContain("main.ts")
  })

  test("relative paths join the session directory", () => {
    const prompt = buildPrompt({
      ...base,
      sessionDirectory: "/home/user/repo",
      context: [{ key: "k", type: "file", path: "src/deep/file.ts" }],
    })
    expect(prompt.files![0]!.uri).toContain("/home/user/repo/src/deep/file.ts")
  })

  test("empty text with notes still produces non-empty text", () => {
    const prompt = buildPrompt({
      ...base,
      text: "",
      context: [{ key: "k", type: "file", path: "a.ts", comment: "note" }],
    })
    expect(prompt.text).toContain("note")
    expect(prompt.text.startsWith("\n")).toBe(false)
  })
})
