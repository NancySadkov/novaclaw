import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const source = fs.readFileSync(path.join(import.meta.dir, "native-transcript.tsx"), "utf8")
const css = fs.readFileSync(path.join(import.meta.dir, "native-transcript.css"), "utf8")

describe("first-class permission card", () => {
  test("the permission message has a dedicated renderer with direction, reason, and ceiling", () => {
    expect(source).toContain('props.message.type === "permission-changed"')
    expect(source).toContain('data-slot="native-permission-card"')
    expect(source).toContain('data-slot="native-permission-card-reason"')
    // The ceiling line is keyed, not spelled: `ui.transcript.permission.ceiling` carries the copy.
    expect(source).toContain('"ui.transcript.permission.ceiling"')
  })

  test("the card is styled as a visible transcript surface, not another tool body", () => {
    expect(css).toContain('[data-slot="native-permission-card"]')
    expect(css).toContain('[data-slot="native-permission-card-reason"]')
  })
})
