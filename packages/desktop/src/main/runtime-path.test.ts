import { expect, test } from "bun:test"
import { join } from "node:path"
import { mainRuntimeDirectory } from "./runtime-path"

test("packaged runtime assets do not move when Rollup extracts their caller into chunks", () => {
  const appPath = join("C:\\Nova", "resources", "app.asar")
  const root = join(appPath, "out", "main")
  for (const moduleDirectory of [root, join(root, "chunks")])
    expect(mainRuntimeDirectory({ packaged: true, appPath, moduleDirectory })).toBe(root)
})
