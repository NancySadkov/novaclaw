import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { SessionExtract } from "@novaclaw/core/session/runner/extract"
import type { SessionMessage } from "@novaclaw/core/session/message"
import type { SessionType } from "@novaclaw/schema/session-type"

const user = (text: string): SessionMessage.Message => ({ type: "user", text }) as unknown as SessionMessage.Message
const assistant = (...texts: string[]): SessionMessage.Message =>
  ({ type: "assistant", content: texts.map((text) => ({ type: "text", text })) }) as unknown as SessionMessage.Message

describe("SessionExtract.buildExchange", () => {
  test("serializes only the latest real user message", () => {
    const ex = SessionExtract.buildExchange([
      user("old"),
      assistant("old reply"),
      user("my name is Nadia"),
      assistant("Nice to", " meet you"),
    ])
    expect(ex).toBe("User: my name is Nadia")
  })
  test("no assistant reply yet → just the user line; no user → undefined", () => {
    expect(SessionExtract.buildExchange([user("hi there")])).toBe("User: hi there")
    expect(SessionExtract.buildExchange([assistant("hello")])).toBeUndefined()
    expect(SessionExtract.buildExchange([])).toBeUndefined()
  })
})

describe("SessionExtract durable-memory origin policy", () => {
  const expected = {
    interactive: true,
    "sub-agent": false,
    "auto-prompting": false,
    "goal-oriented": false,
  } as const satisfies Record<SessionType.Info, boolean>

  test("permits only interactive sessions; every unattended kind produces zero candidates", () => {
    for (const [type, allowed] of Object.entries(expected) as Array<[SessionType.Info, boolean]>) {
      expect(SessionExtract.allowsDurableMemory(type), type).toBe(allowed)
    }
  })

  test("memory-influenced assistant output is structurally absent from extraction input", () => {
    const recalled = "The recalled preference is purple"
    const exchange = SessionExtract.buildExchange([user("What do I prefer?"), assistant(recalled)])
    expect(exchange).toBe("User: What do I prefer?")
    expect(exchange).not.toContain(recalled)
  })

  // 🔴 WHERE an automatically-extracted fact is FILED, pinned at the site because the scope is one
  // string in a 400-line function and nothing observable distinguishes the two answers until the
  // user clears the chat — at which point everything the colleague learned without being asked is
  // gone, while its brief and its explicit memories survive.
  test("extraction files facts in the OFFICER's cabinet, not this chat's drawer", () => {
    const source = readFileSync(path.join(import.meta.dir, "../src/session/runner/maintenance.ts"), "utf8")
    const start = source.indexOf('const extractMemory = Effect.fn("SessionMaintenance.extractMemory")')
    const end = source.indexOf("const refreshChangesSummary", start)
    expect(start).toBeGreaterThan(0)
    const body = source
      .slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
    // ONE rule, shared with the read side — not a second copy of the fallback.
    expect(body).toContain("SessionRecall.rememberScope(")
    // …and never the hardcoded session scope this replaced.
    expect(body).not.toMatch(/scope = `session:\$\{sessionID\}`/)
  })

  test("the runner applies kind and per-chat gates before touching memory or model work", () => {
    // The pass moved out of the runner's 2 900-line closure into the `SessionMaintenance` service
    // (5.1). A SOURCE-scanning guard's site is invisible to behaviour, so it has to follow the code
    // it guards — the two `toBeGreaterThan(0)` assertions below are what stop it from silently
    // becoming a scan of an empty string.
    const source = readFileSync(path.join(import.meta.dir, "../src/session/runner/maintenance.ts"), "utf8")
    const start = source.indexOf('const extractMemory = Effect.fn("SessionMaintenance.extractMemory")')
    const end = source.indexOf("const refreshChangesSummary", start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const body = source.slice(start, end)
    const gate = body.indexOf("SessionExtract.allowsDurableMemory(config.type)")
    // ⚠️ The per-chat gate lost its `&& MemorySetting.memoryEnabled()` on 2026-08-13, and that is a
    // STRENGTHENING rather than a removal: the instance ceiling is applied when the config resolves
    // (`session/effective-config.ts`), so `config.memory` already carries it and a reader cannot be
    // off by omission. What this ledger now pins is that the gate still runs, and still runs BEFORE
    // any engine or model work.
    const chatGate = body.indexOf('!stanceOf("memory", config.memory)')
    expect(gate).toBeGreaterThan(0)
    expect(chatGate).toBeGreaterThan(gate)
    expect(chatGate).toBeLessThan(body.indexOf("memory.health()"))
    expect(chatGate).toBeLessThan(body.indexOf(".stream("))
    expect(gate).toBeLessThan(body.indexOf("memory.health()"))
    expect(gate).toBeLessThan(body.indexOf(".stream("))
    // Resolved through the ONE entry point, which is where the folder layer and the ceiling are
    // applied — a bare chain walk here would see neither.
    expect(body).toContain("effective.resolve(session.id)")
  })

  test("both decode stages enter the interactive-idle scheduler tier", () => {
    const source = readFileSync(path.join(import.meta.dir, "../src/session/runner/maintenance.ts"), "utf8")
    const start = source.indexOf('const extractMemory = Effect.fn("SessionMaintenance.extractMemory")')
    const end = source.indexOf("const refreshChangesSummary", start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const body = source
      .slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
    // Stage 1 extracts facts; stage 2 links them. Embedding and database writes stay outside the
    // lease because they are not decode-shaped and should not occupy scarce generation capacity.
    expect(body.match(/SessionScheduler\.runMaintenance\(/g)).toHaveLength(2)
    expect(body).toContain('maintenanceInput(sessionID, "memory-extract", device)')
    expect(body).toContain('maintenanceInput(sessionID, "memory-link", device)')
    expect(body.match(/\bllm\s*\.stream\(/g)).toHaveLength(2)
  })

  test("the provider runner gates recall before embedding, search, or reranking", () => {
    const source = readFileSync(path.join(import.meta.dir, "../src/session/runner/llm.ts"), "utf8")
    const gate = source.indexOf("recallQuery !== undefined &&")
    const shortChatGate = source.indexOf("!ShortChat.enabled(config.shortChat)", gate)
    const memoryGate = source.indexOf('stanceOf("memory", config.memory)', gate)
    expect(gate).toBeGreaterThan(0)
    expect(shortChatGate).toBeGreaterThan(gate)
    expect(memoryGate).toBeGreaterThan(shortChatGate)
    expect(gate).toBeLessThan(source.indexOf("KbEmbedder.embedOne(recallQuery)", gate))
    expect(gate).toBeLessThan(source.indexOf(".search({", gate))
    expect(gate).toBeLessThan(source.indexOf("MemoryRerank.buildRerankPrompt", gate))
  })
})

describe("SessionExtract.parseExtraction", () => {
  test("parses a plain JSON array of {name,text}", () => {
    const out = SessionExtract.parseExtraction(
      '[{"name":"Nadia","text":"The user is named Nadia"},{"text":"Prefers dark mode"}]',
    )
    expect(out).toEqual([{ name: "Nadia", text: "The user is named Nadia" }, { text: "Prefers dark mode" }])
  })
  test("tolerates code fences + surrounding prose", () => {
    const out = SessionExtract.parseExtraction('Here you go:\n```json\n[{"text":"Deadline is March 15"}]\n```\nDone.')
    expect(out).toEqual([{ text: "Deadline is March 15" }])
  })
  test("drops malformed/empty entries, dedups, and never throws", () => {
    expect(SessionExtract.parseExtraction("not json at all")).toEqual([])
    expect(SessionExtract.parseExtraction("[]")).toEqual([])
    expect(
      SessionExtract.parseExtraction('[{"text":"same"},{"text":"SAME"},{"nope":1},{"text":"  "},{"text":"kept"}]'),
    ).toEqual([{ text: "same" }, { text: "kept" }])
  })
  test("caps to max", () => {
    const many = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ text: `fact ${i}` })))
    expect(SessionExtract.parseExtraction(many, 3)).toHaveLength(3)
  })
})

