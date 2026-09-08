import { describe, expect, test } from "bun:test"
import { dict as en } from "@/i18n/en"
import type { ProjectState } from "@/utils/project-api"
import {
  gitignoreImport,
  governedHere,
  normalizeRule,
  planProjectPermissions,
  projectPermissionKeys,
  projectExcludePayload,
  projectPermissionsPayload,
  PROJECT_RULE_EFFECTS,
  ruleIsComplete,
} from "./project-permissions"

/**
 * The Permissions surface's decision logic, tested away from the DOM.
 *
 * 🔴 **Both rules here fail SILENTLY when they are wrong**, which is why they are a module and not
 * three `.filter(…)` chains in a JSX body:
 *
 *  · Offering to save an `allow` rule produces a cheerful receipt and a file whose new sentence the
 *    kernel provably ignores (`evaluateNarrowed` only ever raises restrictiveness).
 *  · Clearing the last rule by sending `permissions: []` leaves a `"permissions": []` line behind
 *    that means exactly what no line means, so the file keeps claiming a section the user removed.
 *
 * ⚠️ **A/B, run by hand:** make `planProjectPermissions` return `omitted: []`, and make
 * `projectPermissionsPayload` return `{ permissions: [] }` for an empty plan — the two 🔴 cases below
 * go red. Both were run.
 */

const rule = (action: string, resource: string, effect: "allow" | "deny" | "ask") => ({ action, resource, effect })

