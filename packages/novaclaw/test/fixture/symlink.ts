import { test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "./fixture"

const symlinkFixtureTest = await (async () => {
  await using tmp = await tmpdir()
  const target = path.join(tmp.path, "target")
  await fs.mkdir(target)

  try {
    await fs.symlink(target, path.join(tmp.path, "link"), process.platform === "win32" ? "junction" : "dir")
    return test
  } catch (error) {
    if (process.platform === "win32" && error instanceof Error && "code" in error && error.code === "EPERM") {
      return test.skip
    }
    throw error
  }
})()

export { symlinkFixtureTest }
