import { describe, expect, test } from "bun:test"
import { planRecipeSave, type Recipe } from "./tools-draft"

/**
 * **A RENAME MAY NOT DELETE ANOTHER TOOL.**
 *
 * The defect this pins: the duplicate check was gated on `original === ""`, so it ran only while
 * ADDING. Renaming `deploy` onto the existing `backup` skipped it, and the array the editor wrote
 * had already filtered `backup` out — `adhoc_tools` is an array, and `updateConfig` replaces an
 * array wholesale, so the save WAS the deletion. No confirm, no warning, no undo, and up to 8 KB of
 * somebody's authored manual gone.
 *
 * ⚠️ The assertions read the survivor BACK out of the planned array rather than counting entries: a
 * plan of the right length carrying `deploy`'s manual under the name `backup` is the exact bug, and
 * a length check passes on it.
 */

const deploy: Recipe = { name: "deploy", description: "ship it", manual: "ssh prod && ./deploy.sh" }
const backup: Recipe = { name: "backup", description: "keep it", manual: "restic backup /srv" }

const plan = (over: Partial<Parameters<typeof planRecipeSave>[0]>) =>
  planRecipeSave({
    recipes: [deploy, backup],
    editing: "deploy",
    name: "deploy",
    description: "ship it",
    manual: "ssh prod && ./deploy.sh",
    ...over,
  })

describe("planRecipeSave refuses a collision whichever operation produced it", () => {
  test("🔴 renaming onto an existing tool is REFUSED, and that tool is untouched", () => {
    const result = plan({ name: "backup" })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe("duplicate")
  })

  test("…and the refusal is what keeps the other tool alive: a save that IS allowed keeps both", () => {
    // The A/B half. Same gesture, a free name — so the planned array must still carry `backup`
    // with `backup`'s own manual, which is precisely what the bug destroyed.
    const result = plan({ name: "deploy-v2" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.next.find((recipe) => recipe.name === "backup")).toEqual(backup)
    expect(result.next.find((recipe) => recipe.name === "deploy")).toBeUndefined()
    expect(result.next.find((recipe) => recipe.name === "deploy-v2")?.manual).toBe("ssh prod && ./deploy.sh")
  })

  test("adding under a taken name is refused too — the case that always worked stays working", () => {
    const result = plan({ editing: "", name: "backup", description: "other", manual: "other" })
    expect(result.ok === false && result.reason).toBe("duplicate")
  })

  test("NEGATIVE CONTROL — renaming a tool to the name it already has is not a collision", () => {
    // The failure mode of the fix: a check written as "this name exists" refuses every edit that
    // does not also rename, so nobody can ever change a description. The guard is `some OTHER
    // recipe`, and this is the test that tells the two apart.
    const result = plan({ description: "ship it faster" })
    expect(result.ok).toBe(true)
    expect(result.ok === true && result.next.find((recipe) => recipe.name === "deploy")?.description).toBe(
      "ship it faster",
    )
  })

  test("a disabled tool stays disabled across an edit, and an enabled one grows no key", () => {
    const off: Recipe = { ...deploy, enabled: false }
    const kept = planRecipeSave({
      recipes: [off, backup],
      editing: "deploy",
      name: "deploy",
      description: "ship it",
      manual: "ssh prod && ./deploy.sh",
    })
    expect(kept.ok === true && kept.next.find((recipe) => recipe.name === "deploy")).toEqual(off)
    const plain = plan({})
    expect(plain.ok === true && plain.next.find((recipe) => recipe.name === "deploy")).toEqual(deploy)
  })

  test("the field refusals still fire, and each names its own field", () => {
    const refusal = (over: Partial<Parameters<typeof planRecipeSave>[0]>) => {
      const result = plan(over)
      return result.ok ? undefined : result.reason
    }
    expect(refusal({ name: "Deploy" })).toBe("name")
    expect(refusal({ description: "" })).toBe("description")
    expect(refusal({ manual: "x".repeat(8_193) })).toBe("manual")
  })
})
