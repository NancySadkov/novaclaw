import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ScratchTrash } from "@novaclaw/core/scratch/trash"
import { tmpdir } from "./fixture/tmpdir"

test("a trash list cannot delete projects, directories, itself, or files behind junctions", async () => {
  await using temporary = await tmpdir()
  const scratch = path.join(temporary.path, "scratch")
  const project = path.join(temporary.path, "project")
  await fs.mkdir(scratch)
  await fs.mkdir(project)
  const outside = path.join(project, "project.txt")
  const inside = path.join(scratch, "stale.txt")
  await fs.writeFile(outside, "project")
  await fs.writeFile(inside, "scratch")
  const link = path.join(scratch, "linked-project")
  await fs.symlink(project, link, "junction")
  const trash = (await ScratchTrash.open(scratch))!
  await trash.write([outside, scratch, project, trash.list, link, path.join(link, "project.txt"), "stale.txt", inside])
  expect(await trash.scan(Date.now() + 1_000)).toEqual([inside])
  expect(await trash.removeListed(Date.now() + 1_000)).toEqual([inside])
  expect(await Bun.file(outside).text()).toBe("project")
  expect(await Bun.file(trash.list).exists()).toBe(true)
  expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
  expect((await fs.stat(scratch)).isDirectory()).toBe(true)
})

test("linked scratch roots and non-file trash lists refuse the whole operation", async () => {
  await using temporary = await tmpdir()
  const project = path.join(temporary.path, "project")
  const link = path.join(temporary.path, "scratch")
  await fs.mkdir(project)
  await fs.symlink(project, link, "junction")
  await expect(ScratchTrash.open(link)).rejects.toThrow("real directory")
  const trash = (await ScratchTrash.open(project))!
  await fs.mkdir(trash.list)
  await expect(trash.read()).rejects.toThrow("regular file")
  await expect(trash.write([])).rejects.toThrow("regular file")
})

test("missing listed files are harmless and touched or future-dated files survive", async () => {
  await using temporary = await tmpdir()
  const trash = (await ScratchTrash.open(temporary.path))!
  const target = path.join(temporary.path, "touched.txt")
  await fs.writeFile(target, "keep")
  await fs.utimes(target, 2_000, 2_000)
  await trash.write([path.join(temporary.path, "missing.txt"), target])
  expect(await trash.removeListed(1_000_000)).toEqual([])
  expect(await trash.scan(1_000_000)).toEqual([])
  expect(await Bun.file(target).text()).toBe("keep")
})

test("a scratch directory replaced after opening cannot redirect deletion into another folder", async () => {
  await using temporary = await tmpdir()
  const scratch = path.join(temporary.path, "scratch")
  const project = path.join(temporary.path, "project")
  await fs.mkdir(scratch)
  await fs.mkdir(project)
  const outside = path.join(project, "keep.txt")
  await fs.writeFile(outside, "keep")
  const trash = (await ScratchTrash.open(scratch))!
  await fs.rmdir(scratch)
  await fs.symlink(project, scratch, "junction")
  await expect(trash.removeListed(Date.now() + 1_000)).rejects.toThrow("changed during cleanup")
  await expect(trash.write([])).rejects.toThrow("changed during cleanup")
  expect(await Bun.file(outside).text()).toBe("keep")
  expect(await Bun.file(path.join(project, ScratchTrash.LIST_NAME)).exists()).toBe(false)
})
