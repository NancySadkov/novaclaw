import { basename, dirname, join } from "node:path"

/** Locate out/main independently of Rollup's choice to keep a module at the root or in chunks/. */
export function mainRuntimeDirectory(input: {
  readonly packaged: boolean
  readonly appPath: string
  readonly moduleDirectory: string
}) {
  if (input.packaged) return join(input.appPath, "out", "main")
  return basename(input.moduleDirectory) === "chunks" ? dirname(input.moduleDirectory) : input.moduleDirectory
}
