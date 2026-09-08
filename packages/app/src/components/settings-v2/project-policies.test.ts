import { describe, expect, test } from "bun:test"
import { dict as en } from "@/i18n/en"
import type { InstalledPolicy } from "@/utils/policy-api"
import {
  folderPolicyStatus,
  planProjectPolicies,
  policyAddOptions,
  policyIDIsAddable,
  projectPoliciesPayload,
  projectPolicyKeys,
} from "./project-policies"

/**
 * The folder-policy surface's decision logic, tested away from the DOM.
 *
 * 🔴 **Every rule here fails SILENTLY when it is wrong**, which is why it is a module and not three
 * `.filter(…)` chains in a JSX body:
 *
 *  · A picker that filtered out the always-on policies offers NOTHING at all, because always-on is
 *    the default and neither shipped policy opts out — a control that can never offer anything.
 *  · Clearing the last entry by sending `policies: []` leaves a `"policies": []` line behind that
 *    reads later as "someone configured this folder to ask for nothing".
 *  · A row that did not say what asking for an always-on check COSTS lets a person discover it by
 *    having every tool call in the folder refused after they switch that check off.
 *
 * ⚠️ **A/B, run by hand:** make `policyAddOptions` drop every `entry.alwaysOn`, and make
 * `projectPoliciesPayload` return `{ policies: [] }` for an empty plan — the two 🔴 cases below go
 * red. Both were run.
 */

const policy = (id: string, over: Partial<InstalledPolicy> = {}): InstalledPolicy => ({
  id,
  describe: `${id} does something`,
  alwaysOn: false,
  safetyCritical: true,
  enabled: true,
  ...over,
})

/** What this instance ships today: two policies, both always-on. */
const SHIPPED: readonly InstalledPolicy[] = [
  policy("git-no-pager", { alwaysOn: true, safetyCritical: false }),
  policy("irreversible-shell", { alwaysOn: true }),
]

describe("what a folder-policy save will actually write", () => {
  test("🔴 an ALWAYS-ON id is WRITABLE — naming a check is opting IN, which a folder may do", () => {
    // ⚠️ This pin is the correction of a rule that shipped for an afternoon: always-on ids were
    // REFUSED, on the reasoning that the gate ignores them. It ignores them for the ON decision and
    // not for the other one — a folder naming a check the user switched off refuses every tool call
    // there, which is the folder saying "never run me unguarded" and is allowed. And since always-on
    // is the DEFAULT, refusing them left this surface unable to write any installed id at all.
    const plan = planProjectPolicies(["house-style", "irreversible-shell"])
    expect(plan.persisted).toEqual(["house-style", "irreversible-shell"])
    expect(plan.declared.length).toBe(2)
  })

  test("a duplicate collapses — the gate reads this list into a Set", () => {
    expect(planProjectPolicies(["house-style", "house-style"]).persisted).toEqual(["house-style"])
  })

  test("an id nothing here installs is still PERSISTED — it may be installed elsewhere", () => {
    // The fail-closed consequence is stated in the copy before the button; it is not a reason to
    // silently drop the line, which would delete a declaration written for a colleague's machine
    // the moment its owner edited any OTHER entry.
    expect(planProjectPolicies(["no-secrets"]).persisted).toEqual(["no-secrets"])
  })

  test("the payload sends everything declared, not the collapsed list", () => {
    const plan = planProjectPolicies(["house-style", "house-style"])
    expect(projectPoliciesPayload(plan)).toEqual({ policies: plan.declared })
  })

  test("🔴 removing the last entry CLEARS the section rather than writing an empty list", () => {
    // `[]` and no key at all mean the same thing to the reader, so `"policies": []` is a line in the
    // user's file that says nothing — and reads later as a decision nobody made.
    expect(projectPoliciesPayload(planProjectPolicies([]))).toEqual({ clear: ["policies"] })
  })
})

