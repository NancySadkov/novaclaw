// Recipes: the pure recipe.md parsing plus the filesystem ops against a temp root. The slug becomes a
// FOLDER NAME and both users and models feed it, so the traversal cases are the ones that matter most.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Recipe } from "@novaclaw/core/recipe"
import { RecipeBuiltin } from "@novaclaw/core/recipe-builtin"

let root = ""
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "novaclaw-recipes-"))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
})
const opts = () => ({ root })

describe("parse", () => {
  test("reads name + description from frontmatter and keeps the body as the prompt", () => {
    const parsed = Recipe.parse(`---\nname: Hello C\ndescription: Compile and run a C program\n---\n\nWrite hello.c\n`)
    expect(parsed.name).toBe("Hello C")
    expect(parsed.description).toBe("Compile and run a C program")
    expect(parsed.prompt).toBe("Write hello.c")
  })

  test("a file with NO frontmatter is valid — the whole file is the prompt", () => {
    // This is the paste-a-prompt-into-a-file case; it must simply work.
    const parsed = Recipe.parse("Build a browser OS in one HTML file.\n\nAt least 5 apps.")
    expect(parsed.name).toBeUndefined()
    expect(parsed.prompt).toBe("Build a browser OS in one HTML file.\n\nAt least 5 apps.")
  })

  test("unknown frontmatter keys are ignored, not rejected", () => {
    const parsed = Recipe.parse(`---\nname: X\nauthor: someone\ntags: [a, b]\n---\nDo the thing`)
    expect(parsed.name).toBe("X")
    expect(parsed.prompt).toBe("Do the thing")
  })

  test("strips surrounding quotes and tolerates a BOM", () => {
    const parsed = Recipe.parse(`﻿---\nname: "Quoted Name"\n---\nbody`)
    expect(parsed.name).toBe("Quoted Name")
    expect(parsed.prompt).toBe("body")
  })

  test("a lone --- is not frontmatter (a markdown horizontal rule must survive)", () => {
    const parsed = Recipe.parse("Intro\n\n---\n\nMore prose")
    expect(parsed.prompt).toContain("Intro")
    expect(parsed.prompt).toContain("More prose")
  })

  test("render → parse round-trips", () => {
    const rendered = Recipe.render({ name: "Pi 100", description: "Machin formula", prompt: "Compute π" })
    const parsed = Recipe.parse(rendered)
    expect(parsed).toEqual({ name: "Pi 100", description: "Machin formula", prompt: "Compute π" })
  })
})

describe("slug safety — the slug is a folder name", () => {
  test("rejects traversal and absolute paths", () => {
    for (const bad of ["../escape", "..", "a/b", "a\\b", "/abs", "C:\\win", ".hidden", "", "-lead", "A-Upper"])
      expect(Recipe.isValidSlug(bad)).toBe(false)
  })

  test("accepts plain lowercase slugs", () => {
    for (const good of ["hello-c", "pi_100", "osint", "a"]) expect(Recipe.isValidSlug(good)).toBe(true)
  })

  test("slugify produces something valid from human titles", () => {
    expect(Recipe.slugify("Hello, C!")).toBe("hello-c")
    expect(Recipe.slugify("100 digits of π — Machin")).toBe("100-digits-of-machin")
    expect(Recipe.isValidSlug(Recipe.slugify("Browser OS"))).toBe(true)
  })

  test("remove refuses a traversal slug instead of deleting outside the root", async () => {
    await expect(Recipe.remove("../../etc", opts())).rejects.toThrow(/Invalid recipe id/)
  })
})

