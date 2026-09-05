import { describe, expect, test } from "bun:test"
import { deflateRawSync } from "node:zlib"
import { ArchiveAttachment } from "./archive-attachment"

/**
 * A minimal ZIP writer, so these tests exercise a REAL container rather than a fixture nobody can
 * read. Deflate for anything compressible, stored otherwise — the two methods the reader supports.
 */
function zip(files: ReadonlyArray<{ name: string; body: Uint8Array | string; store?: boolean }>): Uint8Array {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8")
    const raw = typeof file.body === "string" ? Buffer.from(file.body, "utf8") : Buffer.from(file.body)
    const stored = file.store === true
    const payload = stored ? raw : deflateRawSync(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, payload)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(stored ? 0 : 8, 10)
    entry.writeUInt32LE(payload.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)
    offset += local.length + name.length + payload.length
  }
  const localBytes = Buffer.concat(locals)
  const centralBytes = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBytes.length, 12)
  eocd.writeUInt32LE(localBytes.length, 16)
  return new Uint8Array(Buffer.concat([localBytes, centralBytes, eocd]))
}

const digest = (bytes: Uint8Array | undefined, name = "project.zip", mime = "application/zip", options?: object) =>
  ArchiveAttachment.archiveDigest({ bytes, name, mime, ...(options ? { options } : {}) })

describe("recognising an archive", () => {
  test("by mime, and by extension when the browser will not name it", () => {
    expect(ArchiveAttachment.isArchive({ mime: "application/zip" })).toBe(true)
    expect(ArchiveAttachment.isArchive({ mime: "application/octet-stream", name: "x.tar.gz" })).toBe(true)
    expect(ArchiveAttachment.isArchive({ mime: "", name: "x.7z" })).toBe(true)
    expect(ArchiveAttachment.isArchive({ mime: "application/x-tar" })).toBe(true)
  })

  test("🔴 a NAMED mime is believed over the extension", () => {
    // Trusting the extension in general would let a PNG called `notes.zip` take the archive path and
    // be refused as unopenable, instead of reaching a vision model as the image it actually is.
    expect(ArchiveAttachment.isArchive({ mime: "image/png", name: "notes.zip" })).toBe(false)
    expect(ArchiveAttachment.isArchive({ mime: "text/plain", name: "readme.zip" })).toBe(false)
  })

  test("ordinary attachments are not archives", () => {
    expect(ArchiveAttachment.isArchive({ mime: "text/markdown", name: "spec.md" })).toBe(false)
    expect(ArchiveAttachment.isArchive({ mime: "application/pdf", name: "paper.pdf" })).toBe(false)
  })

  test("isZip separates what we can OPEN from what we can merely recognise", () => {
    expect(ArchiveAttachment.isZip({ mime: "application/zip" })).toBe(true)
    expect(ArchiveAttachment.isZip({ mime: "application/octet-stream", name: "lib.whl" })).toBe(true)
    expect(ArchiveAttachment.isZip({ mime: "application/x-tar" })).toBe(false)
    expect(ArchiveAttachment.isZip({ mime: "application/gzip", name: "src.tar.gz" })).toBe(false)
  })
})

describe("reading a real ZIP", () => {
  test("the directory, and every entry's bytes", () => {
    const bytes = zip([
      { name: "src/main.ts", body: "export const answer = 42\n" },
      { name: "README.md", body: "# Project\n", store: true },
    ])
    const entries = ArchiveAttachment.readZipDirectory(bytes)!
    expect(entries.map((entry) => entry.name)).toEqual(["src/main.ts", "README.md"])
    expect(Buffer.from(ArchiveAttachment.readZipEntry(bytes, entries[0]!)!).toString()).toContain("answer = 42")
    expect(Buffer.from(ArchiveAttachment.readZipEntry(bytes, entries[1]!)!).toString()).toBe("# Project\n")
  })

  test("⚠️ a truncated archive returns undefined rather than throwing", () => {
    // A malformed attachment must degrade the turn's information, never fail the turn.
    const bytes = zip([{ name: "a.txt", body: "hello" }])
    expect(ArchiveAttachment.readZipDirectory(bytes.subarray(0, bytes.length - 8))).toBeUndefined()
    expect(ArchiveAttachment.readZipDirectory(new Uint8Array(0))).toBeUndefined()
    expect(ArchiveAttachment.readZipDirectory(new Uint8Array([1, 2, 3, 4, 5]))).toBeUndefined()
  })

  test("textual detection rejects binary", () => {
    expect(ArchiveAttachment.looksTextual(Buffer.from("plain text"))).toBe(true)
    expect(ArchiveAttachment.looksTextual(new Uint8Array([0x89, 0x50, 0x00, 0x4e]))).toBe(false)
  })

  test("🔴 refuses a deflate bomb before it can exhaust the host", () => {
    // The digest's per-entry character cap is too late to protect this boundary: zlib must first
    // materialise the expanded bytes. The parser's byte cap is the security check, and this archive
    // keeps the compressed fixture small while asking for more than the allowed expansion.
    const expanded = new Uint8Array(ArchiveAttachment.MAX_EXPANDED_ENTRY_BYTES + 1)
    expanded.fill(0x61)
    const bytes = zip([{ name: "bomb.txt", body: expanded }])
    const entries = ArchiveAttachment.readZipDirectory(bytes)!
    expect(ArchiveAttachment.readZipEntry(bytes, entries[0]!)).toBeUndefined()
  })
})

