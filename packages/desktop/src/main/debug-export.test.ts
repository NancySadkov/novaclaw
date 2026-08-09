import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { collectRecentFiles } from "./debug-export"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("collectRecentFiles", () => {
  test("keeps a recent file larger than the retired 50 MB export ceiling", () => {
    const root = join(tmpdir(), `novaclaw-debug-export-${crypto.randomUUID()}`)
    roots.push(root)
    mkdirSync(root, { recursive: true })
    const file = join(root, "novaclaw.log")
    writeFileSync(file, "")
    truncateSync(file, 51 * 1024 * 1024)

    expect(collectRecentFiles(root, "server", 60_000)).toEqual([{ name: "server/novaclaw.log", path: file }])
  })

  test("keeps nested recent files but excludes stale files and heap snapshots", () => {
    const root = join(tmpdir(), `novaclaw-debug-export-${crypto.randomUUID()}`)
    roots.push(root)
    const nested = join(root, "nested")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, "main.log"), "recent")
    writeFileSync(join(root, "memory.heapsnapshot"), "private")
    const stale = join(root, "stale.log")
    writeFileSync(stale, "old")
    utimesSync(stale, new Date(0), new Date(0))

    expect(collectRecentFiles(root, "desktop", 60_000)).toEqual([
      { name: "desktop/nested/main.log", path: join(nested, "main.log") },
    ])
  })
})