describe("save / list / read", () => {
  test("saves and reads back, deriving the slug from the name", async () => {
    const saved = await Recipe.save({ name: "Hello C", description: "toolchain check", prompt: "Write hello.c" }, opts())
    expect(saved.slug).toBe("hello-c")
    expect(saved.assets).toEqual([])
    const read = await Recipe.read("hello-c", opts())
    expect(read?.name).toBe("Hello C")
    expect(read?.prompt).toBe("Write hello.c")
  })

  test("rejects an empty prompt — a recipe with no prompt cannot be cooked", async () => {
    await expect(Recipe.save({ name: "Empty", prompt: "   " }, opts())).rejects.toThrow(/needs a prompt/)
  })

  test("lists name-sorted and reports assets alongside recipe.md", async () => {
    await Recipe.save({ name: "Zebra", prompt: "z" }, opts())
    await Recipe.save({ name: "Alpha", prompt: "a" }, opts())
    await fs.writeFile(path.join(root, "alpha", "data.csv"), "x,y\n", "utf8")
    const all = await Recipe.list(opts())
    expect(all.map((r) => r.name)).toEqual(["Alpha", "Zebra"])
    expect(all[0]!.assets).toEqual(["data.csv"])
  })

  test("a folder with no recipe.md, or an empty one, is skipped rather than listed dead", async () => {
    await fs.mkdir(path.join(root, "notarecipe"), { recursive: true })
    await fs.mkdir(path.join(root, "hollow"), { recursive: true })
    await fs.writeFile(path.join(root, "hollow", "recipe.md"), "---\nname: Hollow\n---\n\n", "utf8")
    await Recipe.save({ name: "Real", prompt: "do it" }, opts())
    expect((await Recipe.list(opts())).map((r) => r.slug)).toEqual(["real"])
  })

  test("a missing root lists empty instead of throwing", async () => {
    expect(await Recipe.list({ root: path.join(root, "nope") })).toEqual([])
  })

  test("builtinSlugs marks the shipped ones without changing storage", async () => {
    await Recipe.save({ name: "Pi 100", prompt: "π" }, opts())
    const [recipe] = await Recipe.list({ ...opts(), builtinSlugs: new Set(["pi-100"]) })
    expect(recipe!.builtin).toBe(true)
    const plain = await Recipe.read("pi-100", opts())
    expect(plain!.builtin).toBe(false)
  })
})

describe("duplicate / remove / materialize", () => {
  test("duplicate copies assets, retitles, and never overwrites an existing copy", async () => {
    await Recipe.save({ name: "Browser OS", prompt: "build it" }, opts())
    await fs.writeFile(path.join(root, "browser-os", "logo.svg"), "<svg/>", "utf8")
    const first = await Recipe.duplicate("browser-os", opts())
    expect(first.slug).toBe("browser-os-2")
    expect(first.name).toBe("Browser OS (copy)")
    expect(first.assets).toEqual(["logo.svg"])
    const second = await Recipe.duplicate("browser-os", opts())
    expect(second.slug).toBe("browser-os-3") // the first copy survives
  })

  test("remove deletes the folder and its assets; a second remove reports false", async () => {
    await Recipe.save({ name: "Temp", prompt: "x" }, opts())
    await fs.writeFile(path.join(root, "temp", "asset.txt"), "a", "utf8")
    expect(await Recipe.remove("temp", opts())).toBe(true)
    expect(await Recipe.remove("temp", opts())).toBe(false)
    expect(await Recipe.list(opts())).toEqual([])
  })

  test("materialize copies assets into the work dir and leaves the original untouched", async () => {
    await Recipe.save({ name: "With Assets", prompt: "use data.csv" }, opts())
    await fs.writeFile(path.join(root, "with-assets", "data.csv"), "a,b\n", "utf8")
    const into = path.join(root, "..", path.basename(root) + "-work")
    const copied = await Recipe.materialize("with-assets", into, opts())
    expect(copied).toEqual(["data.csv", "recipe.md"])
    expect(await fs.readFile(path.join(into, "data.csv"), "utf8")).toBe("a,b\n")
    // original still there
    expect((await Recipe.read("with-assets", opts()))!.assets).toEqual(["data.csv"])
    await fs.rm(into, { recursive: true, force: true })
  })

  test("the work dir is self-describing — the recipe travels with the work it produced", async () => {
    await Recipe.save({ name: "Portable", description: "goes anywhere", prompt: "do the thing" }, opts())
    const into = path.join(root, "..", path.basename(root) + "-portable")
    await Recipe.materialize("portable", into, opts())
    const manifest = await fs.readFile(path.join(into, "recipe.md"), "utf8")
    expect(manifest).toContain("Portable")
    expect(manifest).toContain("do the thing")
    // The copy is a real recipe: pointing the store at the work dir's parent reads it back.
    expect(Recipe.parse(manifest).prompt.trim()).toBe("do the thing")
    await fs.rm(into, { recursive: true, force: true })
  })

  test("materialize never clobbers a recipe.md already in the work dir", async () => {
    await Recipe.save({ name: "Cook", prompt: "fresh" }, opts())
    const into = path.join(root, "..", path.basename(root) + "-occupied")
    await fs.mkdir(into, { recursive: true })
    await fs.writeFile(path.join(into, "recipe.md"), "the user's own file", "utf8")
    const copied = await Recipe.materialize("cook", into, opts())
    expect(copied).not.toContain("recipe.md")
    expect(await fs.readFile(path.join(into, "recipe.md"), "utf8")).toBe("the user's own file")
    await fs.rm(into, { recursive: true, force: true })
  })

  test("materialize of an unknown recipe fails loudly", async () => {
    await expect(Recipe.materialize("ghost", path.join(root, "w"), opts())).rejects.toThrow(/No recipe named/)
  })
})

