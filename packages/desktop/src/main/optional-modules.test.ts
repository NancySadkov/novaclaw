import { expect, test } from "bun:test"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

test("optional main-process capabilities stay out of the cold-start graph", async () => {
  const application = await readFile(join(import.meta.dir, "application.ts"), "utf8")
  for (const module of ["./standalone-server", "./desktop-service", "./boot-recovery-host"]) {
    expect(application).toContain(["import", "(", JSON.stringify(module), ")"].join(""))
    expect(application).not.toContain("from " + JSON.stringify(module))
  }
  expect(application).not.toContain('from "effect"')
  const debugExport = await readFile(join(import.meta.dir, "debug-export.ts"), "utf8")
  expect(debugExport).toContain('await import("@zip.js/zip.js")')
  expect(debugExport).not.toContain('from "@zip.js/zip.js"')
})

test("desktop and app cannot restore WSL launchers, bridges or UI providers", async () => {
  for (const root of [join(import.meta.dir, ".."), join(import.meta.dir, "../../../app/src")]) {
    const entries = await readdir(root, { recursive: true, withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || entry.name.includes(".test.")) continue
      const file = join(entry.parentPath, entry.name)
      const source = await readFile(file, "utf8")
      expect(source, file).not.toMatch(
        /(?:from\s*|import\s*\()["'][^"']*\/wsl(?:\/|["'])|\bwslServers\b|\bWslServersProvider\b|\bspawn\w*\s*\(\s*["']wsl(?:\.exe)?["']/,
      )
    }
  }
})
