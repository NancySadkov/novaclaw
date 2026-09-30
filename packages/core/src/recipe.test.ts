// Recipes: the pure recipe.json parsing plus the filesystem ops against a temp root. The slug becomes a
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
  test("reads a versioned JSON document", () => {
    expect(Recipe.parse('{"version":1,"name":"Hello C","description":"Compile C","prompt":"Write hello.c"}')).toEqual({
      version: 1 as const,
      name: "Hello C",
      description: "Compile C",
      prompt: "Write hello.c",
    })
  })

  test("requires a supported version, name and prompt", () => {
    for (const input of [
      null,
      [],
      {},
      { version: 2 },
      { version: "1" },
      { version: 1 as const, name: "X" },
      { version: 1 as const, name: " ", prompt: "Build" },
      { version: 1 as const, name: "X", prompt: " " },
    ])
      expect(() => Recipe.parse(JSON.stringify(input))).toThrow(Recipe.RecipeFormatError)
  })

  test("preserves structured extensions", () => {
    const extensions = { authors: ["Nancy"], options: { theme: "gold", enabled: true }, count: 3, nullable: null }
    const document = { version: 1 as const, name: "X", prompt: "Build", ...extensions }
    expect(Recipe.parse(JSON.stringify(document))).toEqual(document)
  })

  test("checks known field types", () => {
    for (const fields of [{ description: [] }, { needs: "gcc" }, { produces: [3] }, { needs: [""] }, { officers: {} }])
      expect(() =>
        Recipe.parse(JSON.stringify({ version: 1 as const, name: "X", prompt: "Build", ...fields })),
      ).toThrow()
  })

  test("rejects Markdown and malformed JSON", () => {
    for (const source of ["Build this", "---\nname: X\n---\nBuild", '{"version":1,}', "\uFEFF{}"])
      expect(() => Recipe.parse(source)).toThrow(/Invalid recipe.json/)
  })

  test("render and parse preserve Unicode, multiline instructions and nested extensions", () => {
    const input = {
      name: "Pi π",
      prompt: 'Compute π.\nUse "quotes" and C:\\tools.\n',
      settings: { values: [1, null, "x"] },
    }
    const source = Recipe.render(input)
    expect(Recipe.parse(source)).toEqual({ version: 1, ...input })
    expect(Recipe.render(Recipe.parse(source))).toBe(source)
    expect(Recipe.render({ ...input, version: undefined })).toBe(source)
  })

  test("bounds all document entry points by UTF-8 bytes", () => {
    expect(() => Recipe.render({ name: "Large", prompt: "π".repeat(Recipe.IMPORT_CAP / 2) })).toThrow(/too big/)
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
    const saved = await Recipe.save(
      { name: "Hello C", description: "toolchain check", prompt: "Write hello.c" },
      opts(),
    )
    expect(saved.slug).toBe("hello-c")
    expect(saved.assets).toEqual([])
    const read = await Recipe.read("hello-c", opts())
    expect(read?.name).toBe("Hello C")
    expect(read?.prompt).toBe("Write hello.c")
  })

  test("rejects an empty prompt — a recipe with no prompt cannot be cooked", async () => {
    await expect(Recipe.save({ name: "Empty", prompt: "   " }, opts())).rejects.toThrow(/needs a prompt/)
  })

  test("lists name-sorted and reports assets alongside recipe.json", async () => {
    await Recipe.save({ name: "Zebra", prompt: "z" }, opts())
    await Recipe.save({ name: "Alpha", prompt: "a" }, opts())
    await fs.writeFile(path.join(root, "alpha", "data.csv"), "x,y\n", "utf8")
    const all = await Recipe.list(opts())
    expect(all.map((r) => r.name)).toEqual(["Alpha", "Zebra"])
    expect(all[0]!.assets).toEqual(["data.csv"])
  })

  test("a folder with no recipe.json, or an empty one, is skipped rather than listed dead", async () => {
    await fs.mkdir(path.join(root, "notarecipe"), { recursive: true })
    await fs.mkdir(path.join(root, "hollow"), { recursive: true })
    await fs.writeFile(
      path.join(root, "hollow", "recipe.json"),
      JSON.stringify({ version: 1, name: "Hollow", prompt: "" }),
      "utf8",
    )
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
    const result = await Recipe.materialize("with-assets", into, opts())
    expect(result).toEqual({ copied: ["data.csv", "recipe.json"], skipped: [], failed: [] })
    expect(await fs.readFile(path.join(into, "data.csv"), "utf8")).toBe("a,b\n")
    // original still there
    expect((await Recipe.read("with-assets", opts()))!.assets).toEqual(["data.csv"])
    await fs.rm(into, { recursive: true, force: true })
  })

  test("the work dir is self-describing — the recipe travels with the work it produced", async () => {
    await Recipe.save({ name: "Portable", description: "goes anywhere", prompt: "do the thing" }, opts())
    const into = path.join(root, "..", path.basename(root) + "-portable")
    await Recipe.materialize("portable", into, opts())
    const manifest = await fs.readFile(path.join(into, "recipe.json"), "utf8")
    expect(manifest).toContain("Portable")
    expect(manifest).toContain("do the thing")
    // The copy is a real recipe: pointing the store at the work dir's parent reads it back.
    expect(Recipe.parse(manifest).prompt.trim()).toBe("do the thing")
    await fs.rm(into, { recursive: true, force: true })
  })

  /**
   * 🔴 NC-REL-031 — the no-clobber rule below covered exactly ONE file. The Recipes UI offers
   * "Run in…" against an existing directory on purpose (its own note calls it cooking "straight into
   * a permanent folder"), so a recipe carrying `README.md`, `main.py` or `src/` silently replaced the
   * user's file of that name, with no prompt and no record. Their `recipe.json` was safe; their work
   * was not.
   *
   * A/B: drop the `clash` check and the user's data.csv becomes the recipe's.
   */
  test("🔴 materialize never clobbers an ASSET already in the work dir either", async () => {
    await Recipe.save({ name: "Clobber", prompt: "use data.csv" }, opts())
    await fs.writeFile(path.join(root, "clobber", "data.csv"), "recipe,version\n", "utf8")
    const into = path.join(root, "..", path.basename(root) + "-mine")
    await fs.mkdir(into, { recursive: true })
    await fs.writeFile(path.join(into, "data.csv"), "the user's own numbers\n", "utf8")

    const result = await Recipe.materialize("clobber", into, opts())

    expect(await fs.readFile(path.join(into, "data.csv"), "utf8")).toBe("the user's own numbers\n")
    expect(result).toEqual({ copied: ["recipe.json"], skipped: ["data.csv"], failed: [] })
    await fs.rm(into, { recursive: true, force: true })
  })

  test("materialize never clobbers a recipe.json already in the work dir", async () => {
    await Recipe.save({ name: "Cook", prompt: "fresh" }, opts())
    const into = path.join(root, "..", path.basename(root) + "-occupied")
    await fs.mkdir(into, { recursive: true })
    await fs.writeFile(path.join(into, "recipe.json"), "the user's own file", "utf8")
    const result = await Recipe.materialize("cook", into, opts())
    expect(result).toEqual({ copied: [], skipped: ["recipe.json"], failed: [] })
    expect(await fs.readFile(path.join(into, "recipe.json"), "utf8")).toBe("the user's own file")
    await fs.rm(into, { recursive: true, force: true })
  })

  test("a nested directory tree and an empty directory land byte-for-byte as one asset", async () => {
    await Recipe.save({ name: "Tree", prompt: "use src" }, opts())
    const source = path.join(root, "tree", "src")
    await fs.mkdir(path.join(source, "nested", "empty"), { recursive: true })
    const bytes = Buffer.from([0, 1, 2, 13, 10, 255])
    await fs.writeFile(path.join(source, "nested", "data.bin"), bytes)
    const into = path.join(root, "..", path.basename(root) + "-tree")

    expect((await Recipe.read("tree", opts()))!.assets).toEqual(["src"])
    expect(await Recipe.materialize("tree", into, opts())).toEqual({
      copied: ["src", "recipe.json"],
      skipped: [],
      failed: [],
    })
    expect(await fs.readFile(path.join(into, "src", "nested", "data.bin"))).toEqual(bytes)
    expect((await fs.lstat(path.join(into, "src", "nested", "empty"))).isDirectory()).toBe(true)
    await fs.rm(into, { recursive: true, force: true })
  })

  test("a destination directory collision skips the whole tree and preserves the user's subtree", async () => {
    await Recipe.save({ name: "Tree Clash", prompt: "use src" }, opts())
    await fs.mkdir(path.join(root, "tree-clash", "src", "nested"), { recursive: true })
    await fs.writeFile(path.join(root, "tree-clash", "src", "nested", "recipe.txt"), "recipe", "utf8")
    const into = path.join(root, "..", path.basename(root) + "-tree-clash")
    await fs.mkdir(path.join(into, "src", "mine"), { recursive: true })
    await fs.writeFile(path.join(into, "src", "mine", "user.txt"), "keep every byte", "utf8")

    const result = await Recipe.materialize("tree-clash", into, opts())

    expect(result).toEqual({ copied: ["recipe.json"], skipped: ["src"], failed: [] })
    expect(await fs.readFile(path.join(into, "src", "mine", "user.txt"), "utf8")).toBe("keep every byte")
    expect(
      await fs.stat(path.join(into, "src", "nested", "recipe.txt")).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    await fs.rm(into, { recursive: true, force: true })
  })

  test("file-versus-directory collisions skip in both directions without changing the destination", async () => {
    await Recipe.save({ name: "File Source", prompt: "use payload" }, opts())
    await fs.writeFile(path.join(root, "file-source", "payload"), "recipe file", "utf8")
    const fileInto = path.join(root, "..", path.basename(root) + "-file-to-dir")
    await fs.mkdir(path.join(fileInto, "payload"), { recursive: true })
    await fs.writeFile(path.join(fileInto, "payload", "user.txt"), "user directory", "utf8")
    expect(await Recipe.materialize("file-source", fileInto, opts())).toEqual({
      copied: ["recipe.json"],
      skipped: ["payload"],
      failed: [],
    })
    expect(await fs.readFile(path.join(fileInto, "payload", "user.txt"), "utf8")).toBe("user directory")

    await Recipe.save({ name: "Directory Source", prompt: "use payload" }, opts())
    await fs.mkdir(path.join(root, "directory-source", "payload"), { recursive: true })
    await fs.writeFile(path.join(root, "directory-source", "payload", "recipe.txt"), "recipe directory", "utf8")
    const directoryInto = path.join(root, "..", path.basename(root) + "-dir-to-file")
    await fs.mkdir(directoryInto, { recursive: true })
    await fs.writeFile(path.join(directoryInto, "payload"), "user file", "utf8")
    expect(await Recipe.materialize("directory-source", directoryInto, opts())).toEqual({
      copied: ["recipe.json"],
      skipped: ["payload"],
      failed: [],
    })
    expect(await fs.readFile(path.join(directoryInto, "payload"), "utf8")).toBe("user file")

    await fs.rm(fileInto, { recursive: true, force: true })
    await fs.rm(directoryInto, { recursive: true, force: true })
  })

  test("a directory asset containing a symlink escape fails as a unit and copies no outside bytes", async () => {
    await Recipe.save({ name: "Linked Tree", prompt: "use assets" }, opts())
    const outside = path.join(root, "..", path.basename(root) + "-outside")
    await fs.mkdir(outside, { recursive: true })
    await fs.writeFile(path.join(outside, "secret.txt"), "outside", "utf8")
    await fs.mkdir(path.join(root, "linked-tree", "assets"), { recursive: true })
    await fs.symlink(
      outside,
      path.join(root, "linked-tree", "assets", "escape"),
      process.platform === "win32" ? "junction" : "dir",
    )
    const into = path.join(root, "..", path.basename(root) + "-linked")

    expect(await Recipe.materialize("linked-tree", into, opts())).toEqual({
      copied: ["recipe.json"],
      skipped: [],
      failed: ["assets"],
    })
    expect(
      await fs.stat(path.join(into, "assets")).then(
        () => true,
        () => false,
      ),
    ).toBe(false)

    await fs.rm(into, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })

  test("materialize refuses a destination inside the recipe tree before it can recurse into itself", async () => {
    await Recipe.save({ name: "Recursive", prompt: "use assets" }, opts())
    await fs.mkdir(path.join(root, "recursive", "assets"), { recursive: true })
    await fs.writeFile(path.join(root, "recursive", "assets", "seed.txt"), "seed", "utf8")
    const into = path.join(root, "recursive", "assets", "work")

    await expect(Recipe.materialize("recursive", into, opts())).rejects.toThrow(/inside its own source folder/)
    expect(
      await fs.stat(into).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  })

  test("materialize of an unknown recipe fails loudly", async () => {
    await expect(Recipe.materialize("ghost", path.join(root, "w"), opts())).rejects.toThrow(/No recipe named/)
  })
})

describe("extension-preserving writes", () => {
  const document = {
    version: 1 as const,
    name: "Hand Written",
    description: "by a person",
    prompt: "Do the thing\n",
    needs: ["gcc"],
    author: { name: "Nancy", links: ["local"] },
    optional: null,
  }
  const source = JSON.stringify(document, null, 2) + "\n"
  const write = async (slug: string, content = source) => {
    await fs.mkdir(path.join(root, slug), { recursive: true })
    await fs.writeFile(path.join(root, slug, "recipe.json"), content, "utf8")
  }

  test("save changes only the requested fields", async () => {
    await write("hand")
    await Recipe.save(
      { slug: "hand", name: "Renamed", description: document.description, prompt: document.prompt },
      opts(),
    )
    expect(Recipe.parse((await Recipe.sourceOf("hand", opts()))!)).toEqual({ ...document, name: "Renamed" })
  })

  test("duplicate retains every extension", async () => {
    await write("hand")
    const copy = await Recipe.duplicate("hand", opts())
    expect(Recipe.parse((await Recipe.sourceOf(copy.slug, opts()))!)).toEqual({
      ...document,
      name: "Hand Written (copy)",
    })
  })

  test("materialize preserves source bytes", async () => {
    await write("cook")
    const into = path.join(root, "cooked")
    const result = await Recipe.materialize("cook", into, opts())
    expect(result.copied).toContain("recipe.json")
    expect(await fs.readFile(path.join(into, "recipe.json"), "utf8")).toBe(source)
  })

  test("materialize does not invent optional fields", async () => {
    const minimal = '{"version":1,"name":"Minimal","prompt":"Build"}'
    await write("minimal", minimal)
    const into = path.join(root, "cooked")
    await Recipe.materialize("minimal", into, opts())
    expect(await fs.readFile(path.join(into, "recipe.json"), "utf8")).toBe(minimal)
  })

  test("materialize preserves CRLF JSON whitespace", async () => {
    const crlf = source.replaceAll("\n", "\r\n")
    await write("crlf", crlf)
    const into = path.join(root, "cooked")
    await Recipe.materialize("crlf", into, opts())
    expect(await fs.readFile(path.join(into, "recipe.json"), "utf8")).toBe(crlf)
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
    for (const required of ["hello-c", "pi-100-machin", "browser-os", "osint-brief"]) expect(slugs).toContain(required)
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
    await fs.writeFile(path.join(root, "hello-c", "recipe.json"), "{broken")
    const occupied = await RecipeBuiltin.seed(opts())
    expect(occupied.created).toEqual([])
    expect(occupied.skipped).toContain("hello-c")
    expect(await fs.readFile(path.join(root, "hello-c", "recipe.json"), "utf8")).toBe("{broken")
    expect(await fs.stat(path.join(root, "hello-c-2")).catch(() => undefined)).toBeUndefined()
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
