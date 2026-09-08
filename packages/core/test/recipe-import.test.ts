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

const zipCentralOffsets = (archive: Uint8Array): number[] => {
  const bytes = Buffer.from(archive)
  const offsets: number[] = []
  for (let offset = 0; offset + 4 <= bytes.length; offset++) {
    if (bytes.readUInt32LE(offset) === 0x02014b50) offsets.push(offset)
  }
  return offsets
}

const zipLocalOffsets = (archive: Uint8Array): number[] => {
  const bytes = Buffer.from(archive)
  const offsets: number[] = []
  for (let offset = 0; offset + 4 <= bytes.length; offset++) {
    if (bytes.readUInt32LE(offset) === 0x04034b50) offsets.push(offset)
  }
  return offsets
}

const zipEntryName = (bytes: Buffer, offset: number, central: boolean): string => {
  const nameLength = bytes.readUInt16LE(offset + (central ? 28 : 26))
  return bytes.subarray(offset + (central ? 46 : 30), offset + (central ? 46 : 30) + nameLength).toString("utf8")
}

const mutateNamedEntry = (
  archive: Uint8Array,
  wanted: string,
  mutate: (bytes: Buffer, offset: number, central: boolean) => void,
): Uint8Array => {
  const bytes = Buffer.from(archive)
  for (const offset of zipLocalOffsets(bytes))
    if (zipEntryName(bytes, offset, false) === wanted) mutate(bytes, offset, false)
  for (const offset of zipCentralOffsets(bytes))
    if (zipEntryName(bytes, offset, true) === wanted) mutate(bytes, offset, true)
  return bytes
}

const renameEntry = (archive: Uint8Array, from: string, to: string): Uint8Array => {
  if (Buffer.byteLength(from) !== Buffer.byteLength(to)) throw new Error("test ZIP rename must preserve header size")
  return mutateNamedEntry(archive, from, (bytes, offset, central) => {
    bytes.write(to, offset + (central ? 46 : 30), "utf8")
  })
}

const withZipComment = (archive: Uint8Array, comment: Uint8Array): Uint8Array => {
  const bytes = Buffer.from(archive)
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (end < 0 || comment.byteLength > 0xffff) throw new Error("test ZIP needs a conventional end record")
  bytes.writeUInt16LE(comment.byteLength, end + 20)
  return Buffer.concat([bytes, comment])
}

const centralEntry = (archive: Uint8Array, wanted: string): { bytes: Buffer; offset: number } => {
  const bytes = Buffer.from(archive)
  const offset = zipCentralOffsets(bytes).find((candidate) => zipEntryName(bytes, candidate, true) === wanted)
  if (offset === undefined) throw new Error(`test ZIP has no ${wanted}`)
  return { bytes, offset }
}

const snapshot = async (dir: string, prefix = ""): Promise<Record<string, string>> => {
  const result: Record<string, string> = {}
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      result[`${relative}/`] = "directory"
      Object.assign(result, await snapshot(path.join(dir, entry.name), relative))
    } else result[relative] = Buffer.from(await fs.readFile(path.join(dir, entry.name))).toString("hex")
  }
  return result
}

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

