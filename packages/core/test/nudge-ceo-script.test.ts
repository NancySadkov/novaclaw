import { describe, expect, test } from "bun:test"
import { ConfigNudge } from "@novaclaw/core/config/nudge"
import { carriesHostScript } from "@novaclaw/core/tool/nudge"

const plain = { id: "n", name: "n", text: "do the thing" } as const

describe("the CEO may not attach host scripts to a nudge", () => {
  test("a free `script` field is host execution", () => {
    expect(
      carriesHostScript(
        ConfigNudge.Info.make({ ...plain, hook: { type: "interval", minutes: 60 }, script: "git status" }),
      ),
    ).toBe(true)
  })

  test("a `script` hook is host execution", () => {
    expect(
      carriesHostScript(
        ConfigNudge.Info.make({ ...plain, hook: { type: "script", command: "git status" } }),
      ),
    ).toBe(true)
  })

  test("a plain text nudge is not", () => {
    expect(
      carriesHostScript(ConfigNudge.Info.make({ ...plain, hook: { type: "interval", minutes: 60 } })),
    ).toBe(false)
  })
})
