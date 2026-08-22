import { describe, expect, test } from "bun:test"
import { SystemCompose } from "./system-compose"

// A THROWAWAY MUST KNOW IT IS ONE.
//
// 🔴 Measured live on holo3.1 2026-08-22: a colleague configured `memory: "none"` was asked to
// remember something for later and answered *"Yes, I've stored the information."* It had written a
// TODO. The disclosure existed in the Contacts dialog (which tells the USER) and in the `self` tool
// (which a model reads only if it thinks to ask about itself); the prompt said nothing, so the model
// assumed it had memory — as almost every model it was trained on does.

describe("the memory stance section", () => {
  test("a throwaway is TOLD, in words it can act on", () => {
    const section = SystemCompose.memoryStanceSection({ memory: "none", archiveChats: undefined })
    expect(section).toBeDefined()
    // The instruction has to survive being skimmed: the fact, and what to do instead.
    expect(section).toContain("NO long-term memory")
    expect(section!.toLowerCase()).toContain("say plainly that you cannot")
    // 🔴 The sentence aimed at the measured failure. Without it the model has been told a fact and
    // not told which answer that fact forbids.
    expect(section).toContain("Never")
    expect(section).toContain("stored")
  })

  test("a colleague WITH memory gets nothing — silence is the correct default", () => {
    // Having memory is the assumption a model already arrives with, so stating it would be dead text
    // in nearly every prompt. Same rule as `toolDiscoverySection`'s zero-count case.
    expect(SystemCompose.memoryStanceSection({ memory: "own", archiveChats: undefined })).toBeUndefined()
  })

  // 🔴 THE SECOND WAY a colleague is wrong about its own recall, and the subtler one: it keeps
  // memories and can search them, so nothing in its experience says the older half of THIS
  // conversation is unreachable. `self.ts` already carried the sentence; the prompt did not.
  test("a colleague whose chat is NOT archived is told what it loses — and what it keeps", () => {
    const section = SystemCompose.memoryStanceSection({ memory: "own", archiveChats: false })
    expect(section).toBeDefined()
    expect(section).toContain("NOT archived")
    // ⚠️ The other half. Told only "not archived", a colleague would reasonably conclude its memory
    // is off — it is not, and saying so would make a working colleague refuse to look things up.
    expect(section!.toLowerCase()).toContain("still search them")
    expect(section).toContain("do not promise to find it again")
  })

  test("a THROWAWAY gets the throwaway text, not the archive one — it keeps nothing either way", () => {
    // `shouldArchive` already refuses for `memory: "none"`, so the two would otherwise both apply and
    // the colleague would be told twice, in two different voices, about one fact.
    const section = SystemCompose.memoryStanceSection({ memory: "none", archiveChats: false })
    expect(section).toContain("NO long-term memory")
    expect(section).not.toContain("still search them")
  })

  test("archiving ON is silence, like every other default", () => {
    expect(SystemCompose.memoryStanceSection({ memory: "own", archiveChats: true })).toBeUndefined()
  })

  test("an UNDECLARED stance gets nothing either", () => {
    // `undefined` is a colleague that never set the field, which defaults to having memory. Emitting
    // the throwaway text here would tell most colleagues on the roster something false about
    // themselves — worse than the silence it replaced.
    expect(SystemCompose.memoryStanceSection({ memory: undefined, archiveChats: undefined })).toBeUndefined()
  })

  test("it composes as KERNEL material a persona cannot bury", () => {
    // Ordered after the agent's own system prompt and the persona, so a brief that says "I'll
    // remember that for you" cannot sit on top of the fact that nothing is kept.
    const parts = SystemCompose.composeSystemParts({
      persona: "You are Mnemo. You never forget.",
      agentSystem: "Keep notes for the user.",
      memoryStance: SystemCompose.memoryStanceSection({ memory: "none", archiveChats: undefined }),
      base: "kernel base",
    })
    expect(parts.indexOf(SystemCompose.memoryStanceSection({ memory: "none", archiveChats: undefined })!)).toBeGreaterThan(
      parts.indexOf("Keep notes for the user."),
    )
  })
})

// BOTH FOLDERS — the colleague's own workspace alongside the project (owner, 2026-08-22).
describe("the workspace section", () => {
  const scratch = "C:/data/scratch/theron"

  test("an assigned colleague is told about BOTH folders", () => {
    const section = SystemCompose.workspaceSection({ directory: "D:/books", scratch })
    expect(section).toBeDefined()
    expect(section).toContain(scratch)
    // 🔴 It has to say what goes WHERE, not merely that the folder exists. "You have a scratch dir"
    // leaves a model to guess whether its notes belong there or in the user's repository.
    expect(section!.toLowerCase()).toContain("notes to yourself")
    expect(section!.toLowerCase()).toContain("part of the work still belongs in the working folder")
  })

  test("an UNASSIGNED colleague gets nothing — it already works there", () => {
    // Naming the same directory twice, once as "the working folder" and once as "somewhere else",
    // is worse than silence.
    expect(SystemCompose.workspaceSection({ directory: scratch, scratch })).toBeUndefined()
  })

  test("the same folder in a different SPELLING is still the same folder", () => {
    // Windows hands the session a backslashed path and `Scratch.forAgent` a joined one; comparing
    // them literally would tell an unassigned colleague it has two workspaces.
    expect(SystemCompose.workspaceSection({ directory: String.raw`C:\data\scratch\theron`, scratch })).toBeUndefined()
  })

  test("nothing is claimed when either half is unknown", () => {
    expect(SystemCompose.workspaceSection({ directory: undefined, scratch })).toBeUndefined()
    expect(SystemCompose.workspaceSection({ directory: "D:/books", scratch: undefined })).toBeUndefined()
  })

  test("it lands AFTER project scope, which says the opposite about scratch", () => {
    // `projectScope` says "keep scratch files and notes inside [the working folder]" — right for a
    // session with one folder, wrong for a colleague with a workspace. The specific rule must be the
    // one a model reads last.
    const parts = SystemCompose.composeSystemParts({
      projectScope: SystemCompose.projectScopeSection("bypass"),
      workspace: SystemCompose.workspaceSection({ directory: "D:/books", scratch })!,
      base: "kernel base",
    })
    expect(parts.indexOf(SystemCompose.workspaceSection({ directory: "D:/books", scratch })!)).toBeGreaterThan(
      parts.indexOf(SystemCompose.projectScopeSection("bypass")!),
    )
  })
})
