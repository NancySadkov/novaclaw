import { describe, expect, test } from "bun:test"
import { resolveRendererDevUrl } from "./renderer-url"

describe("resolveRendererDevUrl", () => {
  test("a packaged build ignores an inherited dev-server URL", () => {
    // The attack shape: a foreign Electron shell exports ELECTRON_RENDERER_URL, launches NovaClaw,
    // and the packaged renderer loads THEIR server. Both the load path and the navigation allowlist
    // in windows.ts consult this.
    expect(resolveRendererDevUrl(true, "http://127.0.0.1:5173")).toBeUndefined()
    expect(resolveRendererDevUrl(true, "https://not-ours.example")).toBeUndefined()
  })

  test("dev still gets its renderer", () => {
    expect(resolveRendererDevUrl(false, "http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173")
  })

  test("absent is absent in both modes", () => {
    expect(resolveRendererDevUrl(false, undefined)).toBeUndefined()
    expect(resolveRendererDevUrl(true, undefined)).toBeUndefined()
  })
})
