import { describe, expect, test } from "bun:test"
import { dict as en } from "@/i18n/en"
import type { Translator } from "@/context/language"
import type { ProjectState } from "@/utils/project-api"
import { projectSectionCopy, projectSectionCopyKeys } from "./project-copy"

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Settings → Project renders exactly what `projectSectionCopy` returns, so the strings asserted here
// ARE the strings on screen.
//
// 🔴 THE DEFECT THIS FILE PINS. The section's subject is the INSTANCE's folder, and no sentence in it
// ever said so or named it. "This folder is not a Project" / "Add a novaclaw.json HERE" have no
// antecedent, and on a desktop launch the instance's folder is the user's home — so the section read
// as an offer to make `C:\Users\<name>` a Project to a reader who had a project chat open. Two
// separate readers concluded a working feature was broken. An unnamed subject is the whole bug.
//
// ⚠️ So the load-bearing assertion is not "the copy is nice", it is `toContain(DIR)` on every state.
// The A/B for this file is to delete one `{{directory}}` from `en.ts` (or drop the interpolation in
// `project-copy.ts`) — every test below that names that state must go red. Verified by doing it.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The real translator, over the real dictionary — the same resolution the app performs. */
const translate: Translator = (key, params) => {
  const template = (en as Record<string, string>)[key as string]
  if (template === undefined) throw new Error(`missing i18n key: ${String(key)}`)
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    name in params ? String(params[name as keyof typeof params]) : whole,
  )
}

const HOME = "C:\\Users\\nangl"
const DIR = "C:\\work\\app"

const project = (over: Partial<Extract<ProjectState, { kind: "project" }>> = {}): ProjectState => ({
  kind: "project",
  root: DIR,
  file: `${DIR}\\novaclaw.json`,
  permissionRules: 0,
  permissions: [],
  exclude: [],
  skills: [],
  skillsRefused: [],
  ...over,
})

const copyFor = (state: ProjectState, directory = DIR, home = HOME) =>
  projectSectionCopy({ state, directory, home, t: translate })!

