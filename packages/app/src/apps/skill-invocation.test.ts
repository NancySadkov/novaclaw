import { describe, expect, test } from "bun:test"
import { SkillInvocation } from "@novaclaw/core/skill/invocation"
import {
  forgetPath,
  invocationOf,
  invocationWrite,
  ONLY_WHEN_I_CHOOSE,
  orphanedChoices,
  type Enablement,
  type PermissionRule,
} from "./skill-invocation"

// ⚠️ Every hostile character here is an ESCAPE, matching `skills.test.ts` — a literal in a source
// file is how a zero-width character reaches the bundle and every grep over the tree.
const RLO = "\u202E"  // right-to-left override
const ZWSP = "\u200B"

const enablement = (state: Enablement["state"] = "asks"): Enablement =>
  state === "unknown" ? { state } : { state, allow: 1, ask: 1, deny: state === "blocked" ? 2 : 0 }

const read = (over: Partial<Parameters<typeof invocationOf>[0]> = {}) =>
  invocationOf({ name: "pdf", rules: [], store: undefined, enablement: enablement(), ...over })

describe("what the page says is in force", () => {
  test("a fresh install: both on, and the pair names itself", () => {
    const view = read()
    expect(view.nova).toBe(true)
    expect(view.me).toBe(true)
    expect(view.preset).toBe("everywhere")
    expect(view.id).toBe("pdf")
    expect(view.locked).toBeUndefined()
  })

  // All four corners, each reached by moving ONE half. A tri-state implementation passes the two
  // diagonal cases and fails these.
  const corners: { nova: boolean; me: boolean; preset: SkillInvocation.Preset }[] = [
    { nova: true, me: true, preset: "everywhere" },
    { nova: false, me: true, preset: "only-when-i-choose" },
    { nova: true, me: false, preset: "only-nova" },
    { nova: false, me: false, preset: "nowhere" },
  ]

  for (const corner of corners)
    test(`nova=${corner.nova} me=${corner.me} reads back as "${corner.preset}"`, () => {
      const view = read({
        rules: corner.nova ? [] : [{ action: "skill", resource: "pdf", effect: "deny" }],
        store: corner.me ? {} : { pdf: { show: false } },
      })
      expect({ nova: view.nova, me: view.me }).toEqual({ nova: corner.nova, me: corner.me })
      expect(view.preset).toBe(corner.preset)
      expect(view.isOnlyWhenIChoose).toBe(corner.preset === "only-when-i-choose")
    })

  test("the switch for one skill is not moved by a choice about another", () => {
    const view = read({
      rules: [{ action: "skill", resource: "other", effect: "deny" }],
      store: { other: { show: false } },
    })
    expect(view.nova).toBe(true)
    expect(view.me).toBe(true)
  })
})

describe("a switch may not read as a grant the engine will not honour", () => {
  test("a broader deny of the user's own is called out while the switch stays where it is", () => {
    // Our per-skill rule is absent, so "Nova may choose this" is ON — but every agent refuses the
    // skill because a wildcard rule matches it. Saying only "on" would be a lie by omission.
    const view = read({ rules: [{ action: "skill", resource: "*", effect: "deny" }], enablement: enablement("blocked") })
    expect(view.nova).toBe(true)
    expect(view.blockedElsewhere).toBe(true)
  })

  test("when WE wrote the deny the extra sentence is suppressed — the switch already says it", () => {
    const view = read({
      rules: [{ action: "skill", resource: "pdf", effect: "deny" }],
      enablement: enablement("blocked"),
    })
    expect(view.nova).toBe(false)
    expect(view.blockedElsewhere).toBe(false)
  })

  test("an ordinary blocked-free instance says nothing extra", () => {
    expect(read({ enablement: enablement("open") }).blockedElsewhere).toBe(false)
    expect(read({ enablement: enablement("unknown") }).blockedElsewhere).toBe(false)
  })
})

describe("a name that cannot be written down disables the controls and says why", () => {
  const locked: { name: string; reason: SkillInvocation.UnaddressableReason }[] = [
    { name: `spoof${RLO}gnp.exe`, reason: "invisible" },
    { name: `pd${ZWSP}f`, reason: "invisible" },
    { name: "pdf*", reason: "wildcard" },
    { name: "cafe\u0301", reason: "unnormalized" },
    { name: "a".repeat(SkillInvocation.MAX_ID_LENGTH + 1), reason: "too-long" },
    { name: "   ", reason: "empty" },
  ]

  for (const { name, reason } of locked)
    test(`"${reason}" is reported rather than guessed`, () => {
      const view = invocationOf({ name, rules: [], store: undefined, enablement: enablement() })
      expect(view.locked).toBe(reason)
      expect(view.id).toBeUndefined()
      // And no write is offered for it — a control that flips and does nothing is the defect.
      expect(invocationWrite({ name, rules: [], store: undefined, next: { nova: false, me: false } })).toBeUndefined()
    })

  test("markup in a name is NOT locked — it is a display problem, handled by the renderer", () => {
    const view = invocationOf({
      name: "</h1><script>alert(1)</script>",
      rules: [],
      store: undefined,
      enablement: enablement(),
    })
    expect(view.locked).toBeUndefined()
    expect(view.id).toBe("</h1><script>alert(1)</script>")
  })
})

