import { describe, expect, test } from "bun:test"
import { dict as en } from "@/i18n/en"
import type { Translator } from "@/context/language"
import type { ProjectState } from "@/utils/project-api"
import { projectSummary, projectSummaryKeys, type ProjectScope } from "./project-summary"

// The Chats and Files project surfaces render exactly what `projectSummary` returns, so the strings
// asserted here ARE the strings on screen. Three kinds and two invalid reasons, both scopes.
//
// ⚠️ What must not pass: a summary that lets "there is no project file here" and "your project file
// was ignored" read the same. That collapse is the one an implementation makes by accident, and it
// tells a user their settings are absent when in fact they are being thrown away.

/** The real translator, over the real dictionary — the same resolution the app performs. */
const translate: Translator = (key, params) => {
  const template = (en as Record<string, string>)[key as string]
  if (template === undefined) throw new Error(`missing i18n key: ${String(key)}`)
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    name in params ? String(params[name as keyof typeof params]) : whole,
  )
}

const SCOPES: readonly ProjectScope[] = ["chat", "files"]

const project = (over: Partial<Extract<ProjectState, { kind: "project" }>> = {}): ProjectState => ({
  kind: "project",
  root: "C:/work/app",
  file: "C:/work/app/novaclaw.json",
  permissionRules: 0,
  permissions: [],
  exclude: [],
  skills: [],
  skillsRefused: [],
  ...over,
})

