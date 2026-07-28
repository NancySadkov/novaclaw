import { describe, expect, test } from "bun:test"
import { publicAssetUrl } from "./public-asset"

// The three shapes this has to survive, all of which exist in production today:
//   · dev / web served at the origin root
//   · the remote-access surface, which serves under `/server/{base64(url)}/session/{id}`
//   · the packaged Electron renderer, which loads over a custom `nc://` protocol
describe("publicAssetUrl", () => {
  test("resolves against the origin root when the app is served at /", () => {
    expect(publicAssetUrl("/logo.png", "/", "https://app.example/")).toBe("https://app.example/logo.png")
  })

  test("resolves under a path prefix — the bug: an origin-rooted src points at nothing there", () => {
    const under = publicAssetUrl("/logo.png", "/server/aHR0cA/session/ses_1/", "https://app.example/")
    expect(under).toBe("https://app.example/server/aHR0cA/session/ses_1/logo.png")
    // Negative control: the literal the call sites used before this helper existed.
    expect(under).not.toBe(new URL("/logo.png", "https://app.example/").href)
  })

  test("resolves under a custom protocol (the packaged renderer)", () => {
    expect(publicAssetUrl("/logo.png", "./", "nc://renderer/index.html")).toBe("nc://renderer/logo.png")
  })

  test("a leading slash is not required, and repeated slashes do not escape the base", () => {
    expect(publicAssetUrl("logo.png", "/base/", "https://app.example/")).toBe("https://app.example/base/logo.png")
    expect(publicAssetUrl("///logo.png", "/base/", "https://app.example/")).toBe("https://app.example/base/logo.png")
  })
})
