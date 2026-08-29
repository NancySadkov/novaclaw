import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { TextWriter, Uint8ArrayReader, ZipReader } from "@zip.js/zip.js"
import {
  collectRecentFiles,
  serverDiagnosticEntry,
  writeDebugZip,
  type DebugExportBudget,
} from "./debug-export"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const fixture = () => {
  const root = join(tmpdir(), `novaclaw-debug-export-${crypto.randomUUID()}`)
  roots.push(root)
  mkdirSync(root, { recursive: true })
  return root
}

const budget = (overrides: Partial<DebugExportBudget> = {}): DebugExportBudget => ({
  maxFiles: 64,
  maxFileBytes: 1024,
  maxTotalBytes: 4096,
  maxDepth: 4,
  deadlineAt: Date.now() + 10_000,
  ...overrides,
})

const zipEntries = async (file: string) => {
  const bytes = readFileSync(file)
  const copy = new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const reader = new ZipReader(new Uint8ArrayReader(copy))
  try {
    return await reader.getEntries()
  } finally {
    await reader.close()
  }
}

describe("collectRecentFiles", () => {
  test("keeps recent regular files while enforcing file, total and count budgets", async () => {
    const root = fixture()
    writeFileSync(join(root, "first.log"), "1234")
    writeFileSync(join(root, "second.log"), "5678")
    writeFileSync(join(root, "oversized.log"), "x".repeat(20))

    const result = await collectRecentFiles(
      root,
      "desktop",
      60_000,
      budget({ maxFiles: 64, maxFileBytes: 8, maxTotalBytes: 4 }),
    )
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.name).toStartWith("desktop/")
    expect(result.bytes).toBe(4)
    expect(result.omitted.budget).toBe(2)
  })

  test("enforces count, depth, cancellation and wall-clock budgets", async () => {
    const root = fixture()
    writeFileSync(join(root, "first.log"), "1")
    writeFileSync(join(root, "second.log"), "2")
    const nested = join(root, "nested")
    mkdirSync(nested)
    writeFileSync(join(nested, "deep.log"), "3")

    const bounded = await collectRecentFiles(root, "desktop", 60_000, budget({ maxFiles: 1, maxDepth: 0 }))
    expect(bounded.entries).toHaveLength(1)
    expect(bounded.omitted.budget).toBe(2)

    await expect(
      collectRecentFiles(root, "desktop", 60_000, budget({ deadlineAt: Date.now() - 1 })),
    ).rejects.toMatchObject({ name: "TimeoutError" })
    const controller = new AbortController()
    controller.abort(new DOMException("cancelled", "AbortError"))
    await expect(
      collectRecentFiles(root, "desktop", 60_000, budget({ signal: controller.signal })),
    ).rejects.toMatchObject({ name: "AbortError" })
  })

  test("keeps nested recent files but excludes stale files, heap snapshots, and symlink loops", async () => {
    const root = fixture()
    const nested = join(root, "nested")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, "main.log"), "recent")
    writeFileSync(join(root, "memory.heapsnapshot"), "private")
    const stale = join(root, "stale.log")
    writeFileSync(stale, "old")
    utimesSync(stale, new Date(0), new Date(0))
    symlinkSync(root, join(nested, "loop"), "junction")

    const result = await collectRecentFiles(root, "desktop", 60_000, budget())
    expect(result.entries.map((entry) => entry.name)).toEqual(["desktop/nested/main.log"])
    expect(result.omitted.symlinks).toBe(1)
  })

  test("a disappearing file is skipped without invalidating the archive", async () => {
    const root = fixture()
    const source = join(root, "gone.log")
    const kept = join(root, "kept.log")
    const output = join(root, "result.zip")
    writeFileSync(source, "gone")
    writeFileSync(kept, "kept bytes")
    const collected = await collectRecentFiles(root, "desktop", 60_000, budget())
    rmSync(source)

    await writeDebugZip(output, [{ name: "manifest.json", data: "{}" }, ...collected.entries], {
      deadlineAt: Date.now() + 10_000,
    })
    const entries = await zipEntries(output)
    expect(entries.map((entry) => entry.filename).sort()).toEqual(["desktop/kept.log", "manifest.json"])
    const keptEntry = entries.find((entry) => entry.filename === "desktop/kept.log")
    expect(await keptEntry?.getData?.(new TextWriter())).toBe("kept bytes")
  })

  test("a remote path-shaped value is archive data and never reads the coincident local sentinel", async () => {
    const root = fixture()
    const sentinel = join(root, "coincident.log")
    const output = join(root, "result.zip")
    writeFileSync(sentinel, "LOCAL-SENTINEL-MUST-NOT-LEAK")

    await writeDebugZip(output, [serverDiagnosticEntry(sentinel)], { deadlineAt: Date.now() + 10_000 })
    const entries = await zipEntries(output)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.filename).toBe("server/novaclaw.log")
    const content = await entries[0]?.getData?.(new TextWriter())
    expect(content).toBe(sentinel)
    expect(content).not.toContain("LOCAL-SENTINEL")
  })
})