describe("Settings → Project copy", () => {
  test("every key it can ask for is in en.ts", () => {
    const missing = projectSectionCopyKeys.filter((key) => !(key in (en as Record<string, string>)))
    expect(missing).toEqual([])
  })

  test("nothing is claimed before the server has answered", () => {
    expect(projectSectionCopy({ state: undefined, directory: DIR, home: HOME, t: translate })).toBeUndefined()
  })

  test("nothing is claimed before the instance has said where it is", () => {
    // The guard restated: a section that does not know its subject must not describe one. Without
    // this it would render "  is not a Project" with an empty path.
    for (const nowhere of ["", "   "])
      expect(projectSectionCopy({ state: { kind: "none" }, directory: nowhere, home: HOME, t: translate })).toBeUndefined()
  })

  // ── The rule, applied to every state at once ────────────────────────────────────────────────────
  describe("🔴 the folder is NAMED in every state", () => {
    const STATES: ReadonlyArray<readonly [string, ProjectState]> = [
      ["a Project with a name", project({ name: "Nova" })],
      ["a Project with no name", project()],
      ["a Project declared in an ancestor", project({ root: "C:\\work", file: "C:\\work\\novaclaw.json" })],
      ["not a Project", { kind: "none" }],
      ["an unreadable project file", { kind: "invalid", file: `${DIR}\\novaclaw.json`, reason: "unreadable", detail: "bad json" }],
      ["a file from a newer NovaClaw", { kind: "invalid", file: `${DIR}\\novaclaw.json`, reason: "future-version", detail: "" }],
    ]

    for (const [label, state] of STATES) {
      test(`${label}: the subject line names it`, () => {
        expect(copyFor(state).subject).toContain(DIR)
      })
      test(`${label}: the head row names it`, () => {
        expect(copyFor(state).title).toContain(DIR)
      })
      test(`${label}: none of the un-named sentences that caused this can come back`, () => {
        // A ledger against the exact strings that shipped. "This folder" and "here" are fine INSIDE a
        // row whose own title names the path one line up (the assertion above guarantees that) —
        // what was wrong is a sentence carrying the whole claim with no antecedent anywhere on
        // screen. These three are those sentences, verbatim as they were.
        const copy = copyFor(state)
        for (const gone of [
          "This folder is not a Project",
          "Add a novaclaw.json here to give the folder its own defaults",
          "This folder's novaclaw.json could not be used",
        ]) {
          expect(copy.subject).not.toContain(gone)
          expect(copy.title).not.toContain(gone)
          expect(copy.description).not.toContain(gone)
        }
      })
    }
  })

  describe("a folder that is not a Project", () => {
    test("says so with the folder's name, and stays a normal state rather than an error", () => {
      const copy = copyFor({ kind: "none" })
      expect(copy.kind).toBe("none")
      expect(copy.atHome).toBe(false)
      expect(copy.title).toBe("C:\\work\\app is not a Project")
      expect(copy.description).toBe(
        "Add a novaclaw.json to C:\\work\\app to give that folder its own defaults. Without one it works exactly as it does now.",
      )
    })

    test("the subject line says whose folder this is, so the open chat is not mistaken for it", () => {
      // The correction the two wrong readings needed, in the copy rather than in a comment.
      expect(copyFor({ kind: "none" }).subject).toContain("the folder this instance itself is working in")
      expect(copyFor({ kind: "none" }).subject).toContain("does not follow whichever chat you have open")
    })
  })

  // ── principle 11: the home's top level is somewhere we are careful about writing ────────────────
  describe("when the instance's folder IS the user's home", () => {
    const atHome = () => copyFor({ kind: "none" }, HOME, HOME)

    test("it is recognised as the home rather than treated as any other folder", () => {
      expect(atHome().atHome).toBe(true)
      expect(copyFor({ kind: "none" }, DIR, HOME).atHome).toBe(false)
    })

    test("the subject line explains WHY the folder is the home", () => {
      expect(atHome().subject).toContain("your home folder")
      expect(atHome().subject).toContain(HOME)
      expect(atHome().subject).toContain("was not started in a working folder")
    })

    test("the generic 'add a novaclaw.json here' invitation is NOT what a home reader gets", () => {
      // The exact sentence that made this look like a bug. It must not appear on the home folder.
      expect(atHome().description).not.toContain("to give that folder its own defaults")
      expect(atHome().title).toBe("Your home folder is not a Project")
    })

    test("it teaches what a Project at the top of the home would cover, instead of hiding the control", () => {
      // Principle 8 — teach, don't gatekeep. The controls below stay available in both branches; what
      // changes is that the reader is told what accepting the offer would actually mean.
      const { description } = atHome()
      expect(description).toContain("every chat you start anywhere inside it")
      expect(description).toContain("on a single working folder instead")
      expect(description).toContain(HOME)
      expect(description).toContain("That is the normal state")
    })

    test("the home match survives separator and case spelling differences", () => {
      // `path.home` and `path.directory` come from one process but not necessarily one spelling, and
      // the whole home branch turns on this comparison.
      for (const spelling of ["C:/Users/nangl", "c:\\users\\nangl", "C:\\Users\\nangl\\"])
        expect(copyFor({ kind: "none" }, spelling, HOME).atHome).toBe(true)
    })
  })

  describe("a folder that IS a Project", () => {
    test("names the folder and the Project", () => {
      const copy = copyFor(project({ name: "Nova" }))
      expect(copy.kind).toBe("project")
      expect(copy.title).toBe("C:\\work\\app belongs to the Project “Nova”")
      expect(copy.description).toBe("The novaclaw.json that says so is in this folder.")
    })

    test("an unnamed Project still names the folder — the row used not to render at all", () => {
      expect(copyFor(project()).title).toBe("C:\\work\\app belongs to a Project")
    })

    test("a file in an ANCESTOR says so, and names the ancestor", () => {
      // "Declared in C:\work\novaclaw.json" alone cannot tell a reader that the file governs more
      // than the folder on screen. This is the second half of the same naming defect.
      const copy = copyFor(project({ root: "C:\\work", file: "C:\\work\\novaclaw.json" }))
      expect(copy.description).toBe(
        "The novaclaw.json that says so is in C:\\work, above this folder — it governs this folder and everything else beneath that one.",
      )
    })

    test("a blank name is not a name", () => {
      expect(copyFor(project({ name: "   " })).title).toBe("C:\\work\\app belongs to a Project")
    })
  })

  describe("a project file that could not be used", () => {
    test("names the folder, and keeps the two remedies apart", () => {
      const broken = copyFor({ kind: "invalid", file: `${DIR}\\novaclaw.json`, reason: "unreadable", detail: "bad json" })
      expect(broken.title).toBe("The novaclaw.json in C:\\work\\app could not be used")
      expect(broken.description).toBe("The file could not be read: bad json")

      const future = copyFor({ kind: "invalid", file: `${DIR}\\novaclaw.json`, reason: "future-version", detail: "" })
      expect(future.title).toBe("The novaclaw.json in C:\\work\\app could not be used")
      expect(future.description).toContain("Update NovaClaw")
      // 🔴 The collapse that must never pass: "update NovaClaw" and "fix your file" are opposite
      // actions, and one message covering both sends half its readers the wrong way.
      expect(future.description).not.toBe(broken.description)
    })
  })
})