describe("SessionExtract.buildLinkPrompt", () => {
  test("appends the closed SUBJECTS list to the exchange", () => {
    expect(SessionExtract.buildLinkPrompt("User: hi", ["Acme", "Berlin"])).toBe(
      "User: hi\n\nSUBJECTS:\n- Acme\n- Berlin",
    )
  })
})

describe("SessionExtract.parseLinks", () => {
  const names = ["Nancy", "Acme Robotics", "Berlin"]

  test("resolves endpoints to CANONICAL list names and normalizes the type", () => {
    const out = SessionExtract.parseLinks('[{"from":"nancy","to":"Acme","type":"works at"}]', names)
    expect(out).toEqual([{ from: "Nancy", to: "Acme Robotics", type: "works_at" }])
  })

  // The dangling guard — the whole reason stage 2 gets a CLOSED list. An off-list endpoint (the
  // measured one-stage failure: "billing_service_owner") must never become an edge.
  test("DROPS links with an off-list endpoint rather than writing a dangling edge", () => {
    expect(SessionExtract.parseLinks('[{"from":"Nancy","to":"Sofia\'s Role","type":"knows"}]', names)).toEqual([])
    expect(SessionExtract.parseLinks('[{"from":"Nobody","to":"Nowhere","type":"x"}]', names)).toEqual([])
  })

  test("drops self-links and duplicate pairs", () => {
    expect(SessionExtract.parseLinks('[{"from":"Nancy","to":"Nancy","type":"is"}]', names)).toEqual([])
    const dup = SessionExtract.parseLinks(
      '[{"from":"Nancy","to":"Berlin","type":"lives_in"},{"from":"nancy","to":"berlin","type":"resides_in"}]',
      names,
    )
    expect(dup).toHaveLength(1)
  })

  test("a bad or missing type falls back to related_to — a good pair is never lost to a bad label", () => {
    expect(SessionExtract.parseLinks('[{"from":"Nancy","to":"Berlin"}]', names)[0]?.type).toBe("related_to")
    expect(SessionExtract.parseLinks('[{"from":"Nancy","to":"Berlin","type":"!!!"}]', names)[0]?.type).toBe(
      "related_to",
    )
  })

  test("tolerates fences/prose, never throws, and needs ≥2 names to link anything", () => {
    expect(SessionExtract.parseLinks('```json\n[{"from":"Nancy","to":"Berlin","type":"in"}]\n```', names)).toHaveLength(
      1,
    )
    expect(SessionExtract.parseLinks("not json", names)).toEqual([])
    expect(SessionExtract.parseLinks("[]", names)).toEqual([])
    expect(SessionExtract.parseLinks('[{"from":"Nancy","to":"Berlin","type":"in"}]', ["Nancy"])).toEqual([])
  })

  test("caps to max", () => {
    const many = JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ from: "Nancy", to: `T${i}`, type: "t" })))
    expect(
      SessionExtract.parseLinks(many, ["Nancy", ...Array.from({ length: 30 }, (_, i) => `T${i}`)], 5),
    ).toHaveLength(5)
  })
})

