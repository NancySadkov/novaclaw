import { describe, expect, test } from "bun:test"
import { Filesystem } from "@/util/filesystem"
import { resolveRunRoot } from "@/cli/cmd/run/root"

describe("resolveRunRoot", () => {
  test("uses process.cwd even when inherited PWD points elsewhere", () => {
    const previous = process.env.PWD
    process.env.PWD = "stale-shell-directory"
    try {
      expect(resolveRunRoot()).toBe(Filesystem.resolve(process.cwd()))
    } finally {
      if (previous === undefined) delete process.env.PWD
      if (previous !== undefined) process.env.PWD = previous
    }
  })
})
