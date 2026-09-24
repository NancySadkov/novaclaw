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
  expect(await DirectoryBrowse.list(root)).toEqual([
    { name: "folder", type: "directory" },
    { name: "note.md", type: "file" },
  ])
})

test("refuses relative paths before touching the filesystem", async () => {
  await expect(DirectoryBrowse.list("relative")).rejects.toThrow("not absolute")
})
