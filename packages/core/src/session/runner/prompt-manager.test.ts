import { describe, expect, test } from "bun:test"
import { PromptManager } from "./prompt-manager"

const base: PromptManager.Input = {
  kind: "agent",
  name: "Iris",
  title: "Reviewer",
  superior: "Nova",
  subordinates: ["Theron"],
  jobInstructions: "Review the manuscript.",
  os: "Windows_NT",
  kernelRelease: "10.0.22631",
  arch: "x64",
  shell: "C:/Git/bin/bash.exe",
  owner: "nangl",
  scratch: "C:/data/scratch/iris",
  goal: undefined,
  unattended: false,
  memos: [],
  project: undefined,
  projectFiles: undefined,
  workLog: undefined,
}

describe("PromptManager — the one system prompt", () => {
  test("an agent prompt is one monolithic block with interpolated environment, identity and brief", () => {
    const text = PromptManager.generate(base)
    expect(text).toContain("You're officer agent of a NovaClaw instance")
    expect(text).toContain("This instance runs on Windows_NT 10.0.22631 / x64.")
    expect(text).toContain("Shell: C:/Git/bin/bash.exe")
    expect(text).toContain("Instance owner is nangl.")
    expect(text).toContain("Your name is Iris. Your job title is Reviewer.")
    expect(text).toContain("Your superior is Nova")
    expect(text).toContain("Your subordinates are Theron.")
    expect(text).toContain("Job Instructions: Review the manuscript.")
    expect(text).toContain("C:/data/scratch/iris is your private workspace")
    // The personality block is gone (owner, 2026-09-17).
    expect(text).not.toContain("personality and standing instructions")
  })

  test("a pure chat is its job instructions and nothing else", () => {
    expect(PromptManager.generate({ ...base, kind: "chat", jobInstructions: "Talk with care." })).toBe(
      "Talk with care.",
    )
    expect(PromptManager.generate({ ...base, kind: "chat", jobInstructions: "   " })).toBe("")
    expect(PromptManager.generate({ ...base, kind: "chat", jobInstructions: undefined })).toBe("")
  })

  test("the owning human never receives a harness prompt", () => {
    expect(PromptManager.generate({ ...base, kind: "human" })).toBe("")
  })

  test("the goal appears only while unattended, and memos render as `Name: value` lines", () => {
    const lazy = PromptManager.generate(base)
    expect(lazy).not.toContain("durable goal")
    const unattended = PromptManager.generate({
      ...base,
      unattended: true,
      goal: "Ship the reviewed manuscript.",
      memos: [
        { name: "Path", value: "C:/books" },
        { name: "Decision", value: "Keep chapter 4" },
      ],
    })
    expect(unattended).toContain("Your durable goal, set for you by whoever assigned this work:")
    expect(unattended).toContain("Ship the reviewed manuscript.")
    expect(unattended).toContain("# memo_set memos")
    expect(unattended).toContain("Path: C:/books")
    expect(unattended).toContain("Decision: Keep chapter 4")
  })

  test("the project listing is byte-bounded and says when it truncated", () => {
    const text = PromptManager.generate({
      ...base,
      project: "C:/books",
      projectFiles: ["a.md", "b.md"],
    })
    expect(text).toContain("Your project is C:/books")
    expect(text).toContain("It has following files:\na.md, b.md")

    const big = Array.from({ length: 400 }, (_, index) => `chapter-${index}-${"x".repeat(20)}.md`)
    const bounded = PromptManager.renderProjectFiles(big)
    expect(Buffer.byteLength(bounded.split("\n")[0]!, "utf8")).toBeLessThanOrEqual(PromptManager.PROJECT_LIST_BUDGET)
    expect(bounded).toContain("<use ls to list the rest>")
  })

  test("an earlier work-log is named only when one exists", () => {
    expect(PromptManager.generate(base)).not.toContain("Earlier work-log")
    expect(PromptManager.generate({ ...base, workLog: "C:/scratch/tmp/oldlog-2026-09-17-120000.json" })).toContain(
      "Earlier work-log: C:/scratch/tmp/oldlog-2026-09-17-120000.json.",
    )
  })

  test("`You have no subordinates` replaces an empty list, and an absent superior means the owner", () => {
    const text = PromptManager.generate({ ...base, superior: undefined, subordinates: [] })
    expect(text).toContain("Your superior is nangl")
    expect(text).toContain("You have no subordinates.")
  })
})
