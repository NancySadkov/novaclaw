import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

test("optional main-process capabilities stay out of the cold-start graph", async () => {
  const index = await readFile(join(import.meta.dir, "wsl-instance.ts"), "utf8")
  expect(index).toContain('import("./wsl/servers")')
  expect(index).toContain('import("./wsl/sidecar")')
  expect(index).not.toContain('import { createWslServersController } from "./wsl/servers"')
  expect(index).not.toContain('import { spawnWslSidecar } from "./wsl/sidecar"')

  const debugExport = await readFile(join(import.meta.dir, "debug-export.ts"), "utf8")
  expect(debugExport).toContain('await import("@zip.js/zip.js")')
  expect(debugExport).not.toContain('from "@zip.js/zip.js"')
})
