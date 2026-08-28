// IMPORT / SOURCE — the two halves of "a normal person can read, edit and share a recipe"
// (AGENTS.md → *Recipes are source code for the AI era*, the anti-elitist artifact).
//
// The unit a person shares is the FILE, so both directions are asserted on BYTES:
//   · `sourceOf` hands back exactly what is on disk, so an export is the author's recipe rather than a
//     two-field reconstruction of it (the wire record carries the prompt BODY only — the frontmatter,
//     the key order, the line endings and the trailing newline all live nowhere else);
//   · `importMarkdown` stores exactly what it was given, so a recipe that arrives carrying a
//     `produces:` line, an unmodelled key or CRLF still carries them after a round trip.
//
// ⚠️ The imported file is a STRANGER'S. The tests below therefore also pin the three things it must not
// be able to do: name its own folder (the slug is derived and re-validated, never taken from the file),
// overwrite an existing recipe, or arrive unbounded.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Recipe } from "@novaclaw/core/recipe"

const BOM = String.fromCharCode(0xfeff)

let root = ""
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "novaclaw-recipe-import-"))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
})
const opts = () => ({ root })

const fileOf = (slug: string) => path.join(root, slug, "recipe.md")

/** A shared recipe carrying everything a re-render would quietly drop. */
const SHARED = (eol: string, trailing = eol) =>
  [
    "---",
    "Name : From A Stranger",
    "description: something they wrote",
    "produces: report.md, chart.html",
    "needs: python3",
    "author: someone else",
    "# a comment they left",
    "---",
    "",
    "Do the thing and save `report.md`.",
  ].join(eol) + trailing

describe("importMarkdown — the bytes a stranger sent, stored as they were sent", () => {
  test("stores the file byte for byte, on LF and on CRLF, with and without a BOM", async () => {
    for (const [index, eol] of ["\n", "\r\n"].entries())
      for (const [prefix, bom] of [["", "plain"] as const, [BOM, "bom"] as const]) {
        const raw = prefix + SHARED(eol)
        const imported = await Recipe.importMarkdown(raw, { ...opts(), slug: `case-${index}-${bom}` })
        expect(await fs.readFile(fileOf(imported.slug), "utf8")).toBe(raw)
      }
  })

  test("a re-render would have LOST these — the negative control for the test above", async () => {
    // Without this, "stored byte for byte" could pass on a fixture nothing could damage.
    const raw = SHARED("\r\n")
    const rerendered = Recipe.render({ name: "From A Stranger", prompt: Recipe.parse(raw).prompt })
    for (const lost of ["produces: report.md", "needs: python3", "author: someone else", "# a comment they left"])
      expect(rerendered).not.toContain(lost)
    expect(rerendered).not.toContain("\r\n")
  })

  test("the carried machine-read lines SURVIVE the round trip and are read back", async () => {
    const imported = await Recipe.importMarkdown(SHARED("\n"), opts())
    expect(await Recipe.producesOf(imported.slug, opts())).toEqual(["report.md", "chart.html"])
    expect(await Recipe.needsOf(imported.slug, opts())).toEqual(["python3"])
  })

  test("the slug is DERIVED from the file's name and re-validated — never taken from it", async () => {
    const imported = await Recipe.importMarkdown(SHARED("\n"), opts())
    expect(imported.slug).toBe("from-a-stranger")
    expect(Recipe.isValidSlug(imported.slug)).toBe(true)
    expect(imported.name).toBe("From A Stranger")
    expect(imported.builtin).toBe(false)
  })

  test("🔴 a name that is a path traversal cannot become one", async () => {
    for (const hostile of ["../../../../etc/passwd", "..\\..\\windows\\system32", "C:/Windows/Temp", "/etc/shadow"]) {
      const imported = await Recipe.importMarkdown(`---\nname: ${hostile}\n---\n\nprompt\n`, opts())
      expect(Recipe.isValidSlug(imported.slug)).toBe(true)
      expect(imported.slug).not.toContain("..")
      expect(imported.slug).not.toContain("/")
      expect(imported.slug).not.toContain("\\")
      // …and it landed inside the store, which is the claim the two above only imply.
      expect(path.resolve(fileOf(imported.slug)).startsWith(path.resolve(root))).toBe(true)
    }
  })

  test("a caller-supplied slug that is not a slug is REFUSED, not sanitised into one", async () => {
    await expect(Recipe.importMarkdown("prompt", { ...opts(), slug: "../escape" })).rejects.toThrow(/Invalid recipe id/)
  })

  test("a file with no readable name still lands, under a stated fallback", async () => {
    const imported = await Recipe.importMarkdown("just a prompt, no frontmatter at all\n", opts())
    expect(imported.slug).toBe("imported-recipe")
    // A bare prompt is a valid recipe, and importing one must NOT invent a frontmatter block for it.
    expect(await fs.readFile(fileOf(imported.slug), "utf8")).toBe("just a prompt, no frontmatter at all\n")
  })

  test("🔴 importing twice never overwrites the first copy", async () => {
    const first = await Recipe.importMarkdown(SHARED("\n"), opts())
    const second = await Recipe.importMarkdown("---\nname: From A Stranger\n---\n\nsomething else\n", opts())
    expect(second.slug).not.toBe(first.slug)
    expect(await fs.readFile(fileOf(first.slug), "utf8")).toBe(SHARED("\n"))
    expect(second.prompt).toBe("something else")
  })

  test("🔴 an import cannot clobber a recipe the user already had, even by naming it exactly", async () => {
    await Recipe.save({ name: "Mine", prompt: "my own prompt", slug: "mine" }, opts())
    const imported = await Recipe.importMarkdown("---\nname: Mine\n---\n\nhostile replacement\n", opts())
    expect(imported.slug).toBe("mine-2")
    expect((await Recipe.read("mine", opts()))!.prompt).toBe("my own prompt")
  })

  test("a file with no prompt is refused — the prompt IS the recipe", async () => {
    await expect(Recipe.importMarkdown("---\nname: Empty\n---\n\n   \n", opts())).rejects.toThrow(/no prompt/)
    expect(await fs.readdir(root)).toEqual([])
  })

  test("an oversized file is refused before anything is written", async () => {
    const huge = "x".repeat(Recipe.IMPORT_CAP + 1)
    await expect(Recipe.importMarkdown(huge, opts())).rejects.toThrow(/too big/)
    expect(await fs.readdir(root)).toEqual([])
  })
})

describe("sourceOf — the file, or an honest nothing", () => {
  test("returns the exact bytes on disk", async () => {
    const raw = SHARED("\r\n", "")
    await Recipe.importMarkdown(raw, { ...opts(), slug: "exact" })
    expect(await Recipe.sourceOf("exact", opts())).toBe(raw)
  })

  test("🔴 a recipe that does not exist is `undefined` — not an empty string", async () => {
    // The distinction is the whole point: `""` would let a caller print "this recipe is empty" about a
    // file nobody opened. Same for a slug that could never be one.
    expect(await Recipe.sourceOf("nope", opts())).toBeUndefined()
    expect(await Recipe.sourceOf("../escape", opts())).toBeUndefined()
  })

  test("a recipe whose folder exists but whose file does not is `undefined`", async () => {
    await fs.mkdir(path.join(root, "hollow"), { recursive: true })
    expect(await Recipe.sourceOf("hollow", opts())).toBeUndefined()
  })
})
