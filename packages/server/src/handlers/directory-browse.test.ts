import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DirectoryBrowse } from "./directory-browse"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "novaclaw-directory-browse-"))
afterAll(() => fs.rm(root, { recursive: true, force: true }))

test("lists one directory without constructing a location", async () => {
  await fs.mkdir(path.join(root, "folder"))
  await fs.writeFile(path.join(root, "note.md"), "hello")
  expect(await DirectoryBrowse.list(root, { virtual: false })).toEqual([
    { name: "folder", type: "directory" },
    { name: "note.md", type: "file" },
  ])
})

test("refuses relative paths before touching the filesystem", async () => {
  await expect(DirectoryBrowse.list("relative", { virtual: false })).rejects.toThrow("not absolute")
})

test("virtual browsing cannot leave its root through a symlink", async () => {
  const virtualRoot = path.join(root, "virtual")
  const outside = path.join(root, "outside")
  const link = path.join(virtualRoot, "link")
  await fs.mkdir(virtualRoot)
  await fs.mkdir(outside)
  await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir")
  const previous = process.env.NOVACLAW_VIRTUAL_FS_ROOT
  process.env.NOVACLAW_VIRTUAL_FS_ROOT = virtualRoot
  try {
    await expect(DirectoryBrowse.list(link, { virtual: true })).rejects.toThrow("outside the virtual workspace")
  } finally {
    if (previous === undefined) delete process.env.NOVACLAW_VIRTUAL_FS_ROOT
    else process.env.NOVACLAW_VIRTUAL_FS_ROOT = previous
  }
})
