import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { dict as en } from "@/i18n/en"

const src = (path: string) => readFileSync(resolve(import.meta.dir, path), "utf8")

describe("control scope vocabulary", () => {
  test.each(["instance", "device", "chat", "draft", "colleague", "window"])("%s has human copy", (kind) => {
    expect((en as Record<string, string>)[`control.scope.${kind}`]).toBeTruthy()
  })

  test("the identified transient surfaces carry the shared scope label", () => {
    expect(src("settings-v2/general.tsx")).toContain('<ControlScope kind="window"')
    expect(src("../pages/calendar.tsx")).toContain('<ControlScope kind="draft"')
    expect(src("agent-config-dialog.tsx")).toContain('<ControlScope kind="colleague"')
    expect(src("composer/features-control.tsx").match(/<ControlScope kind="chat"/g)).toHaveLength(2)
    expect(src("prompt-input.tsx")).toContain('language.t("prompt.action.attachFile.scope")')
  })
})