describe("folder ZIP transport", () => {
  test("round-trips recipe.md, nested binary assets and empty folders byte-for-byte after the source is gone", async () => {
    await Recipe.importMarkdown("---\nname: Folder Transport\n---\n\nUse every supplied asset.\n", {
      ...opts(),
      slug: "folder-transport",
    })
    const source = path.join(root, "folder-transport")
    await fs.mkdir(path.join(source, "nested", "empty"), { recursive: true })
    await fs.writeFile(path.join(source, "nested", "binary.bin"), Uint8Array.of(0, 255, 19, 0, 128, 42))
    await fs.writeFile(
      path.join(source, "photo.dat"),
      Uint8Array.from({ length: 4096 }, (_, index) => index % 251),
    )
    const before = await snapshot(source)

    const archive = await Recipe.exportArchive("folder-transport", opts())
    await Recipe.remove("folder-transport", opts())
    expect(await fs.lstat(source).catch(() => undefined)).toBeUndefined()
    const imported = await Recipe.importArchive(archive, { ...opts(), slug: "arrived" })

    expect(imported.slug).toBe("arrived")
    expect(await snapshot(path.join(root, imported.slug))).toEqual(before)
    const work = path.join(root, "cooked")
    const materialized = await Recipe.materialize(imported.slug, work, opts())
    expect(materialized.failed).toEqual([])
    expect(materialized.skipped).toEqual([])
    expect(await snapshot(work)).toEqual(before)

    const maximum = "a".repeat(64)
    await Recipe.save({ slug: maximum, name: "Existing", prompt: "keep" }, opts())
    const collision = await Recipe.importArchive(archive, { ...opts(), slug: maximum })
    expect(collision.slug).toBe(`${"a".repeat(62)}-2`)
    expect((await Recipe.read(maximum, opts()))?.prompt).toBe("keep")
  })

  test("accepts standard deflate flags, CP437 names and signature-bearing comments, and exports portable modes", async () => {
    await Recipe.importMarkdown("---\nname: Interoperable ZIP\n---\n\nUse the supplied files.\n", {
      ...opts(),
      slug: "interoperable-zip",
    })
    const source = path.join(root, "interoperable-zip")
    await fs.mkdir(path.join(source, "nested"))
    await fs.writeFile(path.join(source, "nested", "inside.txt"), "inside")
    await fs.writeFile(path.join(source, "cafe.txt"), "CP437 name")
    await fs.writeFile(path.join(source, "compress.txt"), "compress me ".repeat(1_000))
    const archive = await Recipe.exportArchive("interoperable-zip", opts())

    const regular = centralEntry(archive, "compress.txt")
    expect(regular.bytes.readUInt16LE(regular.offset + 10)).toBe(8)
    expect(regular.bytes.readUInt16LE(regular.offset + 4) >>> 8).toBe(3)
    expect(regular.bytes.readUInt32LE(regular.offset + 38) >>> 16).toBe(0o100644)
    const directory = centralEntry(archive, "nested/")
    expect(directory.bytes.readUInt32LE(directory.offset + 38) >>> 16).toBe(0o040755)

    const legalDeflateFlags = mutateNamedEntry(archive, "compress.txt", (bytes, offset, central) => {
      const flagOffset = offset + (central ? 8 : 6)
      bytes.writeUInt16LE(bytes.readUInt16LE(flagOffset) | 0x0002, flagOffset)
    })
    const flagged = await Recipe.importArchive(legalDeflateFlags, { ...opts(), slug: "legal-deflate-flags" })
    expect(await fs.readFile(path.join(root, flagged.slug, "compress.txt"), "utf8")).toBe("compress me ".repeat(1_000))

    const cp437 = mutateNamedEntry(archive, "cafe.txt", (bytes, offset, central) => {
      const flagOffset = offset + (central ? 8 : 6)
      bytes.writeUInt16LE(bytes.readUInt16LE(flagOffset) & ~0x0800, flagOffset)
      bytes[offset + (central ? 46 : 30) + 3] = 0x82 // CP437 `é`, same one-byte width as the replaced `e`.
    })
    const named = await Recipe.importArchive(cp437, { ...opts(), slug: "cp437-name" })
    expect(await fs.readFile(path.join(root, named.slug, "café.txt"), "utf8")).toBe("CP437 name")

    const comment = Buffer.alloc(30, 0x41)
    comment.writeUInt32LE(0x06054b50, 0) // A false EOCD signature inside a legal arbitrary ZIP comment.
    const commented = await Recipe.importArchive(withZipComment(archive, comment), {
      ...opts(),
      slug: "signature-comment",
    })
    expect(await fs.readFile(path.join(root, commented.slug, "nested", "inside.txt"), "utf8")).toBe("inside")
  })

  test("one slug claim serializes archive, markdown and duplicate writers without replacement or a hybrid", async () => {
    await Recipe.importMarkdown("---\nname: Claim Source\n---\n\narchive contender\n", {
      ...opts(),
      slug: "claim-source",
    })
    await fs.writeFile(path.join(root, "claim-source", "archive.bin"), Uint8Array.of(0, 255, 7))
    const archive = await Recipe.exportArchive("claim-source", opts())
    await Recipe.remove("claim-source", opts())

    const [folder, prose] = await Promise.all([
      Recipe.importArchive(archive, { ...opts(), slug: "shared-claim" }),
      Recipe.importMarkdown("---\nname: Prose contender\n---\n\nmarkdown contender\n", {
        ...opts(),
        slug: "shared-claim",
      }),
    ])
    expect(new Set([folder.slug, prose.slug])).toEqual(new Set(["shared-claim", "shared-claim-2"]))
    expect((await Recipe.read(folder.slug, opts()))?.prompt).toBe("archive contender")
    expect(await fs.readFile(path.join(root, folder.slug, "archive.bin"))).toEqual(Buffer.from([0, 255, 7]))
    expect((await Recipe.read(prose.slug, opts()))?.prompt).toBe("markdown contender")
    expect(await fs.lstat(path.join(root, prose.slug, "archive.bin")).catch(() => undefined)).toBeUndefined()

    await Recipe.save({ slug: "copy-source", name: "Copy source", prompt: "duplicate contender" }, opts())
    await fs.writeFile(path.join(root, "copy-source", "copy.bin"), "copy")
    const [copy, imported] = await Promise.all([
      Recipe.duplicate("copy-source", opts()),
      Recipe.importArchive(archive, { ...opts(), slug: "copy-source-2" }),
    ])
    expect(new Set([copy.slug, imported.slug])).toEqual(new Set(["copy-source-2", "copy-source-3"]))
    expect((await Recipe.read(copy.slug, opts()))?.prompt).toBe("duplicate contender")
    expect(await fs.readFile(path.join(root, copy.slug, "copy.bin"), "utf8")).toBe("copy")
    expect((await Recipe.read(imported.slug, opts()))?.prompt).toBe("archive contender")
    expect((await fs.readdir(root)).some((name) => /recipe-(?:stage|write)/.test(name))).toBe(false)

    const saving = Recipe.save({ slug: "save-first", name: "Save first", prompt: "saved whole" }, opts())
    const importing = Recipe.importArchive(archive, { ...opts(), slug: "save-first" })
    const [saved, afterSave] = await Promise.all([saving, importing])
    expect(new Set([saved.slug, afterSave.slug])).toEqual(new Set(["save-first", "save-first-2"]))
    expect((await Recipe.read(saved.slug, opts()))?.prompt).toBe("saved whole")
    expect((await Recipe.read(afterSave.slug, opts()))?.prompt).toBe("archive contender")
  })

  test("rejects hostile paths, collisions, links, special/encrypted/ZIP64/unsupported forms, and leaves no half recipe", async () => {
    await Recipe.importMarkdown("---\nname: Guarded ZIP\n---\n\nbody\n", { ...opts(), slug: "zip-fixture" })
    const dir = path.join(root, "zip-fixture")
    await fs.writeFile(path.join(dir, "asset.txt"), "asset")
    await fs.writeFile(path.join(dir, "A.txt"), "upper")
    await fs.writeFile(path.join(dir, "b.txt"), "lower")
    await fs.mkdir(path.join(dir, "A"))
    await fs.mkdir(path.join(dir, "b"))
    await fs.writeFile(path.join(dir, "A", "one.txt"), "one")
    await fs.writeFile(path.join(dir, "b", "two.txt"), "two")
    const original = await Recipe.exportArchive("zip-fixture", opts())
    await Recipe.remove("zip-fixture", opts())

    const hostile: readonly [string, Uint8Array][] = [
      ["traversal", renameEntry(original, "asset.txt", "../bad.md")],
      ["absolute", renameEntry(original, "asset.txt", "/evil.txt")],
      ["duplicate", renameEntry(original, "b.txt", "A.txt")],
      ["case collision", renameEntry(original, "b.txt", "a.txt")],
      ["ancestor case collision", renameEntry(original, "b/two.txt", "a/two.txt")],
      [
        "link",
        mutateNamedEntry(original, "asset.txt", (bytes, offset, central) => {
          if (central) bytes.writeUInt32LE(0xa0000000, offset + 38)
        }),
      ],
      [
        "special",
        mutateNamedEntry(original, "asset.txt", (bytes, offset, central) => {
          if (central) bytes.writeUInt32LE(0x80000008, offset + 38)
        }),
      ],
      [
        "encrypted",
        mutateNamedEntry(original, "asset.txt", (bytes, offset, central) => {
          const flagOffset = offset + (central ? 8 : 6)
          bytes.writeUInt16LE(bytes.readUInt16LE(flagOffset) | 1, flagOffset)
        }),
      ],
      [
        "ZIP64",
        mutateNamedEntry(original, "asset.txt", (bytes, offset, central) => {
          if (central) bytes.writeUInt32LE(0xffffffff, offset + 20)
        }),
      ],
      [
        "unsupported compression",
        mutateNamedEntry(original, "asset.txt", (bytes, offset, central) => {
          bytes.writeUInt16LE(99, offset + (central ? 10 : 8))
        }),
      ],
    ]
    for (const [label, archive] of hostile) {
      await expect(
        Recipe.importArchive(archive, { ...opts(), slug: `refused-${label.replaceAll(" ", "-")}` }),
      ).rejects.toThrow()
      expect((await fs.readdir(root)).filter((name) => name.startsWith("refused-"))).toEqual([])
    }

    const corrupt = Buffer.from(original)
    const assetLocal = zipLocalOffsets(corrupt).find((offset) => zipEntryName(corrupt, offset, false) === "asset.txt")!
    const nameLength = corrupt.readUInt16LE(assetLocal + 26)
    const extraLength = corrupt.readUInt16LE(assetLocal + 28)
    corrupt[assetLocal + 30 + nameLength + extraLength] ^= 0xff
    await expect(Recipe.importArchive(corrupt, { ...opts(), slug: "failed-checksum" })).rejects.toThrow(
      /checksum|decompress/i,
    )
    expect(await fs.lstat(path.join(root, "failed-checksum")).catch(() => undefined)).toBeUndefined()
    expect((await fs.readdir(root)).some((name) => /recipe-(?:stage|write)/.test(name))).toBe(false)
  })

  test("enforces compressed, expanded, per-file and entry-count budgets before extraction", async () => {
    await expect(Recipe.importArchive(new Uint8Array(Recipe.ARCHIVE_COMPRESSED_CAP + 1), opts())).rejects.toThrow(
      /compressed limit/,
    )

    await Recipe.importMarkdown("---\nname: Budget ZIP\n---\n\nbody\n", { ...opts(), slug: "budget-zip" })
    for (let index = 0; index < 5; index++) await fs.writeFile(path.join(root, "budget-zip", `f${index}.txt`), "x")
    const original = await Recipe.exportArchive("budget-zip", opts())
    const perFile = mutateNamedEntry(original, "f0.txt", (bytes, offset, central) => {
      if (!central) return
      // Use a deflated central entry so the stored-entry consistency guard does not (correctly)
      // precede the budget branch this fixture exists to exercise.
      bytes.writeUInt16LE(8, offset + 10)
      bytes.writeUInt32LE(Recipe.ARCHIVE_FILE_CAP + 1, offset + 24)
    })
    await expect(Recipe.importArchive(perFile, { ...opts(), slug: "over-file" })).rejects.toThrow(/per-file limit/)

    let expanded: Uint8Array = Uint8Array.from(original)
    for (const name of ["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt"])
      expanded = mutateNamedEntry(expanded, name, (bytes, offset, central) => {
        if (!central) return
        bytes.writeUInt16LE(8, offset + 10)
        bytes.writeUInt32LE(Recipe.ARCHIVE_FILE_CAP, offset + 24)
      })
    await expect(Recipe.importArchive(expanded, { ...opts(), slug: "over-expanded" })).rejects.toThrow(/expands past/)

    const tooMany = Buffer.from(original)
    const end = tooMany.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    tooMany.writeUInt16LE(Recipe.ARCHIVE_ENTRY_CAP + 1, end + 8)
    tooMany.writeUInt16LE(Recipe.ARCHIVE_ENTRY_CAP + 1, end + 10)
    await expect(Recipe.importArchive(tooMany, { ...opts(), slug: "over-count" })).rejects.toThrow(/more than/)
    expect((await fs.readdir(root)).filter((name) => name.startsWith("over-"))).toEqual([])
  })
})