describe("builtins — the shipped set and its seeding", () => {
  test("every builtin is well-formed and toolchain-agnostic", () => {
    expect(RecipeBuiltin.BUILTINS.length).toBeGreaterThanOrEqual(5)
    for (const builtin of RecipeBuiltin.BUILTINS) {
      expect(Recipe.isValidSlug(builtin.slug)).toBe(true)
      expect(builtin.name.trim().length).toBeGreaterThan(0)
      expect(builtin.description?.trim().length ?? 0).toBeGreaterThan(0)
      expect(builtin.prompt.trim().length).toBeGreaterThan(80)
      // These run on strangers' machines: no one's personal install path may be REQUIRED.
      expect(builtin.prompt).not.toMatch(/^\s*Use C:\\soft/m)
    }
    // The release set the owner asked for.
    const slugs = RecipeBuiltin.BUILTINS.map((b) => b.slug)
    for (const required of ["hello-c", "pi-100-machin", "browser-os", "osint-brief"])
      expect(slugs).toContain(required)
    expect(new Set(slugs).size).toBe(slugs.length) // no duplicate slugs
  })

  test("seed writes them all, then is idempotent", async () => {
    const first = await RecipeBuiltin.seed(opts())
    expect(first.created.length).toBe(RecipeBuiltin.BUILTINS.length)
    expect(first.skipped).toEqual([])
    const second = await RecipeBuiltin.seed(opts())
    expect(second.created).toEqual([])
    expect(second.skipped.length).toBe(RecipeBuiltin.BUILTINS.length)
    const listed = await Recipe.list({ ...opts(), builtinSlugs: RecipeBuiltin.BUILTIN_SLUGS })
    expect(listed.length).toBe(RecipeBuiltin.BUILTINS.length)
    expect(listed.every((r) => r.builtin)).toBe(true)
  })

  test("seeding NEVER clobbers a user's edit to a shipped recipe", async () => {
    // The upgrade case: they own it once it is on their disk.
    await Recipe.save({ name: "Hello, C", prompt: "MY OWN EDITED VERSION" }, opts())
    await RecipeBuiltin.seed(opts())
    expect((await Recipe.read("hello-c", opts()))!.prompt).toBe("MY OWN EDITED VERSION")
  })

  test("a deleted builtin comes back on the next seed (a safety net, not a cage)", async () => {
    await RecipeBuiltin.seed(opts())
    expect(await Recipe.remove("hello-c", opts())).toBe(true)
    const again = await RecipeBuiltin.seed(opts())
    expect(again.created).toEqual(["hello-c"])
  })
})
