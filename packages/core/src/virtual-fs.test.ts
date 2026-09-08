import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { VirtualFs } from "./virtual-fs"

const cleanups: string[] = []
const savedRoot = process.env.NOVACLAW_VIRTUAL_FS_ROOT
const savedFlag = process.env.NOVACLAW_VIRTUAL_FS
async function tmpdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vfs-"))
  cleanups.push(dir)
  return dir
}
afterEach(async () => {
  if (savedRoot === undefined) delete process.env.NOVACLAW_VIRTUAL_FS_ROOT
  else process.env.NOVACLAW_VIRTUAL_FS_ROOT = savedRoot
  if (savedFlag === undefined) delete process.env.NOVACLAW_VIRTUAL_FS
  else process.env.NOVACLAW_VIRTUAL_FS = savedFlag
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true })
})

describe("virtual FS (FS-3)", () => {
  test("enabled() honors the flag and the config field", () => {
    delete process.env.NOVACLAW_VIRTUAL_FS
    expect(VirtualFs.enabled()).toBe(false)
    expect(VirtualFs.enabled({ virtualFs: true })).toBe(true)
    expect(VirtualFs.enabled({ virtualFs: false })).toBe(false)
    process.env.NOVACLAW_VIRTUAL_FS = "1"
    expect(VirtualFs.enabled()).toBe(true) // flag forces it regardless of config
  })

  test("ensure() provisions the root, subdirs, and a README (idempotent)", async () => {
    const base = path.join(await tmpdir(), "vfs")
    process.env.NOVACLAW_VIRTUAL_FS_ROOT = base
    const root = await VirtualFs.ensure()
    expect(root).toBe(base)
    for (const sub of ["projects", "notes", "files"])
      expect(await fs.stat(path.join(base, sub)).then((s) => s.isDirectory())).toBe(true)
    expect(await fs.readFile(path.join(base, "README.md"), "utf8")).toContain("NovaClaw")
    // idempotent — a second call must not throw or clobber a user's edited README
    await fs.writeFile(path.join(base, "README.md"), "edited")
    await VirtualFs.ensure()
    expect(await fs.readFile(path.join(base, "README.md"), "utf8")).toBe("edited")
  })

  test("defaultProjectDir is the projects subdir; contains() guards the root", async () => {
    const base = path.join(await tmpdir(), "vfs")
    process.env.NOVACLAW_VIRTUAL_FS_ROOT = base
    expect(VirtualFs.defaultProjectDir()).toBe(path.join(base, "projects"))
    expect(VirtualFs.contains(path.join(base, "projects", "a.txt"))).toBe(true)
    expect(VirtualFs.contains(base)).toBe(true)
    expect(VirtualFs.contains(path.join(os.tmpdir(), "elsewhere"))).toBe(false)
    // no partial-prefix escape (vfs-evil vs vfs)
    expect(VirtualFs.contains(base + "-evil")).toBe(false)
  })
})
