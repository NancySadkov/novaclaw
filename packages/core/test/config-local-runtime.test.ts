import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { ConfigLocalRuntime } from "@novaclaw/core/config/local-runtime"
import { Offline } from "@novaclaw/core/offline"

// S0 — the local-runtime probe (`todo/sidecar-inference.md` → *Slice 0*). Ruling 1: every invariant
// below ships a mechanical check, and each one is negative-controllable by hand (flip the assertion's
// subject in `local-runtime.ts` and exactly one test here goes red).
//
// The three that matter most, and why they are not obvious:
//
//   · RULING 2 — a fault is never described falsely. The shipped probe handler
//     (`packages/novaclaw/.../handlers/provider.ts`) classifies ANY 200 as `ok`: it calls
//     `response.json()`, swallows the parse failure, and falls through to `models: []`. So a random
//     web server on `:8000` answers `{status:"ok", models:[]}`. A sweep that trusted `status` would
//     announce it as a found model runtime. `classify` checks the SHAPE.
//   · A probe that COULD NOT RUN must not report "none found". `ran: false` is a third state.
//   · LOOPBACK ONLY. The candidate list must never grow a LAN address, and `sweep` must refuse one
//     without opening a socket. This box has a real vLLM at 192.168.178.40:8000, which makes that a
//     live negative control rather than a hypothetical one.
//
// ⚠️ NO REAL NETWORK. `sweep` takes its probe as an argument; the suite additionally replaces
// `globalThis.fetch` with a throwing stub, so a future edit that reaches for the network inside this
// module fails here instead of turning the core suite flaky (or making it egress).

const {
  CANDIDATES,
  classify,
  classifyFailure,
  sweep,
  isLoopbackURL,
  sameEndpoint,
  excludeConfigured,
  uniqueProviderID,
} = ConfigLocalRuntime

const candidate = (over: Partial<ConfigLocalRuntime.Candidate> = {}): ConfigLocalRuntime.Candidate => ({
  id: "test",
  label: "Test",
  usually: "Test",
  port: 9999,
  baseURL: "http://localhost:9999/v1",
  ...over,
})

describe("ConfigLocalRuntime — the candidate list", () => {
  it("covers exactly the four roadmap ports, each a parseable loopback /v1 URL", () => {
    expect(CANDIDATES.map((c) => c.port).sort((a, b) => a - b)).toEqual([1234, 8000, 8080, 11434])
    for (const c of CANDIDATES) {
      const url = new URL(c.baseURL)
      expect(url.pathname).toBe("/v1")
      expect(Number(url.port)).toBe(c.port)
      expect(isLoopbackURL(c.baseURL)).toBe(true)
      // The id becomes a provider id on adoption — `dialog-new-model.tsx`'s PROVIDER_ID gate.
      expect(c.id).toMatch(/^[a-z0-9][a-z0-9-_]*$/)
      expect(c.label.length).toBeGreaterThan(0)
      expect(c.usually.length).toBeGreaterThan(0)
    }
    expect(new Set(CANDIDATES.map((c) => c.id)).size).toBe(CANDIDATES.length)
    expect(new Set(CANDIDATES.map((c) => c.port)).size).toBe(CANDIDATES.length)
  })

  it("is a probe list, not a provider catalogue: no key URL, no vendor API channel, no hosted host", () => {
    // *no-affiliated-provider-bloat* stated mechanically. A candidate carries a port and a label and
    // nothing that could make it a branded preset; the only reachable hosts are loopback.
    for (const c of CANDIDATES) {
      expect(Object.keys(c).sort()).toEqual(["baseURL", "id", "label", "port", "usually"])
      expect(new URL(c.baseURL).protocol).toBe("http:")
    }
  })
})

