import { describe, expect, test } from "bun:test"
import { ProviderSession } from "@novaclaw/core/session/runner/provider-session"

/**
 * Measured contract from `doc/oc-session.md`: OpenCode Go rejects every inference request without a
 * session identity header (`400 MissingSessionID`). These pin the scoping and value rules the fix
 * depends on, so a future edit cannot quietly send the header everywhere or send a value the gateway
 * trims away.
 */
describe("ProviderSession", () => {
  test("isOpenCodeGo matches the Go gateway and nothing else", () => {
    expect(ProviderSession.isOpenCodeGo("https://opencode.ai/zen/go/v1")).toBe(true)
    expect(ProviderSession.isOpenCodeGo("https://opencode.ai/zen/go")).toBe(true)
    expect(ProviderSession.isOpenCodeGo("https://opencode.ai/zen/go/v1/")).toBe(true)
    // The plain Zen endpoint and every other provider must stay untouched.
    expect(ProviderSession.isOpenCodeGo("https://opencode.ai/zen/v1")).toBe(false)
    expect(ProviderSession.isOpenCodeGo("https://api.deepseek.com/v1")).toBe(false)
    expect(ProviderSession.isOpenCodeGo("https://openai.example/v1")).toBe(false)
    expect(ProviderSession.isOpenCodeGo("http://127.0.0.1:8000/v1")).toBe(false)
    // A malformed URL is "not Go", never a thrown turn.
    expect(ProviderSession.isOpenCodeGo("not a url")).toBe(false)
    expect(ProviderSession.isOpenCodeGo(undefined)).toBe(false)
  })

  test("carries the conversation id and a named User-Agent on Go routes", () => {
    const headers = ProviderSession.headersFor({
      url: "https://opencode.ai/zen/go/v1",
      sessionID: "ses_abc123",
    })
    expect(headers?.[ProviderSession.OPENCODE_SESSION_HEADER]).toBe("ses_abc123")
    expect(headers?.["user-agent"]).toMatch(/^novaclaw\//)
  })

  test("emits nothing for an endpoint that does not need it", () => {
    expect(ProviderSession.headersFor({ url: "https://api.deepseek.com/v1", sessionID: "ses_abc123" })).toBeUndefined()
    expect(ProviderSession.headersFor({ url: undefined, sessionID: "ses_abc123" })).toBeUndefined()
  })

  test("an empty or whitespace id is absent, so it falls back rather than being trimmed to nothing", () => {
    const empty = ProviderSession.headersFor({ url: "https://opencode.ai/zen/go/v1", sessionID: "" })
    expect(empty?.[ProviderSession.OPENCODE_SESSION_HEADER]).toBe(ProviderSession.SESSIONLESS_ID)
    const blank = ProviderSession.headersFor({ url: "https://opencode.ai/zen/go/v1", sessionID: "   " })
    expect(blank?.[ProviderSession.OPENCODE_SESSION_HEADER]).toBe(ProviderSession.SESSIONLESS_ID)
    const missing = ProviderSession.headersFor({ url: "https://opencode.ai/zen/go/v1", sessionID: undefined })
    expect(missing?.[ProviderSession.OPENCODE_SESSION_HEADER]).toBe(ProviderSession.SESSIONLESS_ID)
  })

  test("truncates to the gateway's 256-byte ceiling", () => {
    const long = "s".repeat(300)
    const headers = ProviderSession.headersFor({ url: "https://opencode.ai/zen/go/v1", sessionID: long })
    const value = headers?.[ProviderSession.OPENCODE_SESSION_HEADER] ?? ""
    expect(new TextEncoder().encode(value).byteLength).toBe(256)
  })
})
