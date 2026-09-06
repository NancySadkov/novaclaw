import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

test("Bun and Node SQLite readers read existing rows and cannot write or create a database", async () => {
  const folder = await mkdtemp(join(tmpdir(), "novaclaw-readonly-sqlite-"))
  try {
    for (const runtime of [process.execPath, "node"]) {
      const source = `
        import assert from "node:assert/strict"
        import { existsSync } from "node:fs"
        import { readRowsSync } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "read-rows-sync.ts")).href)}
        const node = process.versions.bun === undefined
        const module = await import(node ? "node:sqlite" : "bun:sqlite")
        const Database = node ? module.DatabaseSync : module.Database
        const filename = ${JSON.stringify(folder)} + (node ? "/node.db" : "/bun.db")
        const db = new Database(filename)
        db.exec("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('kept')")
        db.close()
        assert.equal(readRowsSync(filename, "SELECT value FROM sample")[0].value, "kept")
        assert.equal(readRowsSync(filename, "UPDATE sample SET value = 'changed' RETURNING value"), undefined)
        assert.equal(readRowsSync(filename, "SELECT value FROM sample")[0].value, "kept")
        assert.equal(readRowsSync(filename + '.missing', "SELECT 1"), undefined)
        assert.equal(existsSync(filename + '.missing'), false)
      `
      const args = runtime === "node" ? [runtime, "--input-type=module", "--eval", source] : [runtime, "--eval", source]
      const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
      const timeout = setTimeout(() => child.kill(), 8_000)
      try {
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
        expect(code, runtime + ": " + stderr).toBe(0)
      } finally {
        clearTimeout(timeout)
        child.kill()
        await child.exited
      }
    }
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}, 20_000)