describe("SessionExtract.memoryID", () => {
  test("deterministic + idempotent: same scope+text → same id, case/space-insensitive", () => {
    const a = SessionExtract.memoryID("session:x", "The user is named Nadia")
    expect(a).toBe(SessionExtract.memoryID("session:x", "  the user is named nadia  "))
    expect(a).toMatch(/^mem_x[0-9a-f]{24}$/)
    expect(a).not.toBe(SessionExtract.memoryID("global", "The user is named Nadia")) // scope matters
    expect(a).not.toBe(SessionExtract.memoryID("session:x", "different fact"))
  })
})

describe("SessionExtract.entityID — the cross-turn reconciliation key", () => {
  /**
   * The defect this closes, measured on a real store 2026-08-12: **280 nodes, 22 edges, 1 entity**.
   * Every node was keyed on a fact's TEXT, so the same subject mentioned in two turns became two
   * unrelated nodes and nothing could ever join them. The graph was islands by construction.
   */
  test("the same name in different turns is ONE node, while its facts stay distinct", () => {
    const turn2 = "The user is migrating the auth service to TypeScript"
    const turn40 = "TypeScript strict mode is enabled across the repo"

    // The facts are different memories — they must NOT collapse.
    expect(SessionExtract.memoryID("global", turn2)).not.toBe(SessionExtract.memoryID("global", turn40))

    // ...but both are ABOUT the same thing, and that thing is a single node. This is the whole fix:
    // two episodes forty turns apart are now two hops from each other instead of unreachable.
    expect(SessionExtract.entityID("global", "TypeScript")).toBe(SessionExtract.entityID("global", "TypeScript"))
  })

  test("reconciles across casing and surrounding whitespace", () => {
    const canonical = SessionExtract.entityID("global", "Acme Robotics")
    expect(SessionExtract.entityID("global", "acme robotics")).toBe(canonical)
    expect(SessionExtract.entityID("global", "  ACME Robotics  ")).toBe(canonical)
  })

  test("does not reconcile across scopes, and cannot collide with a memory id", () => {
    expect(SessionExtract.entityID("session:x", "Berlin")).not.toBe(SessionExtract.entityID("global", "Berlin"))
    expect(SessionExtract.entityID("global", "Berlin")).toMatch(/^ent_x[0-9a-f]{24}$/)
    // Distinct namespaces: an entity and an episode whose text happens to equal the name are
    // different nodes, so one can never silently overwrite the other.
    expect(SessionExtract.entityID("global", "Berlin")).not.toBe(SessionExtract.memoryID("global", "Berlin"))
  })

  test("different names are different entities (negative control)", () => {
    expect(SessionExtract.entityID("global", "Mercury Project")).not.toBe(SessionExtract.entityID("global", "Mercury"))
  })
})

