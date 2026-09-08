import { describe, expect, test } from "bun:test"
import { canWriteFolder, folderSkillWrite, folderWritability } from "./project-skills"
import type { ProjectState } from "@/utils/project-api"

/**
 * The FOLDER control on the Skills page.
 *
 * **A/B (run each and watch it go red):**
 *  · delete the `input.hide === held.has(id)` early return in `folderSkillWrite` — the `no-op` tests fail.
 *  · make the un-hide branch write `{show:true}` instead of deleting the key — 🔴 *"there is no
 *    un-hide to write"* fails. That is the whole narrowing law on this seam.
 *  · drop the `key !== id` guard in the refused loop — 🔴 *"un-hiding an id the FILE asked to show"* fails.
 *  · return `{kind:"updates"}` for an ancestor in `folderWritability` — 🔴 *"an ancestor's file"* fails.
 *  · delete the `idOf` guard — the unaddressable cases fail.
 */

const project = (over: Partial<Extract<ProjectState, { kind: "project" }>> = {}): ProjectState => ({
  kind: "project",
  root: "C:\\work\\app",
  file: "C:\\work\\app\\novaclaw.json",
  permissionRules: 0,
  permissions: [],
  exclude: [],
  skills: [],
  skillsRefused: [],
  ...over,
})

describe("what a save would DO, said before the control", () => {
  test("this folder's own file: a save updates the file in front of you", () => {
    const state = folderWritability(project(), "C:\\work\\app")
    expect(state).toEqual({ kind: "updates", file: "C:\\work\\app\\novaclaw.json" })
    expect(canWriteFolder(state)).toBe(true)
  })

  test("separator style and a trailing slash are not two folders", () => {
    expect(folderWritability(project(), "C:/work/app/").kind).toBe("updates")
  })

  test("no project at all: a save creates one here, shadowing nothing", () => {
    const state = folderWritability({ kind: "none" }, "C:\\work\\app")
    expect(state).toEqual({ kind: "creates" })
    expect(canWriteFolder(state)).toBe(true)
  })

  test("🔴 an ancestor's file governs: WITHHELD, because a new file here would shadow the whole thing", () => {
    const state = folderWritability(project({ root: "C:\\work", file: "C:\\work\\novaclaw.json" }), "C:\\work\\app")
    expect(state).toEqual({ kind: "shadowed", file: "C:\\work\\novaclaw.json" })
    expect(canWriteFolder(state)).toBe(false)
  })

  test("a file that does not parse: withheld, and the reason is the file's, not ours", () => {
    const state = folderWritability(
      { kind: "invalid", file: "C:\\work\\app\\novaclaw.json", reason: "unreadable", detail: "…" },
      "C:\\work\\app",
    )
    expect(state).toEqual({ kind: "invalid", file: "C:\\work\\app\\novaclaw.json" })
    expect(canWriteFolder(state)).toBe(false)
  })

  test("not told yet claims nothing", () => {
    expect(folderWritability(undefined, "C:\\work\\app")).toEqual({ kind: "unknown" })
    expect(folderWritability(project(), "")).toEqual({ kind: "unknown" })
    expect(canWriteFolder({ kind: "unknown" })).toBe(false)
  })
})

describe("hiding a skill for this folder", () => {
  test("the first hide writes the whole section with one entry", () => {
    const write = folderSkillWrite({ hidden: [], refused: [], name: "pdf", hide: true })
    expect(write.kind).toBe("set")
    expect({ ...(write as { skills: object }).skills }).toEqual({ pdf: { show: false } })
  })

  test("a second hide preserves the first, sorted", () => {
    const write = folderSkillWrite({ hidden: ["xlsx"], refused: [], name: "pdf", hide: true })
    expect(Object.keys((write as { skills: object }).skills)).toEqual(["pdf", "xlsx"])
  })

  test("hiding something already hidden costs nothing", () => {
    expect(folderSkillWrite({ hidden: ["pdf"], refused: [], name: "pdf", hide: true })).toEqual({ kind: "no-op" })
  })
})

describe("🔴 there is no un-hide to write — a folder may only ever hide", () => {
  test("turning the folder switch off DELETES the folder's line rather than writing show:true", () => {
    const write = folderSkillWrite({ hidden: ["pdf", "xlsx"], refused: [], name: "pdf", hide: false })
    expect(write.kind).toBe("set")
    const skills = (write as { skills: Record<string, unknown> }).skills
    expect(Object.hasOwn(skills, "pdf")).toBe(false)
    expect(skills["xlsx"]).toEqual({ show: false })
    // Nothing this function can emit carries a `show:true` for the id being toggled — that value is
    // what `ProjectFile.narrowSkills` drops on every read, so writing one is a line with no reader.
    expect(JSON.stringify(write)).not.toContain('"pdf":{"show":true}')
  })

  test("removing the LAST hidden id clears the section rather than leaving an empty object", () => {
    expect(folderSkillWrite({ hidden: ["pdf"], refused: [], name: "pdf", hide: false })).toEqual({ kind: "clear" })
  })

  test("un-hiding something the folder never hid costs nothing", () => {
    expect(folderSkillWrite({ hidden: [], refused: [], name: "pdf", hide: false })).toEqual({ kind: "no-op" })
  })
})

describe("the file's own inert lines", () => {
  test("a show:true the FILE carries rides along, so the server refuses it BY NAME", () => {
    const write = folderSkillWrite({ hidden: [], refused: ["docx"], name: "pdf", hide: true })
    expect({ ...(write as { skills: object }).skills }).toEqual({ pdf: { show: false }, docx: { show: true } })
  })

  test("🔴 un-hiding an id the FILE asked to show does not re-assert the line the user just overrode", () => {
    const write = folderSkillWrite({ hidden: ["pdf"], refused: ["pdf"], name: "pdf", hide: false })
    expect(write).toEqual({ kind: "clear" })
  })

  test("a lone show:true keeps the section alive rather than being cleared without a receipt", () => {
    const write = folderSkillWrite({ hidden: ["pdf"], refused: ["docx"], name: "pdf", hide: false })
    expect({ ...(write as { skills: object }).skills }).toEqual({ docx: { show: true } })
  })
})

describe("a name that cannot be written down has no key to write", () => {
  for (const name of ["pdf*", "a\u200bb", "e\u0301", "x".repeat(129)])
    test(`"${name.slice(0, 12)}" is refused rather than mangled into a key`, () => {
      expect(folderSkillWrite({ hidden: [], refused: [], name, hide: true })).toEqual({ kind: "unaddressable" })
    })
})

describe("a key of __proto__ lands as an own property, never on the prototype", () => {
  test("the emitted object is null-prototyped and serialises as data", () => {
    const write = folderSkillWrite({ hidden: [], refused: [], name: "__proto__", hide: true })
    const skills = (write as { skills: Record<string, unknown> }).skills
    expect(Object.hasOwn(skills, "__proto__")).toBe(true)
    expect(JSON.parse(JSON.stringify(skills))).toEqual({ __proto__: { show: false } })
    expect(({} as Record<string, unknown>)["show"]).toBeUndefined()
  })
})