describe("what a switch costs on the wire", () => {
  const plan = (next: { nova: boolean; me: boolean }, store?: SkillInvocation.Store, rules: PermissionRule[] = []) =>
    invocationWrite({ name: "pdf", rules, store, next })!

  test("hiding it: ONE patch carrying both halves", () => {
    const write = plan({ nova: true, me: false })
    expect(write.patch).toEqual({ permissions: [], skill_invocation: { pdf: { show: false } } })
    expect(write.remove).toEqual([])
  })

  test("turning Nova off while the menu keeps its default: ONE patch, nothing to clear", () => {
    const write = plan({ nova: false, me: true })
    expect(write.patch).toEqual({ permissions: [{ action: "skill", resource: "pdf", effect: "deny" }] })
    // No saved row exists, so the deletion verb is NOT called — it is all-or-nothing and answers
    // 400 for a path that names nothing, which would turn an ordinary click into an error.
    expect(write.remove).toEqual([])
  })

  test("clearing a SAVED row needs the deletion verb, because PATCH cannot delete", () => {
    // ⚠️ Measured: `{pdf: null}` in the patch is a live 400 (`Expected object, got null`).
    const write = plan({ nova: true, me: true }, { pdf: { show: false } })
    expect(write.patch).toEqual({ permissions: [] })
    expect(write.remove).toEqual([["skill_invocation", "pdf"]])
    expect(JSON.stringify(write.patch)).not.toContain("null")
  })

  test("the preset writes both halves, and clears only when there is a row to clear", () => {
    const fresh = plan(ONLY_WHEN_I_CHOOSE)
    expect(fresh.patch.permissions).toEqual([{ action: "skill", resource: "pdf", effect: "deny" }])
    expect(fresh.remove).toEqual([])

    const saved = plan(ONLY_WHEN_I_CHOOSE, { pdf: { show: false } })
    expect(saved.patch.permissions).toEqual([{ action: "skill", resource: "pdf", effect: "deny" }])
    expect(saved.remove).toEqual([["skill_invocation", "pdf"]])
  })

  test("the preset is exactly Nova-off / show-on, not a third state", () => {
    expect(ONLY_WHEN_I_CHOOSE).toEqual({ nova: false, me: true })
  })

  test("the whole ruleset is sent, with everything else preserved in order", () => {
    const rules: PermissionRule[] = [
      { action: "read", resource: "*", effect: "allow" },
      { action: "skill", resource: "other", effect: "deny" },
    ]
    expect(plan({ nova: false, me: true }, undefined, rules).patch.permissions).toEqual([
      ...rules,
      { action: "skill", resource: "pdf", effect: "deny" },
    ])
  })

  test("a round trip returns both switches to where they were", () => {
    const start: PermissionRule[] = [{ action: "read", resource: "*", effect: "allow" }]
    const off = invocationWrite({ name: "pdf", rules: start, store: {}, next: { nova: false, me: false } })!
    const store = off.patch.skill_invocation as SkillInvocation.Store
    const back = invocationWrite({ name: "pdf", rules: off.patch.permissions, store, next: { nova: true, me: true } })!
    expect(back.patch.permissions).toEqual(start)
    expect(back.remove).toEqual([["skill_invocation", "pdf"]])
    expect(invocationOf({ name: "pdf", rules: back.patch.permissions, store: {}, enablement: enablement() }).preset).toBe(
      "everywhere",
    )
  })
})

describe("a saved choice naming a skill that no longer resolves", () => {
  test("it is listed rather than swept, and it changes nothing about the skills that are here", () => {
    const store: SkillInvocation.Store = { pdf: { show: false }, "uninstalled-skill": { show: false } }
    expect(orphanedChoices(store, ["pdf", "writer"])).toEqual(["uninstalled-skill"])
    expect(invocationOf({ name: "pdf", rules: [], store, enablement: enablement() }).me).toBe(false)
    expect(invocationOf({ name: "writer", rules: [], store, enablement: enablement() }).me).toBe(true)
  })

  test("forgetting one addresses exactly that row, by path", () => {
    expect(forgetPath("uninstalled-skill")).toEqual(["skill_invocation", "uninstalled-skill"])
  })

  test("nothing saved means nothing orphaned", () => {
    expect(orphanedChoices(undefined, ["pdf"])).toEqual([])
    expect(orphanedChoices({}, ["pdf"])).toEqual([])
  })
})

