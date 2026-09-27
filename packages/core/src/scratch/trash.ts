export * as ScratchTrash from "./trash"

import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

export const LIST_NAME = "trash-list.txt"

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"

const stat = async (target: string) =>
  fs.lstat(target).catch((error) => {
    if (missing(error)) return undefined
    throw error
  })

const inside = (folder: string, target: string) => {
  const relative = path.relative(folder, target)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export async function open(folder: string) {
  const root = path.resolve(folder)
  const rootStat = await stat(root)
  if (!rootStat) return undefined
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || path.relative(root, await fs.realpath(root)) !== "")
    throw new Error(`Scratch folder must be a real directory: ${root}`)
  const list = path.join(root, LIST_NAME)
  const validateRoot = async () => {
    const current = await stat(root)
    if (
      !current ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.ino !== rootStat.ino ||
      current.dev !== rootStat.dev ||
      path.relative(root, await fs.realpath(root)) !== ""
    )
      throw new Error(`Scratch folder changed during cleanup: ${root}`)
  }

  const regularFile = async (target: string) => {
    if (!path.isAbsolute(target) || path.resolve(target) !== target || !inside(root, target)) return undefined
    await validateRoot()
    const segments = path.relative(root, target).split(path.sep)
    let cursor = root
    for (let index = 0; index < segments.length; index++) {
      cursor = path.join(cursor, segments[index]!)
      const info = await stat(cursor)
      if (!info || info.isSymbolicLink()) return undefined
      if (index === segments.length - 1) return info.isFile() ? info : undefined
      if (!info.isDirectory()) return undefined
    }
    return undefined
  }

  const read = async () => {
    await validateRoot()
    const info = await stat(list)
    if (!info) return []
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Trash list must be a regular file: ${list}`)
    return (await fs.readFile(list, "utf8")).split(/\r?\n/).filter((line) => line !== "")
  }

  const removeListed = async (cutoff: number) => {
    const removed: string[] = []
    for (const target of new Set(await read())) {
      if (path.resolve(target) === list) continue
      const info = await regularFile(target)
      if (!info || info.mtimeMs > cutoff) continue
      await fs.unlink(target).catch((error) => {
        if (!missing(error)) throw error
      })
      removed.push(target)
    }
    return removed
  }

  const scan = async (cutoff: number) => {
    const files: string[] = []
    const visit = async (directory: string): Promise<void> => {
      await validateRoot()
      const directoryStat = await stat(directory)
      if (
        !directoryStat ||
        !directoryStat.isDirectory() ||
        directoryStat.isSymbolicLink() ||
        path.relative(directory, await fs.realpath(directory)) !== ""
      )
        return
      const entries = await fs.readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (/[\r\n]/.test(entry.name) || entry.isSymbolicLink()) continue
        const target = path.join(directory, entry.name)
        if (target === list) continue
        const info = await stat(target)
        if (!info || info.isSymbolicLink()) continue
        if (info.isDirectory()) await visit(target)
        else if (info.isFile() && info.mtimeMs <= cutoff) files.push(target)
      }
    }
    await visit(root)
    return files.sort()
  }

  const write = async (files: readonly string[]) => {
    await read()
    const temporary = path.join(root, `.trash-list-${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temporary, files.length ? files.join("\n") + "\n" : "", { flag: "wx" })
      await validateRoot()
      await fs.rename(temporary, list)
    } finally {
      await fs.unlink(temporary).catch((error) => {
        if (!missing(error)) throw error
      })
    }
  }

  return { list, read, removeListed, scan, write }
}
