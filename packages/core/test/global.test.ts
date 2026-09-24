import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@novaclaw/core/global"

describe("global paths", () => {
  test("tmp path is inside the instance home", () => {
    expect(Global.Path.tmp).toBe(path.join(Global.Path.data, "tmp"))
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })
})