describe("the extraction write path builds a connected graph", () => {
  /**
   * A SOURCE ledger, because ORDER is the correctness property here and order is invisible to a
   * behavioural assertion about the finished store: entities must be written before the episodes
   * that link into them, or the edge has no endpoint. Scoped to `extractMemory`'s body — a
   * whole-file scan would match these symbols in comments elsewhere and pass vacuously.
   */
  const body = () => {
    const source = readFileSync(path.join(import.meta.dir, "../src/session/runner/maintenance.ts"), "utf8")
    const start = source.indexOf('const extractMemory = Effect.fn("SessionMaintenance.extractMemory")')
    const end = source.indexOf("const refreshChangesSummary", start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    return source.slice(start, end)
  }

  test("entities are written BEFORE the episodes that link into them", () => {
    const source = body()
    const entity = source.indexOf('kind: "entity"')
    const episode = source.indexOf('kind: "episode"')
    expect(entity).toBeGreaterThan(0)
    expect(episode).toBeGreaterThan(entity)
  })

  test("every named episode gets a `mentions` edge to its entity", () => {
    const source = body()
    const edge = source.indexOf('type: "mentions"')
    expect(edge).toBeGreaterThan(source.indexOf('kind: "episode"'))
    // The edge must run episode -> entity. A reversed edge still "connects", which is why the
    // endpoints are pinned rather than merely counted.
    const region = source.slice(source.lastIndexOf("addEdge", edge), edge)
    expect(region).toContain("from: SessionExtract.memoryID(scope, fact.text)")
    expect(region).toContain("to: SessionExtract.entityID(scope, fact.name)")
  })

  test("extracted relations anchor on ENTITIES, never on the episode that phrased them", () => {
    const source = body()
    const links = source.indexOf("for (const link of links)")
    expect(links).toBeGreaterThan(0)
    const region = source.slice(links)
    expect(region).toContain("SessionExtract.entityID(scope, link.from)")
    expect(region).toContain("SessionExtract.entityID(scope, link.to)")
    // ⚠️ The regression this pins: binding an endpoint to the first episode carrying that name made
    // every relation an artefact of one turn's phrasing.
    expect(region).not.toContain("idByName")
  })
})
