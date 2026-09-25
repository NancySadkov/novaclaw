import { describe, expect, it } from "bun:test"
import { EndpointURL } from "@novaclaw/core/config/endpoint-url"

// The lay-user URL table. Every row here is something a person actually types into "server address",
// and every expectation is the address the probe is allowed to try — not a claim that anything is
// listening there. The competing-harness caveats this defends are named in `endpoint-url.ts`.

const canonicalOf = (raw: string) => EndpointURL.canonical(raw)
const candidatesOf = (raw: string) => [...EndpointURL.candidates(raw)]

describe("EndpointURL — the lay-user shapes", () => {
  it("adds a scheme and the `/v1/` the user left off", () => {
    expect(canonicalOf("example.com/path/")).toBe("https://example.com/path/v1/")
    expect(canonicalOf("https://example.com/path/")).toBe("https://example.com/path/v1/")
    expect(canonicalOf("example.com")).toBe("https://example.com/v1/")
    expect(canonicalOf("https://api.deepseek.com")).toBe("https://api.deepseek.com/v1/")
  })

  it("recovers the base from a pasted completion endpoint", () => {
    for (const raw of [
      "https://example.com/path/v1/completions",
      "https://example.com/path/v1/chat/completions",
      "example.com/path/v1/vectorize/upsert",
      "https://example.com/path/v1/models",
      "https://example.com/path/v1/embeddings",
      "https://example.com/path/v1/rerank",
    ])
      expect(canonicalOf(raw), raw).toBe("https://example.com/path/v1/")
  })

  it("tries the conventional base first and the version-less root second", () => {
    expect(candidatesOf("example.com/path/")).toEqual(["https://example.com/path/v1/", "https://example.com/path/"])
    expect(candidatesOf("https://example.com/path/v1/chat/completions")).toEqual([
      "https://example.com/path/v1/",
      "https://example.com/path/",
    ])
    // A URL that already IS the conventional base has no second guess to make.
    expect(candidatesOf("https://example.com/path/v1/")).toEqual([
      "https://example.com/path/v1/",
      "https://example.com/path/",
    ])
  })

  it("defaults loopback and LAN names to http, the WAN to https", () => {
    expect(canonicalOf("localhost:8000")).toBe("http://localhost:8000/v1/")
    expect(canonicalOf("127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/v1/")
    expect(canonicalOf("192.168.178.40:8010/v1")).toBe("http://192.168.178.40:8010/v1/")
    expect(canonicalOf("192.168.178.40:8010")).toBe("http://192.168.178.40:8010/v1/")
    expect(canonicalOf("example.com")).toBe("https://example.com/v1/")
    expect(canonicalOf("https://example.com")).toBe("https://example.com/v1/")
  })
})

describe("EndpointURL — the caveats the competitors taught us", () => {
  it("never appends `/v1` beside an existing version segment, mount prefix or not", () => {
    // The redpanda lesson: DeepInfra is `/v1/openai`, Google is `/v1beta/openai`.
    expect(canonicalOf("https://api.deepinfra.com/v1/openai")).toBe("https://api.deepinfra.com/v1/openai/")
    expect(canonicalOf("https://generativelanguage.googleapis.com/v1beta/openai")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/",
    )
    expect(canonicalOf("https://api.deepseek.com/v1")).toBe("https://api.deepseek.com/v1/")
    expect(canonicalOf("http://host/api/v2")).toBe("http://host/api/v2/")
  })

  it("never truncates past a version marker into a deeper gateway path", () => {
    // The LibreChat lesson: `extractBaseURL` shortened this and 404'd. It is one candidate, untouched.
    expect(canonicalOf("https://gateway.ai.cloudflare.com/v1/acc/gw/compat")).toBe(
      "https://gateway.ai.cloudflare.com/v1/acc/gw/compat/",
    )
    expect(candidatesOf("https://gateway.ai.cloudflare.com/v1/acc/gw/compat")).toEqual([
      "https://gateway.ai.cloudflare.com/v1/acc/gw/compat/",
    ])
  })

  it("strips `chat/completions` whole, not just the trailing `completions`", () => {
    // The OpenClaw bug: a naive strip leaves `…/chat`, then appends `/v1` and doubles the path.
    expect(canonicalOf("https://host/chat/completions")).toBe("https://host/v1/")
    expect(canonicalOf("https://host/completions")).toBe("https://host/v1/")
  })

  it("keeps a mount path in front of the version", () => {
    expect(canonicalOf("https://gw.example.com/litellm/v1")).toBe("https://gw.example.com/litellm/v1/")
    expect(canonicalOf("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api/v1/")
    expect(canonicalOf("http://host/openai")).toBe("http://host/openai/v1/")
  })

  it("keeps a version in a non-terminal position and still offers a version-less guess only when sane", () => {
    expect(candidatesOf("https://api.deepinfra.com/v1/openai")).toEqual(["https://api.deepinfra.com/v1/openai/"])
    expect(candidatesOf("https://openrouter.ai/api/v1")).toEqual([
      "https://openrouter.ai/api/v1/",
      "https://openrouter.ai/api/",
    ])
  })
})

describe("EndpointURL — stripped (the conservative fix for an unprobed address)", () => {
  it("completes the scheme and strips an operation, but never forces `/v1`", () => {
    expect(EndpointURL.stripped("example.com/path/")).toBe("https://example.com/path/")
    expect(EndpointURL.stripped("https://example.com/path/v1/chat/completions")).toBe("https://example.com/path/v1/")
    expect(EndpointURL.stripped("https://host/v1/vectorize/upsert")).toBe("https://host/v1/")
    expect(EndpointURL.stripped("localhost:8000")).toBe("http://localhost:8000/")
  })

  it("preserves a nonstandard mount that appending `/v1` would break", () => {
    expect(EndpointURL.stripped("https://host/openai")).toBe("https://host/openai/")
    expect(EndpointURL.stripped("https://gateway.ai.cloudflare.com/v1/acc/gw/compat")).toBe(
      "https://gateway.ai.cloudflare.com/v1/acc/gw/compat/",
    )
    // …while the probing canonical DOES add the convention. The two differ on purpose.
    expect(EndpointURL.canonical("https://host/openai")).toBe("https://host/openai/v1/")
  })

  it("returns nothing for an unreadable address", () => {
    expect(EndpointURL.stripped("not a url")).toBeUndefined()
  })
})

describe("EndpointURL — refusals stay refusals", () => {
  it("returns nothing for an empty or unreadable address rather than inventing one", () => {
    expect(candidatesOf("")).toEqual([])
    expect(canonicalOf("   ")).toBeUndefined()
    expect(candidatesOf("not a url")).toEqual([])
    expect(candidatesOf("ftp://host/v1")).toEqual([])
    expect(candidatesOf("mailto:user@example.com")).toEqual([])
  })
})

describe("EndpointURL — modelListCount", () => {
  it("separates a real OpenAI model list from any other 200 body", () => {
    expect(EndpointURL.modelListCount({ data: [{ id: "qwen3" }, { id: "gemma" }] })).toBe(2)
    // A list that lists nothing is still a list — but 0 is not evidence of an access point.
    expect(EndpointURL.modelListCount({ data: [] })).toBe(0)
    expect(EndpointURL.modelListCount({ data: [{ id: "" }, { notAnId: 1 }] })).toBe(0)
    // Not a list at all: HTML, an error envelope, a proxy page.
    expect(EndpointURL.modelListCount(undefined)).toBe(-1)
    expect(EndpointURL.modelListCount("<html>hello</html>")).toBe(-1)
    expect(EndpointURL.modelListCount({ error: "not found" })).toBe(-1)
    expect(EndpointURL.modelListCount({ data: "nope" })).toBe(-1)
  })
})