/**
 * The THIRD layer, on the page: a `novaclaw.json` that hides a skill from the user's own slash menu.
 *
 * 🔴 **Principle 12(d) is the whole reason these fields are separate rather than folded.** A user
 * must be able to tell "this folder hides it" from "you hid it" from "your agents may not choose
 * it", because the three fixes are three different places: a file in the repository, the switch on
 * this page, and a permission rule. Folding the folder into `me` would make the switch read "off"
 * while the user's own answer is "on" — a control that appears to have been moved by a repository,
 * and one that appears not to work when moved back.
 *
 * ⚠️ **A/B, run by hand and reported:** make `invocationOf` set `me` from `seen.show` instead of
 * `seen.instance` — the "the switch stays where the USER left it" case goes red.
 */
describe("a folder's novaclaw.json is a third layer, and the page must not confuse it with the user's", () => {
  test("no project means the page says nothing extra", () => {
    const view = read()
    expect(view.hiddenByProject).toBe(false)
    expect(view.effectiveMe).toBe(true)
    expect(view.meBy).toBe("default")
  })

  test("🔴 the folder hides it while the user never spoke", () => {
    const view = read({ projectHidden: ["pdf"] })
    expect(view.hiddenByProject).toBe(true)
    expect(view.effectiveMe).toBe(false)
    expect(view.meBy).toBe("project")
    // The switch is still ON — nothing on this page decided this.
    expect(view.me).toBe(true)
  })

  test("🔴 the switch stays where the USER left it while the folder overrides it", () => {
    const view = read({ store: { pdf: { show: true } }, projectHidden: ["pdf"] })
    expect(view.me).toBe(true)
    expect(view.hiddenByProject).toBe(true)
    expect(view.effectiveMe).toBe(false)
  })

  test("the user's own hide is reported as the user's, not as the folder's", () => {
    const view = read({ store: { pdf: { show: false } } })
    expect(view.meBy).toBe("instance")
    expect(view.hiddenByProject).toBe(false)
    expect(view.effectiveMe).toBe(false)
  })

  test("both layers hiding names the FOLDER, because that is the one the switch cannot fix", () => {
    const view = read({ store: { pdf: { show: false } }, projectHidden: ["pdf"] })
    expect(view.meBy).toBe("project")
    expect(view.effectiveMe).toBe(false)
  })

  /**
   * 🔴 **The two labels, and why they are two — found by RUNNING it.**
   *
   * `preset` names the two switches (the "Only when I choose it" button compares against it);
   * `inForce` names what actually happens. With the folder hiding a skill the first cut printed
   * `preset` on the principle-12(d) "Right now" line, so the live page read *"it is in your slash
   * menu for you to run"* one line above *"this folder keeps this skill out of your slash menu"*.
   * Every unit test was green — they asserted the preset, which was right about the switches.
   */
  test("🔴 the in-force label describes the OUTCOME while the preset describes the switches", () => {
    const view = read({ projectHidden: ["pdf"] })
    expect(view.preset).toBe("everywhere")
    expect(view.inForce).toBe("only-nova")
    // …and the button that sets both switches still compares against the switches.
    expect(view.isOnlyWhenIChoose).toBe(false)
  })

  test("with no folder in play the two labels agree, in every corner", () => {
    for (const nova of [true, false])
      for (const me of [true, false]) {
        const view = read({
          rules: nova ? [] : [{ action: "skill", resource: "pdf", effect: "deny" }],
          store: me ? {} : { pdf: { show: false } },
        })
        expect(view.inForce).toBe(view.preset)
      }
  })

  test("a folder naming a DIFFERENT skill changes nothing here", () => {
    const view = read({ projectHidden: ["docx"] })
    expect(view.hiddenByProject).toBe(false)
    expect(view.effectiveMe).toBe(true)
  })

  test("the folder's list cannot reach a skill whose name has no stable id", () => {
    const name = `pd${ZWSP}f`
    const view = invocationOf({
      name,
      rules: [],
      store: undefined,
      projectHidden: [name],
      enablement: enablement(),
    })
    expect(view.locked).toBe("invisible")
    expect(view.hiddenByProject).toBe(false)
    expect(view.effectiveMe).toBe(true)
  })

  test("🔴 a folder can never UN-HIDE — there is no shape on this seam that could", () => {
    // `projectHidden` is the server's already-narrowed list. The only thing a project can put in it
    // is a HIDE; `ProjectFile.narrowSkills` drops every `show:true` before it reaches the wire.
    const view = read({ store: { pdf: { show: false } }, projectHidden: [] })
    expect(view.effectiveMe).toBe(false)
    expect(view.meBy).toBe("instance")
  })

  test("the folder does not touch the AGENT half — that is the permission rule's job", () => {
    const view = read({ projectHidden: ["pdf"] })
    expect(view.nova).toBe(true)
    // A project narrows the agent half through its own `permissions` section, which
    // `evaluateNarrowed` folds in; nothing about `skills` changes what an agent may do.
    expect(view.blockedElsewhere).toBe(false)
  })
})
