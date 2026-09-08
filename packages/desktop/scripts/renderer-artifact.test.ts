import { describe, expect, test } from "bun:test"
import { checkRendererI18n, i18nKeys } from "./renderer-artifact"

describe("packaged renderer content guard", () => {
  test("extracts dictionary keys and rejects a missing emitted key", () => {
    const source = `export const dict = {\n  "files.title": "Files",\n  "files.retry": "Retry",\n}`
    expect(i18nKeys(source)).toEqual(["files.retry", "files.title"])
    expect(checkRendererI18n([source], `...files.title...`)).toEqual({
      expected: 2,
      missing: ["files.retry"],
      controlKey: "files.title",
      controlPresent: true,
    })
  })

  test("the control key makes an empty or unreadable bundle fail visibly", () => {
    const result = checkRendererI18n(['"files.title": "Files"'], "")
    expect(result.expected).toBe(1)
    expect(result.controlPresent).toBe(false)
    expect(result.missing).toEqual(["files.title"])
  })
})
