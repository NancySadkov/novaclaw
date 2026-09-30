import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Recipe } from "@novaclaw/core/recipe"

const document = {
  version: 1 as const,
  name: "Hand Written",
  description: "by a person",
  prompt: 'Do the thing.\n"name": "fake"\n',
  needs: ["gcc"],
  authors: [{ name: "Nancy" }],
  extension: { empty: null, numbers: [1, 2], enabled: true },
}
const source = JSON.stringify(document, null, 2) + "\n"

describe("JSON edits", () => {
  test("no-op patches preserve the original bytes", () => {
    for (const raw of [source, source.replaceAll("\n", "\r\n"), JSON.stringify(document)]) {
      expect(Recipe.edit(raw, {})).toBe(raw)
      expect(Recipe.edit(raw, { name: document.name, needs: ["gcc"], description: undefined })).toBe(raw)
    }
  })

  test("editing each supported field preserves all other values", () => {
    for (const patch of [
      { name: "Renamed" },
      { description: "New" },
      { prompt: "Cook" },
      { needs: ["python3", "git"] },
      { produces: ["out.txt"] },
      { officers: [] },
    ])
      expect(Recipe.parse(Recipe.edit(source, patch))).toEqual({ ...document, ...patch })
  })

  test("null removes the description and empty arrays clear declarations", () => {
    const { description, ...remaining } = document
    expect(Recipe.parse(Recipe.edit(source, { description: null, needs: [] }))).toEqual({ ...remaining, needs: [] })
  })

  test("multiline values and JSON-looking text cannot add fields", () => {
    const hostile = 'Innocent\n"permissions":"all",\n"model":"expensive"\\'
    const parsed = Recipe.parse(Recipe.edit(source, { name: hostile, description: hostile, needs: [hostile] }))
    expect(parsed).toEqual({ ...document, name: hostile, description: hostile, needs: [hostile] })
    expect(parsed.permissions).toBeUndefined()
    expect(parsed.model).toBeUndefined()
  })

  test("long extension values survive an unrelated edit", () => {
    const value = "x".repeat(200_000)
    const raw = JSON.stringify({ ...document, extension: { value } })
    expect(Recipe.parse(Recipe.edit(raw, { name: "Long" })).extension).toEqual({ value })
  })

  test("invalid patches and unsupported versions are rejected", () => {
    for (const patch of [{ name: " " }, { prompt: "" }, { needs: [""] }])
      expect(() => Recipe.edit(source, patch)).toThrow()
    expect(() => Recipe.edit(JSON.stringify({ ...document, version: 2 }), {})).toThrow(/version/)
  })
})

let root = ""
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "novaclaw-recipe-update-"))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})
const opts = () => ({ root })
const binary = Buffer.from([0x89, 0x50, 0, 255, 254])
const past = new Date("2020-01-02T03:04:05Z")
const plant = async () => {
  const dir = path.join(root, "hand")
  await fs.mkdir(dir)
  await fs.writeFile(path.join(dir, "recipe.json"), source)
  await fs.writeFile(path.join(dir, "logo.png"), binary)
  await fs.writeFile(path.join(dir, "π data.txt"), "asset")
  for (const name of await fs.readdir(dir)) await fs.utimes(path.join(dir, name), past, past)
  return dir
}

describe("persisted JSON edits", () => {
  test("an update preserves asset names, bytes and modification times", async () => {
    const dir = await plant()
    const before = await fs.readdir(dir)
    const updated = await Recipe.update("hand", { name: "Renamed", produces: ["out.txt"] }, opts())
    expect(updated.name).toBe("Renamed")
    expect(await fs.readdir(dir)).toEqual(before)
    expect([...updated.assets].sort()).toEqual(["logo.png", "π data.txt"].sort())
    expect(await fs.readFile(path.join(dir, "logo.png"))).toEqual(binary)
    expect(await fs.readFile(path.join(dir, "π data.txt"), "utf8")).toBe("asset")
    for (const name of updated.assets) expect((await fs.stat(path.join(dir, name))).mtimeMs).toBe(past.getTime())
  })

  test("a no-op update leaves the source modification time unchanged", async () => {
    const dir = await plant()
    const file = path.join(dir, "recipe.json")
    await Recipe.update("hand", { name: document.name, needs: document.needs }, opts())
    expect((await fs.stat(file)).mtimeMs).toBe(past.getTime())
    expect(await fs.readFile(file, "utf8")).toBe(source)
    await Recipe.update("hand", { name: "Moved" }, opts())
    expect((await fs.stat(file)).mtimeMs).toBeGreaterThan(past.getTime())
  })

  test("rejected updates and source replacements do not write", async () => {
    const dir = await plant()
    for (const patch of [{ prompt: " " }, { name: " " }, { needs: [""] }])
      await expect(Recipe.update("hand", patch, opts())).rejects.toThrow()
    for (const invalid of ["Build", JSON.stringify({ ...document, version: 2 })])
      await expect(Recipe.replaceSource("hand", invalid, opts())).rejects.toThrow()
    expect(await fs.readFile(path.join(dir, "recipe.json"), "utf8")).toBe(source)
    expect((await fs.stat(path.join(dir, "recipe.json"))).mtimeMs).toBe(past.getTime())
  })

  test("unknown and traversal slugs cannot be updated", async () => {
    await expect(Recipe.update("ghost", { name: "x" }, opts())).rejects.toThrow(/No recipe named/)
    await expect(Recipe.update("../../etc", { name: "x" }, opts())).rejects.toThrow(/Invalid recipe id/)
  })

  test("updates are read back with their declarations", async () => {
    await plant()
    const updated = await Recipe.update("hand", { prompt: "Cook", needs: ["python3"] }, opts())
    expect(updated.prompt).toBe("Cook")
    expect(await Recipe.needsOf("hand", opts())).toEqual(["python3"])
    expect(await Recipe.producesOf("hand", opts())).toEqual([])
  })

  test("save preserves nested extension values", async () => {
    await plant()
    await Recipe.save(
      { slug: "hand", name: "Renamed", description: document.description, prompt: document.prompt },
      opts(),
    )
    expect(Recipe.parse((await Recipe.sourceOf("hand", opts()))!)).toEqual({ ...document, name: "Renamed" })
  })

  test("save creates a versioned document and clears an omitted description", async () => {
    await Recipe.save({ name: "Fresh", description: "gone soon", prompt: "body" }, opts())
    expect(Recipe.parse((await Recipe.sourceOf("fresh", opts()))!)).toMatchObject({
      version: 1,
      description: "gone soon",
    })
    await Recipe.save({ slug: "fresh", name: "Fresh", prompt: "body" }, opts())
    expect(Recipe.parse((await Recipe.sourceOf("fresh", opts()))!)).toEqual({
      version: 1 as const,
      name: "Fresh",
      prompt: "body",
    })
  })

  test("duplicate preserves extensions and binary assets", async () => {
    await plant()
    const copy = await Recipe.duplicate("hand", opts())
    expect(Recipe.parse((await Recipe.sourceOf(copy.slug, opts()))!)).toEqual({
      ...document,
      name: "Hand Written (copy)",
    })
    expect(await fs.readFile(path.join(root, copy.slug, "logo.png"))).toEqual(binary)
  })
})