describe("ConfigLocalRuntime — loopback, and the offline policy", () => {
  it("`isLoopbackURL` agrees with the offline policy's own `isLoopbackHost`", () => {
    // The predicate is duplicated (offline.ts cannot be imported into the browser bundle — it pulls
    // fs/path/effect/sqlite). This is the drift guard that makes the duplication safe.
    const hosts = [
      "localhost",
      "LOCALHOST",
      "127.0.0.1",
      "127.9.9.9",
      "::1",
      "0.0.0.0",
      "192.168.178.40",
      "example.com",
      "localhost.evil.com",
    ]
    for (const host of hosts) {
      const url = host === "::1" ? `http://[${host}]:8000/v1` : `http://${host}:8000/v1`
      expect(isLoopbackURL(url), host).toBe(Offline.isLoopbackHost(host))
    }
    expect(isLoopbackURL("not a url")).toBe(false)
  })

  it("an ENABLED offline policy with an empty allowlist still permits every candidate", () => {
    // 🔴 The sweep rides the Offline policy, and the policy's answer is YES: `checkUrl` allows
    // loopback unconditionally ("the app talking to itself is not egress; the airgap threat model is
    // the WAN"). So airgap must NOT suppress this sweep — an airgapped user is exactly the one whose
    // only possible model is a local one. This asserts the verdict rather than restating the rule.
    const airgapped: Offline.Policy = { enabled: true, allowedHosts: new Set() }
    for (const c of CANDIDATES) expect(Offline.checkUrl(c.baseURL, airgapped).allowed, c.baseURL).toBe(true)
    // …and the same policy blocks the LAN vLLM this machine really runs, which is what makes the
    // loopback-only rule a rule rather than a preference.
    const lan = Offline.checkUrl("http://192.168.178.40:8000/v1/models", airgapped)
    expect(lan.allowed).toBe(false)
  })
})

describe("ConfigLocalRuntime — classify", () => {
  it("a model list with at least one id is the ONLY thing that claims a runtime", () => {
    const out = classify(candidate(), {
      status: "ok",
      models: ["qwen3", "gemma"],
      limits: { qwen3: { context: 65_536, output: 16_384 } },
      latencyMs: 12,
    })
    expect(out.kind).toBe("found")
    if (out.kind === "found") expect(out.limits?.qwen3).toEqual({ context: 65_536, output: 16_384 })
    expect(out.kind === "found" && out.models).toEqual(["qwen3", "gemma"])
    expect(out.kind === "found" && out.latencyMs).toBe(12)
  })

  it("a 200 that lists nothing is UNIDENTIFIED, never found — the shipped probe's false `ok`", () => {
    // This is the exact body the handler produces for a non-model server: HTML on :8000, `.json()`
    // throws, `data` falls back to `[]`, status stays "ok".
    const out = classify(candidate({ port: 8000, baseURL: "http://localhost:8000/v1" }), { status: "ok", models: [] })
    expect(out.kind).toBe("unidentified")
    // A JSON API that is not a model server produces the same shape (no `data[].id`).
    expect(classify(candidate(), { status: "ok" }).kind).toBe("unidentified")
    // …and so does a list of empty strings, which no UI could show anyway.
    expect(classify(candidate(), { status: "ok", models: ["", ""] }).kind).toBe("unidentified")
  })

  it("a closed port is ABSENT, and 401/403 is NEEDS-KEY rather than found", () => {
    expect(classify(candidate(), { status: "unreachable", detail: "ECONNREFUSED" }).kind).toBe("absent")
    expect(classify(candidate(), { status: "error", detail: "HTTP 500" }).kind).toBe("absent")
    expect(classify(candidate(), { status: "no-url" }).kind).toBe("absent")
    const auth = classify(candidate(), { status: "auth", detail: "HTTP 401" })
    expect(auth.kind).toBe("needs-key")
    expect(auth.kind === "needs-key" && auth.detail).toBe("HTTP 401")
  })

  it("a thrown probe is UNKNOWN — we learned nothing, which is not the same as nothing being there", () => {
    const out = classifyFailure(candidate(), new Error("Failed to fetch"))
    expect(out.kind).toBe("unknown")
    expect(out.kind === "unknown" && out.detail).toBe("Failed to fetch")
  })
})