const projectState = (over: Partial<Extract<ProjectState, { kind: "project" }>> = {}): ProjectState => ({
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

describe("what a Project-permissions save will actually write", () => {
  test("🔴 an `allow` rule is separated out — a folder may withhold access, never grant it", () => {
    const plan = planProjectPermissions([
      rule("bash", "*", "deny"),
      rule("read", "secrets/*", "allow"),
      rule("edit", "*", "ask"),
    ])
    expect(plan.persisted).toEqual([rule("bash", "*", "deny"), rule("edit", "*", "ask")])
    expect(plan.omitted).toEqual([rule("read", "secrets/*", "allow")])
    // `declared` is everything, because the payload sends everything and lets the SERVER report
    // what it dropped — a client that pre-filtered would agree with itself forever.
    expect(plan.declared.length).toBe(3)
  })

  test("the effect picker never offers `allow` at all", () => {
    // The control cannot produce a rule that will be refused, so `omitted` is only ever populated by
    // a rule that was ALREADY in the file — which is exactly when a user needs to be told.
    expect([...PROJECT_RULE_EFFECTS]).toEqual(["ask", "deny"])
  })

  test("the payload sends everything declared, not the filtered list", () => {
    const plan = planProjectPermissions([rule("bash", "*", "deny"), rule("read", "*", "allow")])
    expect(projectPermissionsPayload(plan)).toEqual({ permissions: plan.declared })
  })

  test("🔴 removing the last rule CLEARS the section rather than writing an empty list", () => {
    // `[]` and no key at all mean the same thing to the reader, so leaving `"permissions": []`
    // behind is a line in the user's file that says nothing. The `clear` sentinel exists for this.
    expect(projectPermissionsPayload(planProjectPermissions([]))).toEqual({ clear: ["permissions"] })
  })

  test("a rule missing an action or a resource is not offerable", () => {
    expect(ruleIsComplete({ action: "", resource: "*" })).toBe(false)
    expect(ruleIsComplete({ action: "bash", resource: "   " })).toBe(false)
    expect(ruleIsComplete({ action: "bash", resource: "*" })).toBe(true)
    // `*`/`*` deny is a folder that refuses everything: unusual, legal, and not ours to block.
    expect(ruleIsComplete({ action: "*", resource: "*" })).toBe(true)
  })

  test("a rule is trimmed as it will be written", () => {
    expect(normalizeRule(rule("  bash ", " rm * ", "deny"))).toEqual(rule("bash", "rm *", "deny"))
  })
})

const HERE = "C:/work/app"

describe("whether this folder's declaration is its OWN", () => {
  test("🔴 a file in a folder ABOVE this one is not this folder's to edit", () => {
    // The hazard: `POST /api/project` writes THIS folder's file and `walk` stops at the nearest one,
    // so "adding a pattern" to an inherited list would replace that ancestor's whole declaration —
    // Tune and permissions included — for this folder. Nobody predicts that from a button saying Add.
    expect(governedHere(projectState({ root: "C:/work" }), HERE)).toBe(false)
    expect(governedHere(projectState({ root: HERE }), HERE)).toBe(true)
  })

  test("separator style and a trailing slash are not differences", () => {
    // The two strings come from different places — the browser's record and the server's
    // `path.resolve` — so a raw `===` reports a NEW file where an update is about to happen.
    // ⚠️ Not `String.raw` here: a raw template cannot END in a backslash — it escapes the closing
    // backtick and the literal never terminates. Doubled escapes in a plain string instead.
    expect(governedHere(projectState({ root: "C:\\work\\app\\" }), HERE)).toBe(true)
    expect(governedHere(projectState({ root: "C:/Work/App" }), HERE)).toBe(true)
  })

  test("no project file at all is not an inherited one", () => {
    expect(governedHere({ kind: "none" }, HERE)).toBe(false)
    expect(governedHere(undefined, HERE)).toBe(false)
  })
})

describe("what a .gitignore import can offer", () => {
  test("no project file means there is nothing to import INTO", () => {
    expect(gitignoreImport({ kind: "none" }, HERE).kind).toBe("no-project")
    expect(gitignoreImport(undefined, HERE).kind).toBe("no-project")
  })

  test("🔴 an INHERITED declaration is explained, never offered as an import target", () => {
    const state = gitignoreImport(
      projectState({
        root: "C:/work",
        file: "C:/work/novaclaw.json",
        gitignore: { file: "C:/work/.gitignore", add: ["dist"], already: [], dropped: [], reincludes: [] },
      }),
      HERE,
    )
    // There IS something to add, and it is still refused: importing would create a second file here
    // that takes over from the ancestor rather than extending it.
    expect(state.kind).toBe("elsewhere")
    if (state.kind !== "elsewhere") return
    expect(state.file).toBe("C:/work/novaclaw.json")
  })

  test("a project without a .gitignore says so rather than hiding the control", () => {
    // Principle 12(d): a capability that only appears once you already use it teaches nobody that
    // it exists. "There is no .gitignore here" is a state, not an absence.
    expect(gitignoreImport(projectState(), HERE).kind).toBe("no-file")
  })

  test("a .gitignore whose every line is already covered is its own state", () => {
    const state = gitignoreImport(
      projectState({
        exclude: ["node_modules", ".env"],
        gitignore: {
          file: "C:/work/app/.gitignore",
          add: [],
          already: ["node_modules", ".env"],
          dropped: [],
          reincludes: [],
        },
      }),
      HERE,
    )
    expect(state.kind).toBe("nothing-new")
    if (state.kind !== "nothing-new") return
    expect(state.already).toBe(2)
  })

  test("🔴 a proposal APPENDS to the existing list, keeping its order and its precedence", () => {
    const state = gitignoreImport(
      projectState({
        exclude: ["secrets/**"],
        gitignore: {
          file: "C:/work/app/.gitignore",
          add: ["node_modules", "!keep.log"],
          already: [],
          dropped: [{ source: "foo\\ ", reason: "escape" }],
          reincludes: ["!keep.log"],
        },
      }),
      HERE,
    )
    expect(state.kind).toBe("ready")
    if (state.kind !== "ready") return
    // Order IS meaning — `evaluate` resolves by last match, so sorting or interleaving would change
    // which rule wins for a path two of them match.
    expect(state.exclude).toEqual(["secrets/**", "node_modules", "!keep.log"])
    // The two things a person must see before pressing the button.
    expect(state.reincludes).toEqual(["!keep.log"])
    expect(state.dropped).toEqual([{ source: "foo\\ ", reason: "escape" }])
  })
})

describe("what an exclusion-list edit will write", () => {
  test("🔴 removing the last pattern CLEARS the section rather than writing an empty list", () => {
    // `"exclude": []` reads on a later visit as "someone configured this to be empty", which is a
    // different (and false) statement from "nobody has set one".
    expect(projectExcludePayload([])).toEqual({ clear: ["exclude"] })
    expect(projectExcludePayload(["  ", ""])).toEqual({ clear: ["exclude"] })
  })

  test("order is preserved, never sorted — the last matching pattern wins", () => {
    expect(projectExcludePayload(["*.env", "!.env.example", "secrets/"])).toEqual({
      exclude: ["*.env", "!.env.example", "secrets/"],
    })
  })

  test("patterns are trimmed, and a blank line never becomes a pattern", () => {
    // A blank pattern would compile to nothing and sit in the file forever looking meaningful.
    expect(projectExcludePayload([" secrets/ ", "", "  ", "*.pem"])).toEqual({
      exclude: ["secrets/", "*.pem"],
    })
  })
})

describe("the copy this surface renders", () => {
  test("🔴 every key it can ask for is in en.ts", () => {
    // `t()` hands back the key itself for a miss, behind a signature claiming `string`, so a removed
    // key reaches a user as `settings.permissions.project.narrowing` where a sentence should be.
    const dictionary = en as unknown as Record<string, string>
    const missing = projectPermissionKeys.filter((key) => typeof dictionary[key] !== "string")
    expect(missing).toEqual([])
  })

  test("the guard is not vacuous", () => {
    expect(projectPermissionKeys.length).toBeGreaterThan(30)
  })

  test("the three origins are each named AND explained — a label alone answers nothing", () => {
    const dictionary = en as unknown as Record<string, string>
    for (const origin of ["project", "personal", "session"]) {
      expect(dictionary[`settings.permissions.project.origin.${origin}`]!.length).toBeGreaterThan(3)
      expect(
        dictionary[`settings.permissions.project.origin.${origin}Detail`]!.length,
        `${origin} needs to say where it is CHANGED, not just what it is`,
      ).toBeGreaterThan(40)
    }
  })

  test("🔴 the exclusion import copy distinguishes a .gitignore from dedicated-tool exclusions", () => {
    // Read eligibility must stay distinct from watcher/build ignores, and the
    // only place a user meets that distinction is this sentence. A rewrite that drops it turns a
    // confirmed suggestion back into "these look the same, click yes".
    const text = (en as unknown as Record<string, string>)["settings.project.exclude.import.distinct"]!
    expect(text).toContain(".gitignore")
    expect(text.toLowerCase()).toContain("committed")
    expect(text).toContain("file and search tools")
    expect(text.toLowerCase()).not.toContain("never")
  })
})
