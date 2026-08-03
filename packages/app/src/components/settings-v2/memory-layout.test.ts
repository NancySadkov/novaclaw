import { describe, expect, test } from "bun:test"
import fs from "node:fs"

const memorySource = fs.readFileSync(new URL("./memory.tsx", import.meta.url), "utf8")
const dialogSource = fs.readFileSync(new URL("./dialog-settings-v2.tsx", import.meta.url), "utf8")

describe("Memory settings layout", () => {
  test("keeps the user profile with everything else NovaClaw knows about them", () => {
    expect(memorySource).toContain("<SettingsProfileSection />")
    expect(dialogSource).not.toContain('value="profile"')
    expect(dialogSource).not.toContain("SettingsProfileV2")
  })
})