describe("ConfigLocalRuntime — sweep", () => {
  // Mechanically prove the module opens no socket of its own.
  const realFetch = globalThis.fetch
  beforeEach(() => {
    globalThis.fetch = (() => {
      throw new Error("local-runtime must not perform network I/O — the probe is injected")
    }) as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it("classifies every candidate and puts the found ones first", async () => {
    const answers: Record<number, ConfigLocalRuntime.ProbeLike> = {
      11434: { status: "unreachable" },
      1234: { status: "auth", detail: "HTTP 401" },
      8000: { status: "ok", models: [] },
      8080: { status: "ok", models: ["gemma-4-e4b"] },
    }
    const seen: number[] = []
    const result = await sweep({
      probe: async (c) => {
        seen.push(c.port)
        return answers[c.port]!
      },
    })
    expect(seen.sort((a, b) => a - b)).toEqual([1234, 8000, 8080, 11434])
    expect(result.outcomes.map((o) => `${o.candidate.port}:${o.kind}`).sort()).toEqual([
      "11434:absent",
      "1234:needs-key",
      "8000:unidentified",
      "8080:found",
    ])
    // `found` outranks `needs-key`: one click versus one click plus a key.
    expect(result.adoptable.map((o) => o.kind)).toEqual(["found", "needs-key"])
    expect(result.answered).toBe(4)
    expect(result.ran).toBe(true)
  })

  it("refuses a non-loopback candidate WITHOUT probing it", async () => {
    // Negative control with teeth: 192.168.178.40:8000 is a real, live, model-serving vLLM on this
    // network. It answers `/v1/models` with a model list. If the guard were absent this would come
    // back `found`; the LAN must stay unswept regardless.
    let calls = 0
    const result = await sweep({
      candidates: [candidate({ id: "lan", baseURL: "http://192.168.178.40:8000/v1", port: 8000 })],
      probe: async () => {
        calls++
        return { status: "ok", models: ["qwen3.6-35b"] }
      },
    })
    expect(calls).toBe(0)
    expect(result.outcomes[0]!.kind).toBe("not-loopback")
    expect(result.adoptable).toEqual([])
    expect(result.ran).toBe(false)
  })

  it("a sweep that could not run says so — it does NOT report 'none found'", async () => {
    const result = await sweep({ probe: async () => Promise.reject(new Error("instance unreachable")) })
    expect(result.outcomes.every((o) => o.kind === "unknown")).toBe(true)
    expect(result.answered).toBe(0)
    expect(result.ran).toBe(false)
    expect(result.adoptable).toEqual([])
  })

  it("one broken probe does not sink the sweep", async () => {
    const result = await sweep({
      probe: async (c) => {
        if (c.port === 11434) throw new Error("boom")
        return { status: "ok", models: [`m-${c.port}`] }
      },
    })
    expect(result.answered).toBe(3)
    expect(result.ran).toBe(true)
    expect(result.adoptable.length).toBe(3)
  })
})

describe("ConfigLocalRuntime — adoption helpers", () => {
  it("hides a candidate the instance already points at, trailing slash and case included", () => {
    const outcomes = CANDIDATES.map((c) => classify(c, { status: "ok", models: ["m"] }))
    const left = excludeConfigured(outcomes, ["HTTP://LOCALHOST:11434/v1/", "http://localhost:8080/v1"])
    expect(left.map((o) => o.candidate.port).sort((a, b) => a - b)).toEqual([1234, 8000])
    expect(sameEndpoint("http://localhost:1234/v1", "http://localhost:1234/v1/")).toBe(true)
    expect(sameEndpoint("http://localhost:1234/v1", "http://localhost:1235/v1")).toBe(false)
  })

  it("never silently repoints an existing provider id", () => {
    expect(uniqueProviderID("ollama", [])).toBe("ollama")
    expect(uniqueProviderID("ollama", ["ollama"])).toBe("ollama-2")
    expect(uniqueProviderID("ollama", ["ollama", "ollama-2"])).toBe("ollama-3")
  })

  it("the id it returns is NEVER one of the taken ones — a taken id would leak that provider's key", () => {
    // 🔴 This is a credential invariant, not a cosmetic one. The Add-models dialog probes UNDER the
    // id this returns, and `POST /provider/:providerID/probe` falls back to the saved provider's
    // `request.body.apiKey` when the payload has none — so returning a taken id would Bearer a paid
    // API's key at whatever program is listening on loopback :11434.
    const taken = ["ollama", ...Array.from({ length: 40 }, (_, n) => `ollama-${n + 2}`), "vllm", "llamacpp"]
    for (const base of CANDIDATES.map((c) => c.id)) {
      for (let depth = 0; depth <= taken.length; depth++)
        expect(taken.slice(0, depth)).not.toContain(uniqueProviderID(base, taken.slice(0, depth)))
    }
    // The result also has to survive the dialog's own PROVIDER_ID gate, or adoption fails at save.
    expect(uniqueProviderID("ollama", taken)).toMatch(/^[a-z0-9][a-z0-9-_]*$/)
  })
})
