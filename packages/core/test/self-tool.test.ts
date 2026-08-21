import { describe, expect, test } from "bun:test"
import { SelfTool } from "@novaclaw/core/tool/self"

// What a colleague is told when it asks about ITSELF (owner, 2026-08-21).
//
// 🔴 Under the roster a colleague is a role record someone else edits — the user changes its model,
// turns its memory off, gives it a step budget — and the agent is never told. A model asked "why did
// you forget that?" is otherwise guessing about its own constitution, and a guess about yourself
// reads to a user as a lie rather than as missing information.

describe("the lines a colleague reads about itself", () => {
  test("every line states the CONSEQUENCE, not the value", () => {
    // `memory: none` means nothing to a model that has not been told what `none` does to it.
    const text = SelfTool.toModelOutput({
      title: "Bookkeeper",
      model: "spark-holo/holo3.1",
      memory: "none",
      canAddressColleagues: false,
      workingInOwnScratch: false,
    })
    expect(text).toContain("Bookkeeper")
    expect(text).toContain("spark-holo/holo3.1")
    expect(text).toContain("THROWAWAY")
    expect(text).toContain("remember nothing between chats")
    expect(text).toContain("cannot address other colleagues")
  })

  test("a remembering colleague is told what its archive setting DOES", () => {
    const archiving = SelfTool.toModelOutput({ memory: "own", canAddressColleagues: true, workingInOwnScratch: false })
    expect(archiving).toContain("private to you")
    expect(archiving).toContain("archived into your memory")
    const not = SelfTool.toModelOutput({
      memory: "own",
      archiveChats: false,
      canAddressColleagues: true,
      workingInOwnScratch: false,
    })
    // The consequence a user would otherwise discover by losing something: what scrolls out is gone.
    expect(not).toContain("NOT archived")
    expect(not).toContain("is gone")
  })

  test("NAME and FOLDER are never repeated — they are in the system prompt", () => {
    // The owner's line, and not an oversight: two answers to one question disagree eventually, and
    // the model has no way to know which is current.
    const text = SelfTool.toModelOutput({
      title: "Bookkeeper",
      model: "m",
      memory: "own",
      canAddressColleagues: true,
      workingInOwnScratch: true,
    })
    expect(text).not.toContain("Your name")
    // The scratch line says the STATE ("no project"), never a path.
    expect(text).toContain("own scratch folder")
    expect(text).not.toMatch(/[A-Za-z]:[\/]/)
  })

  test("an unpinned model is stated as such, not omitted", () => {
    // Silence would read as "I have no model", which is the one thing that cannot be true.
    const text = SelfTool.toModelOutput({ memory: "own", canAddressColleagues: false, workingInOwnScratch: false })
    expect(text).toContain("default model")
  })

  test("a step budget appears only when there is one", () => {
    const withBudget = SelfTool.toModelOutput({
      memory: "own",
      steps: 12,
      canAddressColleagues: false,
      workingInOwnScratch: false,
    })
    expect(withBudget).toContain("up to 12 steps")
    const without = SelfTool.toModelOutput({ memory: "own", canAddressColleagues: false, workingInOwnScratch: false })
    expect(without).not.toContain("steps")
  })
})
