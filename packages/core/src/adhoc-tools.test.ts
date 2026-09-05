import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"
import {
  MAX_MANUAL_CHARS,
  copySessionRecipes,
  isValidName,
  listSessionRecipes,
  mergeRecipes,
  normalizeRecipe,
  removeSessionRecipe,
  saveSessionRecipe,
} from "./adhoc-tools"

let root: string
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "adhoc-tools-"))
})
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const recipe = (name: string, extra?: Partial<Parameters<typeof normalizeRecipe>[0]>) => ({
  name,
  description: `${name} does things`,
  manual: `curl http://example/${name}`,
  ...extra,
})

describe("isValidName / normalizeRecipe", () => {
  test("slug names pass, traversal and uppercase fail", () => {
    expect(isValidName("searxng")).toBe(true)
    expect(isValidName("stock-prices_v2")).toBe(true)
    expect(isValidName("../etc")).toBe(false)
    expect(isValidName("Nope")).toBe(false)
    expect(isValidName("")).toBe(false)
  })
  test("normalize trims and validates with model-legible errors", () => {
    expect(normalizeRecipe(recipe("ok", { description: "  padded  " })).description).toBe("padded")
    expect(() => normalizeRecipe(recipe("Bad Name"))).toThrow("lowercase slug")
    expect(() => normalizeRecipe(recipe("ok", { description: " " }))).toThrow("description")
    expect(() => normalizeRecipe(recipe("ok", { manual: "x".repeat(MAX_MANUAL_CHARS + 1) }))).toThrow("manual too long")
  })
})

describe("mergeRecipes (session ▷ project ▷ global)", () => {
  test("later layers override by name", () => {
    const merged = mergeRecipes(
      [recipe("a", { manual: "global-a" }), recipe("b")],
      [recipe("a", { manual: "project-a" })],
    )
    expect(merged.find((item) => item.name === "a")!.manual).toBe("project-a")
    expect(merged).toHaveLength(2)
  })
  test("a later scope can disable an earlier recipe", () => {
    const merged = mergeRecipes([recipe("a")], [{ ...recipe("a"), enabled: false }])
    expect(merged).toHaveLength(0)
  })
  test("undefined layers are fine; result is name-sorted", () => {
    const merged = mergeRecipes(undefined, [recipe("zeta"), recipe("alpha")], undefined)
    expect(merged.map((item) => item.name)).toEqual(["alpha", "zeta"])
  })
})

describe("session store", () => {
  test("save -> list round-trip, upsert by name", async () => {
    const saved = await saveSessionRecipe("ses_test1", recipe("weather"), { root })
    expect(saved.name).toBe("weather")
    await saveSessionRecipe("ses_test1", recipe("weather", { manual: "curl v2" }), { root })
    await saveSessionRecipe("ses_test1", recipe("stocks"), { root })
    const listed = await listSessionRecipes("ses_test1", { root })
    expect(listed).toHaveLength(2)
    expect(listed.find((item) => item.name === "weather")!.manual).toBe("curl v2")
  })
  test("sessions are isolated", async () => {
    await saveSessionRecipe("ses_other", recipe("solo"), { root })
    expect(await listSessionRecipes("ses_test1", { root })).not.toContainEqual(
      expect.objectContaining({ name: "solo" }),
    )
  })
  test("missing session lists empty; corrupt file lists empty", async () => {
    expect(await listSessionRecipes("ses_missing", { root })).toEqual([])
    await fs.writeFile(path.join(root, "ses_corrupt.json"), "{not json", "utf8")
    expect(await listSessionRecipes("ses_corrupt", { root })).toEqual([])
  })
  test("a corrupt catalogue is never replaced by a partial mutation", async () => {
    const file = path.join(root, "ses_corrupt-mutation.json")
    await fs.writeFile(file, "{not json", "utf8")
    await expect(saveSessionRecipe("ses_corrupt-mutation", recipe("new"), { root })).rejects.toThrow(
      "unreadable and was not overwritten",
    )
    expect(await fs.readFile(file, "utf8")).toBe("{not json")
  })
  test("concurrent session saves retain every distinct recipe", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        saveSessionRecipe("ses_concurrent", recipe(`tool-${index}`), { root }),
      ),
    )
    expect((await listSessionRecipes("ses_concurrent", { root })).map((item) => item.name)).toHaveLength(12)
  })
  test("a traversal session id throws", async () => {
    await expect(listSessionRecipes("../../evil", { root })).rejects.toThrow("Invalid session id")
  })
  test("copy-on-spawn: the child gets the parent's recipes, then diverges independently", async () => {
    await saveSessionRecipe("ses_parent", recipe("weather"), { root })
    const copied = await copySessionRecipes("ses_parent", "ses_child", { root })
    expect(copied).toBe(1)
    expect((await listSessionRecipes("ses_child", { root })).map((item) => item.name)).toEqual(["weather"])
    await saveSessionRecipe("ses_child", recipe("child-only"), { root })
    expect(await listSessionRecipes("ses_parent", { root })).toHaveLength(1)
    expect(await copySessionRecipes("ses_empty", "ses_child2", { root })).toBe(0)
    expect(await listSessionRecipes("ses_child2", { root })).toEqual([])
  })
})

describe("4E — discard + promote", () => {
  test("removeSessionRecipe drops one by name; deletes the file when empty", async () => {
    await saveSessionRecipe("ses_rm", recipe("keep"), { root })
    await saveSessionRecipe("ses_rm", recipe("drop"), { root })
    expect(await removeSessionRecipe("ses_rm", "drop", { root })).toBe(true)
    expect((await listSessionRecipes("ses_rm", { root })).map((r) => r.name)).toEqual(["keep"])
    expect(await removeSessionRecipe("ses_rm", "absent", { root })).toBe(false)
    expect(await removeSessionRecipe("ses_rm", "keep", { root })).toBe(true)
    expect(await listSessionRecipes("ses_rm", { root })).toEqual([])
  })

})
