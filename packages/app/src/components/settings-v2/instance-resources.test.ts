import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import { formatResourceBytes } from "./instance-resources"

const source = fs.readFileSync(new URL("./instance-resources.tsx", import.meta.url), "utf8")

describe("Instance resource visibility", () => {
  test("formats resident and disk bytes for people, not as raw counters", () => {
    expect(formatResourceBytes(3 * 1024 ** 3)).toBe("3.0 GiB")
    expect(formatResourceBytes(24 * 1024 ** 2)).toBe("24 MiB")
  })

  test("offers an explicit unload control and never guesses missing measurements", () => {
    expect(source).toContain("localModelStop")
    expect(source).toContain("settings.storage.resources.stop")
    expect(source).toContain("settings.storage.resources.unknown")
  })
})