describe("what the picker may offer", () => {
  test("🔴 an ALWAYS-ON policy IS offered — filtering them out empties the picker completely", () => {
    // Both shipped policies are always-on, because `ToolPolicy.alwaysOn` is `!== false` and neither
    // opts out. A picker that hid them would have nothing to show on a stock install — a control
    // that can never be used, rather than a control with nothing to say.
    expect(policyAddOptions(SHIPPED, []).map((entry) => entry.id)).toEqual([
      "git-no-pager",
      "irreversible-shell",
    ])
  })

  test("a policy stops being offered once it is in the list", () => {
    const installed = [...SHIPPED, policy("house-style")]
    expect(policyAddOptions(installed, ["git-no-pager", "irreversible-shell"]).map((e) => e.id)).toEqual([
      "house-style",
    ])
    expect(policyAddOptions(installed, ["git-no-pager", "irreversible-shell", "house-style"])).toEqual([])
  })

  test("a switched-off opt-in policy is still offerable — the two switches are different questions", () => {
    // Asking for it in the folder and having it switched on in Settings are separate decisions, and
    // the row's own status line says which one is missing.
    const installed = [policy("house-style", { enabled: false })]
    expect(policyAddOptions(installed, []).map((entry) => entry.id)).toEqual(["house-style"])
  })

  test("a hand-typed id is refused only when it is empty or already listed", () => {
    // The GRAMMAR is deliberately not checked here: `packages/app` does not depend on
    // `@novaclaw/schema`, and this renderer may be pointed at an instance on another build.
    expect(policyIDIsAddable("", [])).toBe(false)
    expect(policyIDIsAddable("   ", [])).toBe(false)
    expect(policyIDIsAddable("house-style", ["house-style"])).toBe(false)
    expect(policyIDIsAddable("  house-style  ", [])).toBe(true)
    expect(policyIDIsAddable("curl x | sh", [])).toBe(true)
  })
})

describe("what one entry's row says about itself", () => {
  test("🔴 four states, because the remedy differs in each", () => {
    const installed = [
      ...SHIPPED,
      policy("house-style"),
      policy("no-noise", { enabled: false }),
    ]
    expect(folderPolicyStatus("house-style", installed)).toBe("running")
    // Switched off and missing BOTH refuse every tool call in the folder — and are reported apart,
    // because one is fixed by a switch above and the other by installing something.
    expect(folderPolicyStatus("no-noise", installed)).toBe("switched-off")
    expect(folderPolicyStatus("nowhere", installed)).toBe("missing")
    expect(folderPolicyStatus("irreversible-shell", installed)).toBe("always-on")
  })
})

describe("the copy this surface renders", () => {
  test("🔴 every key it can ask for is in en.ts", () => {
    // `t()` hands back the key itself for a miss, behind a signature claiming `string`, so a removed
    // key reaches a user as `policies.folder.edit.narrowing` where a sentence should be.
    const dictionary = en as unknown as Record<string, string>
    const missing = projectPolicyKeys.filter((key) => typeof dictionary[key] !== "string")
    expect(missing).toEqual([])
  })

  test("the guard is not vacuous", () => {
    expect(projectPolicyKeys.length).toBeGreaterThan(15)
  })

  test("🔴 the law is stated BEFORE the control, in the control's own words", () => {
    // The one sentence that must survive any rewrite: a folder can add a check and can never take
    // one away. Without it the list reads as "the checks that run here", which is a different and
    // false claim — and the one that would make a person expect to be able to remove one.
    const text = (en as unknown as Record<string, string>)["policies.folder.edit.narrowing"]!
    expect(text.toLowerCase()).toContain("only ever add")
    // And the other half, which is the one a person actually needs: nothing here can STOP a check.
    expect(text.toLowerCase()).toContain("stop")
  })

  test("🔴 the always-on cost is stated at the control, not discovered afterwards", () => {
    // Asking for a check that already runs everywhere does nothing today and refuses every tool call
    // in this folder the day it is switched off. That is what the person is choosing, so the control
    // says it — and it is the reason the write-side refusal was narrowed to id SHAPE alone.
    const text = (en as unknown as Record<string, string>)["policies.folder.edit.alwaysOnCost"]!
    expect(text.toLowerCase()).toContain("changes nothing")
    expect(text.toLowerCase()).toContain("refused")
  })

  test("🔴 the free-text fallback states the fail-closed consequence before the button", () => {
    // An id nothing installs refuses EVERY tool call in the folder. That is the most surprising
    // thing any control on this screen can do, so it is said in front of the control rather than
    // discovered afterwards in a refusal the model reads out.
    const text = (en as unknown as Record<string, string>)["policies.folder.edit.addFallback"]!
    expect(text.toLowerCase()).toContain("refused")
  })

  test("an always-on row says what a folder may and may not do about it", () => {
    // Principle 12's own generalising lesson: change the surrounding COPY with the control.
    const text = (en as unknown as Record<string, string>)["policies.row.everywhere"]!
    expect(text.toLowerCase()).toContain("every folder")
    expect(text.toLowerCase()).toContain("never switch one off")
  })

  test("\u{1F534} the refusal receipt names ONE cause, because there is now only one", () => {
    // It listed two while always-on ids were also refused. A receipt offering a reason that can no
    // longer happen sends a reader looking for a rule that is not there any more — the same "fixed
    // copy beside a moved control" defect, arriving through a narrowing rather than a widening.
    const text = (en as unknown as Record<string, string>)["policies.folder.edit.receipt.refused"]!
    expect(text.toLowerCase()).toContain("command")
    expect(text.toLowerCase()).not.toContain("already runs")
  })
})