describe("projectSummary", () => {
  test("every key it can ask for is in en.ts", () => {
    const missing = SCOPES.flatMap((scope) =>
      projectSummaryKeys(scope).filter((key) => !(key in (en as Record<string, string>))),
    )
    expect(missing).toEqual([])
  })

  test("nothing is claimed before the server has answered", () => {
    for (const scope of SCOPES) expect(projectSummary(undefined, translate, scope)).toBeUndefined()
  })

  describe("a folder with no project file", () => {
    test("reads as a normal state, not an error and not a missing setup step", () => {
      const chat = projectSummary({ kind: "none" }, translate, "chat")!
      expect(chat.kind).toBe("none")
      expect(chat.tone).toBe("plain")
      expect(chat.label).toBe("Folder")
      expect(chat.headline).toBe(
        "This chat's folder is not a Project. It uses your normal settings — that is a perfectly good way to work.",
      )
      // Nothing to explain: a folder without a file contributes nothing, and inventing a line would
      // make the absence look like a defect.
      expect(chat.contributes).toEqual([])
      expect(chat.file).toBeUndefined()
      expect(chat.root).toBeUndefined()

      const files = projectSummary({ kind: "none" }, translate, "files")!
      expect(files.headline).toBe(
        "This folder is not a Project. Chats you start here use your normal settings — that is a perfectly good way to work.",
      )
    })

    test("still teaches what a Project is — the state a curious user most needs it explained in", () => {
      for (const scope of SCOPES) {
        const summary = projectSummary({ kind: "none" }, translate, scope)!
        expect(summary.teach).toContain("A Project is simply a folder with a novaclaw.json file in it.")
      }
    })
  })

  describe("a folder that IS a Project", () => {
    test("names it, and names the file that says so", () => {
      const summary = projectSummary(project({ name: "Acme" }), translate, "files")!
      expect(summary.kind).toBe("project")
      expect(summary.tone).toBe("project")
      expect(summary.label).toBe("Project")
      expect(summary.headline).toBe("This folder belongs to the Project “Acme”.")
      expect(summary.root).toBe("C:/work/app")
      // The whole point of the surface: a refused tool call is traceable to a path on screen.
      expect(summary.file).toBe("C:/work/app/novaclaw.json")
    })

    test("an unnamed project still reads as a project rather than as a blank name", () => {
      expect(projectSummary(project(), translate, "files")!.headline).toBe("This folder belongs to a Project.")
      expect(projectSummary(project(), translate, "chat")!.headline).toBe("This chat runs in a Project folder.")
      // A name that is only whitespace is not a name.
      expect(projectSummary(project({ name: "   " }), translate, "chat")!.headline).toBe(
        "This chat runs in a Project folder.",
      )
    })

    test("says how many permission rules it contributes, and that they can only narrow", () => {
      const none = projectSummary(project(), translate, "files")!
      expect(none.contributes[0]).toBe("It changes no permissions.")

      const one = projectSummary(project({ permissionRules: 1 }), translate, "files")!
      expect(one.contributes[0]).toBe(
        "One permission rule comes from this file. A Project can only narrow what the agent may do, never widen it.",
      )

      const many = projectSummary(project({ permissionRules: 4 }), translate, "files")!
      expect(many.contributes[0]).toBe(
        "4 permission rules come from this file. A Project can only narrow what the agent may do, never widen it.",
      )
      // No stray `{{count}}` survives interpolation.
      for (const summary of [none, one, many]) for (const line of summary.contributes) expect(line).not.toContain("{{")
    })

    test("lists the exclusions when there are any, and says nothing when there are none", () => {
      const with_ = projectSummary(project({ exclude: ["secrets/**", ".env"] }), translate, "files")!
      expect(with_.contributes).toContain("It asks Nova not to read: secrets/**, .env")
      const without = projectSummary(project(), translate, "files")!
      expect(without.contributes.some((line) => line.startsWith("It asks Nova not to read"))).toBe(false)
    })

    test("the chat scope points at Tune instead of restating which switches it set", () => {
      // The route carries no tune detail; the composer's Tune panel reads the RESOLVED config and is
      // the authority. Pointing beats guessing — a wrong list here would contradict the panel.
      const chat = projectSummary(project(), translate, "chat")!
      expect(chat.contributes).toContain("Tune, under the message box, lists the settings it handed to this chat.")
      // Files has no composer, so it must not tell a file browser to look under a message box.
      const files = projectSummary(project(), translate, "files")!
      expect(files.contributes.some((line) => line.includes("message box"))).toBe(false)
    })
  })

  describe("a project file that could not be used", () => {
    const broken: ProjectState = {
      kind: "invalid",
      file: "C:/work/app/novaclaw.json",
      reason: "unreadable",
      detail: "Unexpected token } at position 42",
    }
    const future: ProjectState = {
      kind: "invalid",
      file: "C:/work/app/novaclaw.json",
      reason: "future-version",
      detail: "version 9999",
    }

    test("says the settings are NOT in force — never a silent fallback", () => {
      for (const scope of SCOPES) {
        const summary = projectSummary(broken, translate, scope)!
        expect(summary.kind).toBe("invalid")
        expect(summary.tone).toBe("warning")
        expect(summary.label).toBe("Project not applied")
        expect(summary.headline).toContain("could not be used")
        expect(summary.headline).toContain("nothing in it is in force")
        expect(summary.headline).toContain("normal settings")
        // The file is named, because fixing it is the next move.
        expect(summary.file).toBe("C:/work/app/novaclaw.json")
      }
    })

    test("🔴 an unusable file never reads like a folder that simply has no project", () => {
      for (const scope of SCOPES) {
        const invalid = projectSummary(broken, translate, scope)!
        const none = projectSummary({ kind: "none" }, translate, scope)!
        expect(invalid.headline).not.toBe(none.headline)
        expect(invalid.label).not.toBe(none.label)
        expect(invalid.tone).not.toBe(none.tone)
      }
    })

    test("the two reasons give OPPOSITE instructions, and neither is a stack trace", () => {
      const brokenSummary = projectSummary(broken, translate, "files")!
      expect(brokenSummary.contributes).toEqual(["The file could not be read: Unexpected token } at position 42"])

      const futureSummary = projectSummary(future, translate, "files")!
      expect(futureSummary.contributes).toEqual([
        "It was written by a newer NovaClaw. Update NovaClaw to use it — the file itself is probably fine.",
      ])

      // "Update NovaClaw" and "fix your file" must never be the same sentence: half the readers
      // would be sent the wrong way.
      expect(futureSummary.contributes[0]).not.toBe(brokenSummary.contributes[0])
      // A future-version file is NOT described as broken — the file is probably fine.
      expect(futureSummary.contributes[0]).not.toContain("could not be read")
    })

    test("both scopes take the remedy from the same place Settings does", () => {
      // Single-sourced on purpose: three surfaces telling a user three things about one file is the
      // failure this shares the key to avoid.
      const chat = projectSummary(future, translate, "chat")!
      const files = projectSummary(future, translate, "files")!
      expect(chat.contributes).toEqual(files.contributes)
      expect(chat.contributes[0]).toBe((en as Record<string, string>)["settings.project.invalidFuture"])
    })

    test("still teaches, and does not offer a rule count it cannot know", () => {
      const summary = projectSummary(broken, translate, "chat")!
      expect(summary.teach).toContain("A Project is simply a folder")
      expect(summary.contributes.some((line) => line.includes("permission rule"))).toBe(false)
      expect(summary.root).toBeUndefined()
    })
  })

  test("no rendered sentence leaks a raw key or an unresolved placeholder", () => {
    const states: ProjectState[] = [
      { kind: "none" },
      project({ name: "Acme", permissionRules: 3, exclude: ["a/**"] }),
      project(),
      { kind: "invalid", file: "f", reason: "unreadable", detail: "bad" },
      { kind: "invalid", file: "f", reason: "future-version", detail: "9999" },
    ]
    for (const scope of SCOPES) {
      for (const state of states) {
        const summary = projectSummary(state, translate, scope)!
        for (const text of [summary.label, summary.headline, summary.teach, ...summary.contributes]) {
          expect(text).toBeString()
          expect(text.trim()).not.toBe("")
          expect(text).not.toContain("{{")
          expect(text).not.toMatch(/^(chat|files|settings)\.project\./)
        }
      }
    }
  })
})