describe("the digest a model actually sees", () => {
  test("🔴 the CONTENTS are inlined, not just a listing", () => {
    // A manifest alone lets a model describe a directory tree. "Analyse this zip" means the source.
    const out = digest(
      zip([
        { name: "src/main.ts", body: "export const answer = 42\n" },
        { name: "README.md", body: "# Project\nHello.\n" },
      ]),
    )
    expect(out).toContain("src/main.ts")
    expect(out).toContain("answer = 42")
    expect(out).toContain("# Project")
  })

  test("🔴 everything NOT shown is named, with the reason", () => {
    // A budget that silently drops half the archive teaches the model it saw the whole thing.
    const out = digest(zip([{ name: "logo.png", body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]) }]))
    expect(out).toContain("NOT shown to you")
    expect(out).toContain("logo.png — binary")
    expect(out).toContain("Do not describe or guess")
  })

  test("build and VCS noise is skipped, and said to be skipped", () => {
    const out = digest(
      zip([
        { name: "node_modules/left-pad/index.js", body: "module.exports = 1" },
        { name: ".git/config", body: "[core]" },
        { name: "index.js", body: "console.log(1)" },
      ]),
    )
    expect(out).toContain("index.js")
    expect(out).toContain("node_modules/left-pad/index.js — build or VCS noise")
    expect(out).toContain(".git/config — build or VCS noise")
  })

  test("⚠️ the budget is enforced and the overflow is ACCOUNTED FOR", () => {
    const big = "x".repeat(5000)
    const out = digest(
      zip([
        { name: "a.txt", body: big },
        { name: "b.txt", body: big },
        { name: "c.txt", body: big },
      ]),
      "p.zip",
      "application/zip",
      { budget: 6000, perEntry: 5000 },
    )
    expect(out.length).toBeLessThan(20000)
    expect(out).toContain("the inline budget was already spent")
  })

  test("one huge entry cannot consume the whole budget in silence", () => {
    const out = digest(zip([{ name: "lock.json", body: "y".repeat(40_000) }]), "p.zip", "application/zip", {
      perEntry: 100,
    })
    expect(out).toContain("truncated at 100 characters")
  })

  test("🔴 a format we recognise but cannot open says so, and hands the job over", () => {
    // The honest refusal. We can name a .tar.gz and cannot read it here; describing it anyway would
    // be the model inventing an archive nobody opened.
    const out = ArchiveAttachment.archiveDigest({
      bytes: new Uint8Array([0x1f, 0x8b, 0x08]),
      name: "src.tar.gz",
      mime: "application/gzip",
    })
    expect(out).toContain("only read ZIP containers")
    expect(out).toContain("do not")
    expect(out).toContain("extract it with your own tools")
  })

  test("an unopenable ZIP admits it rather than reporting an empty archive", () => {
    const bytes = zip([{ name: "a.txt", body: "hello" }])
    const out = digest(bytes.subarray(0, bytes.length - 8))
    expect(out).toContain("could not be opened")
    expect(out).toContain("You have not seen inside it")
  })

  test("missing bytes are admitted too", () => {
    expect(digest(undefined)).toContain("did not reach this turn")
  })

  test("an empty archive is reported as empty, not as a failure", () => {
    const out = digest(zip([]))
    expect(out).toContain("0 files")
    expect(out).not.toContain("could not be opened")
  })
})
