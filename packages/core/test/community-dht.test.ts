import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Fiber, Layer } from "effect"
import { CommunityDht } from "@novaclaw/core/community/dht"
import { absent, peers, scripted } from "./fixture/dht-sidecar"

/**
 * Community — the DHT seam (`notes/spec/community-p2p.md`).
 *
 * 🔴 The case that matters most is the one that happens on nearly every machine: **the sidecar is
 * not there**. It is a Rust binary and the app builds without a cargo toolchain, so "no binary" is
 * the ORDINARY state, not a fault — and it must cost nothing beyond the peers it would have found.
 *
 * 🔴 The rest is about LIFETIME, because that is what a live run changed. The sidecar used to be
 * spawned per lookup and killed after, which meant every query in production ran against a
 * three-entry routing table and found nobody — green in every test, dead in the only configuration
 * that ships. These pin the properties that fix buys: one node reused, one announcement, a dead node
 * replaced, and two callers never reading each other's replies.
 *
 * ⚠️ None of them spawn the real sidecar. A test that needs a Rust toolchain to run is a test that
 * stops running.
 */

const run = <A>(effect: Effect.Effect<A, never, CommunityDht.Service>, options: CommunityDht.Options) =>
  Effect.runPromise(Effect.provide(effect, CommunityDht.layerWith(options)) as Effect.Effect<A>)

describe("CommunityDht.parse", () => {
  test("🔴 addresses that could not be dialled are dropped, not passed on", () => {
    /**
     * ⚠️ Validated HERE as well as in the sidecar. This data originated with strangers on a public
     * DHT and crossed a process boundary; a caller that trusted it would be trusting the weakest
     * link in the chain. Passing junk on would also push the decision about it to whoever dials next.
     */
    expect(CommunityDht.parse(JSON.stringify({ peers: ["1.2.3.4:4096", "not-an-address", "", 42] }))).toEqual([
      "1.2.3.4:4096",
    ])
    expect(CommunityDht.parse(JSON.stringify({ peers: ["evil.example:4096/../etc"] }))).toEqual([])
  })

  test("⚠️ malformed output is NO PEERS, never a throw", () => {
    // The sidecar is a separate process that could crash mid-line, be an old build, or be something
    // else entirely on a machine where the path was overridden.
    expect(CommunityDht.parse("not json at all")).toEqual([])
    expect(CommunityDht.parse("")).toEqual([])
    expect(CommunityDht.parse(JSON.stringify({ peers: "1.2.3.4:4096" }))).toEqual([])
    expect(CommunityDht.parse(JSON.stringify({ announced: true }))).toEqual([])
  })

  test("bounded, and duplicates collapse", () => {
    const many = Array.from({ length: 40 }, (_, index) => `10.0.0.${index}:4096`)
    expect(CommunityDht.parse(JSON.stringify({ peers: many })).length).toBe(CommunityDht.MAX_DHT_PEERS)
    expect(CommunityDht.parse(JSON.stringify({ peers: ["1.2.3.4:1", "1.2.3.4:1"] }))).toEqual(["1.2.3.4:1"])
  })
})

describe("reading the sidecar's output", () => {
  test("🔴 an unterminated flood is REFUSED rather than accumulated", () => {
    /**
     * 🔴 A ceiling of OUR OWN. The reader holds bytes until it sees a newline, so a child that
     * never sends one grows this process's memory for as long as it runs — and this file already
     * said the sidecar "could crash mid-line, be an old build, or be something else entirely on a
     * machine where the path was overridden" while reading its output without a limit.
     */
    const state = { buffer: "" }
    expect(CommunityDht.readLines(state, "x".repeat(1024))).toEqual([])
    expect(CommunityDht.readLines(state, "x".repeat(CommunityDht.MAX_REPLY_BYTES))).toBeUndefined()
  })

  test("⚠️ a long BURST of complete lines is not an overrun", () => {
    /**
     * The distinction that keeps the ceiling honest: what must be bounded is UNTERMINATED text, not
     * throughput. Checking before draining would refuse a peer-rich reply for being long.
     */
    const state = { buffer: "" }
    const NEWLINE = String.fromCharCode(10)
    // ⚠️ Deliberately larger than the ceiling: a burst that did not exceed it would prove nothing
    // about the difference between "long" and "unterminated".
    const many =
      Array.from({ length: 8_000 }, (_, index) => `{"line":${index},"pad":"xxxxxxxxxx"}`).join(NEWLINE) + NEWLINE
    expect(many.length).toBeGreaterThan(CommunityDht.MAX_REPLY_BYTES)
    const lines = CommunityDht.readLines(state, many)
    expect(lines?.length).toBe(8_000)
    expect(state.buffer, "nothing unterminated is left holding memory").toBe("")
  })

  test("lines split across chunks are reassembled", () => {
    // The ordinary case, and the reason the buffer exists at all: a reply can arrive in pieces.
    const state = { buffer: "" }
    expect(CommunityDht.readLines(state, '{"peers":')).toEqual([])
    expect(CommunityDht.readLines(state, '["1.2.3.4:1"]}' + String.fromCharCode(10))).toEqual([
      '{"peers":["1.2.3.4:1"]}',
    ])
  })
})

describe("CommunityDht.find", () => {
  test("🔴 a MISSING sidecar answers no peers — the ordinary case on most machines", async () => {
    const found = await run(
      Effect.gen(function* () {
        const dht = yield* CommunityDht.Service
        return yield* dht.find()
      }),
      { start: absent },
    )
    expect(found).toEqual([])
  })

  test("🔴 a HANGING sidecar does not hold discovery open, and is not kept", async () => {
    /**
     * ⚠️ The failure easiest to miss and worst to ship: a child that neither answers nor exits. The
     * caller is a user waiting on a button, and the design says an unreachable DHT costs freshness,
     * never the join.
     *
     * 🔴 And now that the node is LONG-LIVED, a silent one must be killed rather than kept — keeping
     * it would poison every later lookup with a process that never answers.
     */
    const sidecar = scripted([undefined])
    const started = Date.now()
    const found = await run(
      Effect.gen(function* () {
        const dht = yield* CommunityDht.Service
        return yield* dht.find()
      }),
      // A short budget, because what is under test is that the backstop FIRES — not how long the
      // production one is. The default is deliberately longer than any test should sit waiting.
      { start: sidecar.start, timeoutMs: 500 },
    )
    expect(found).toEqual([])
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(sidecar.state.stopped, "a wedged sidecar must be stopped, not kept for the next lookup").toBe(1)
  })

  test("peers the sidecar reports come back in the shape learnFrom consumes", async () => {
    const sidecar = scripted([peers(["203.0.113.9:4096", "peer.example:8443"])])
    const found = await run(
      Effect.gen(function* () {
        const dht = yield* CommunityDht.Service
        return yield* dht.find()
      }),
      { start: sidecar.start },
    )
    expect(found).toEqual(["203.0.113.9:4096", "peer.example:8443"])
  })

  test("🔴 the sidecar is started ONCE and reused across lookups", async () => {
    /**
     * The whole point of the rewrite. Measured live 2026-08-17: a per-lookup sidecar queries a
     * three-entry routing table and finds nobody, while a node that stays alive reaches ~150 entries
     * within a minute. A second `start` here would mean every lookup pays the cold table again.
     */
    const sidecar = scripted([peers(["1.1.1.1:4096"]), peers(["2.2.2.2:4096"])])
    const found = await run(
      Effect.gen(function* () {
        const dht = yield* CommunityDht.Service
        const first = yield* dht.find()
        const second = yield* dht.find()
        return [first, second]
      }),
      { start: sidecar.start },
    )
    expect(found).toEqual([["1.1.1.1:4096"], ["2.2.2.2:4096"]])
    expect(sidecar.state.starts, "the sidecar must be started once, not once per lookup").toBe(1)
  })

  test("🔴 nothing is started until the first lookup", async () => {
    // Startup speed is first-class and joining is a decision: a user who never opens the community
    // must never pay for a Kademlia node. Building the layer must therefore spawn NOTHING.
    const sidecar = scripted([peers([])])
    await Effect.runPromise(
      Effect.provide(Effect.void, CommunityDht.layerWith({ start: sidecar.start })) as Effect.Effect<void>,
    )
    expect(sidecar.state.starts, "building the layer must not spawn a DHT node").toBe(0)
  })

  test("🔴 announcing happens ONCE per living sidecar, not once per lookup", async () => {
    /**
     * kad republishes a provider record on its own schedule for as long as the node lives, so a
     * second announcement buys nothing. This is also the second reason the node wants to be
     * long-lived: a process that exits after one lookup can never republish anything.
     */
    const sidecar = scripted([JSON.stringify({ announced: true }), peers(["1.1.1.1:4096"]), peers(["1.1.1.1:4096"])])
    await run(
      Effect.gen(function* () {
        const dht = yield* CommunityDht.Service
        yield* dht.find({ announce: "203.0.113.9:4096" })
        yield* dht.find({ announce: "203.0.113.9:4096" })
      }),
      { start: sidecar.start },
    )
    const announces = sidecar.state.written.filter((line) => line.includes("announce"))
    expect(announces.length, "the same address must not be announced twice").toBe(1)
    expect(sidecar.state.written.filter((line) => line.includes('"find"')).length).toBe(2)
  })

  test("🔴 a MALFORMED announce address is never published, and does not cost the lookup", async () => {
    /**
     * The address is typed by a user, and the point of publishing is that strangers act on it. A
     * malformed one would still announce the room — the sidecar just fails to attach an address —
     * putting a record in the commons that names nobody.
     *
     * ⚠️ And the lookup still happens: a wrong setting must cost the advertisement, never the
     * discovery.
     */
    const sidecar = scripted([peers(["1.1.1.1:4096"])])
    const found = await run(
      Effect.gen(function* () {
        const dht = yield* CommunityDht.Service
        return yield* dht.find({ announce: "not an address" })
      }),
      { start: sidecar.start },
    )
    expect(found).toEqual(["1.1.1.1:4096"])
    expect(sidecar.state.written, "junk must not reach the commons").toEqual(['{"op":"find"}'])
  })

  test("⚠️ what counts as announceable", () => {
    expect(CommunityDht.isAnnounceable("203.0.113.9:4096")).toBe(true)
    expect(CommunityDht.isAnnounceable("nova.example.com:443")).toBe(true)
    expect(CommunityDht.isAnnounceable(" 203.0.113.9:4096 "), "a pasted address carries whitespace").toBe(true)
    expect(CommunityDht.isAnnounceable("203.0.113.9")).toBe(false)
    expect(CommunityDht.isAnnounceable("https://nova.example.com:443")).toBe(false)
    expect(CommunityDht.isAnnounceable("")).toBe(false)
  })

  test("⚠️ without an announce, nothing is advertised", async () => {
    // Announcing is only honest from somewhere reachable; a NAT'd instance publishing an address
    // nobody can dial is a promise it cannot keep, so looking must not imply advertising.
    const sidecar = scripted([peers([])])
    await run(
      Effect.gen(function* () {
        const dht = yield* CommunityDht.Service
        return yield* dht.find()
      }),
      { start: sidecar.start },
    )
    expect(sidecar.state.written).toEqual(['{"op":"find"}'])
  })

  test("🔴 a sidecar that DIES is replaced on the next lookup, and re-announces", async () => {
    /**
     * ⚠️ Long-lived is not immortal: the child can crash, be killed by the OS, or be an old build
     * that exits. A dead node that is never replaced turns one crash into a permanently silent DHT,
     * which looks exactly like a machine that never built the sidecar.
     */
    const sidecar = scripted([
      JSON.stringify({ announced: true }),
      peers(["1.1.1.1:4096"]),
      JSON.stringify({ announced: true }),
      peers(["2.2.2.2:4096"]),
    ])
    const found = await run(
      Effect.gen(function* () {
        const dht = yield* CommunityDht.Service
        const first = yield* dht.find({ announce: "203.0.113.9:4096" })
        yield* Effect.sync(() => sidecar.state.kill?.())
        const second = yield* dht.find({ announce: "203.0.113.9:4096" })
        return [first, second]
      }),
      { start: sidecar.start },
    )
    expect(found).toEqual([["1.1.1.1:4096"], ["2.2.2.2:4096"]])
    expect(sidecar.state.starts, "a dead sidecar must be replaced").toBe(2)
    const announces = sidecar.state.written.filter((line) => line.includes("announce"))
    expect(announces.length, "a REPLACED sidecar knows nothing — it must be told again").toBe(2)
  })

  test("🔴 two lookups at once do not read each other's replies", async () => {
    /**
     * The protocol is one reply per line with nothing tying a reply to its request, so overlapping
     * callers would swap answers. Harmless while the sidecar lived for exactly one call; a real
     * hazard now that it is shared.
     */
    const sidecar = scripted([peers(["1.1.1.1:4096"]), peers(["2.2.2.2:4096"])])
    const found = await run(
      Effect.gen(function* () {
        const dht = yield* CommunityDht.Service
        return yield* Effect.all([dht.find(), dht.find()], { concurrency: 2 })
      }),
      { start: sidecar.start },
    )
    expect(found.map((list) => [...list]).sort()).toEqual([["1.1.1.1:4096"], ["2.2.2.2:4096"]])
    expect(sidecar.state.starts).toBe(1)
  })

  test("🔴 closing the scope stops the sidecar", async () => {
    // A DHT node outliving the instance that wanted it is a background process nobody asked for,
    // holding connections nobody is using.
    const sidecar = scripted([peers([])])
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const dht = yield* CommunityDht.Service
          yield* dht.find()
        }),
        CommunityDht.layerWith({ start: sidecar.start }),
      ) as Effect.Effect<void>,
    )
    expect(sidecar.state.stopped, "the sidecar must not outlive the layer that started it").toBe(1)
  })
})

describe("an announcement is only claimed when it happened", () => {
  test("🔴 `announced: false` is NOT recorded as published, and is retried", async () => {
    /**
     * 🔴 The sidecar waits for a routing table worth publishing into and then for the query's own
     * result, so `false` is a real answer — it reports failure when there was no network to publish
     * to. This seam used to treat ANY reply as success, which meant the address was remembered, the
     * `advertise !== announced` guard was false ever after, and the failed announcement was never
     * tried again. The instance believed it was published for the rest of the session, and so did
     * its owner.
     */
    const sidecar = scripted([
      JSON.stringify({ announced: false }),
      peers([]),
      JSON.stringify({ announced: true }),
      peers([]),
    ])
    const state = await run(
      Effect.gen(function* () {
        const dht = yield* CommunityDht.Service
        yield* dht.find({ announce: "203.0.113.9:4096" })
        const failed = yield* dht.announced()
        yield* dht.find({ announce: "203.0.113.9:4096" })
        return { failed, then: yield* dht.announced() }
      }),
      { start: sidecar.start },
    )

    expect(state.failed?.published, "a refused announcement must not read as published").toBe(false)
    expect(state.then?.published, "and the next discovery must try again").toBe(true)
    const announces = sidecar.state.written.filter((line) => line.includes("announce"))
    expect(announces.length, "twice: the first failed, so it was not remembered").toBe(2)
  })

  test("⚠️ a CONFIRMED announcement is not repeated", () => {
    // The other half of the same rule: kad republishes on its own schedule for as long as the node
    // lives, so re-announcing an address it already took buys nothing.
    expect(CommunityDht.announcedOk(JSON.stringify({ announced: true }))).toBe(true)
    expect(CommunityDht.announcedOk(JSON.stringify({ announced: false }))).toBe(false)
    // ⚠️ Anything that is not an explicit `true` is a failure: a malformed line, an empty one, or a
    // reply from something that is not our sidecar at all.
    expect(CommunityDht.announcedOk("not json")).toBe(false)
    expect(CommunityDht.announcedOk(JSON.stringify({ peers: [] }))).toBe(false)
  })
})

describe("the layer", () => {
  test("⚠️ the default layer exists and needs nothing", () => {
    // It resolves the binary path lazily, so merely constructing it must not touch the filesystem
    // in a way that can fail on a machine with no sidecar.
    expect(Layer.isLayer(CommunityDht.layer)).toBe(true)
  })
})

/**
 * 🔴 Review finding 1.7 — the sidecar's LIFETIME against the user's settings, and its own stale
 * children.
 *
 * Three of the four defects that finding names are here (the fourth is packaging). Each is a case
 * where the node outlived the thing that authorised it, or where a dead node spoke for a live one.
 */
describe("the sidecar obeys the gate", () => {
  test("🔴 switching the community OFF withdraws and stops a living node", async () => {
    const sidecar = scripted([peers(["1.2.3.4:4096"]), JSON.stringify({ announced: false })])
    await run(
      Effect.gen(function* () {
        const dht = yield* CommunityDht.Service
        yield* dht.find()
        expect(sidecar.state.starts).toBe(1)

        // What a settings write does, through the same module-level seam `config-store-write` uses.
        yield* CommunityDht.reconcile({ participates: false })
        expect(sidecar.state.stopped, "a node nobody authorised must not keep republishing").toBe(1)
        // ⚠️ WITHDRAWN, not merely killed: there is no unpublish in Kademlia, so the one thing we can
        // do is stop being a provider before we go.
        expect(sidecar.state.written.at(-1)).toBe(JSON.stringify({ op: "withdraw" }))
      }),
      { start: sidecar.start, timeoutMs: 200 },
    )
  })

  test("⚠️ and the control: a gate that is still open leaves the node alone", async () => {
    const sidecar = scripted([peers([]), peers([])])
    await run(
      Effect.gen(function* () {
        const dht = yield* CommunityDht.Service
        yield* dht.find()
        yield* CommunityDht.reconcile({ participates: true })
        expect(sidecar.state.stopped, "a settings write that changed nothing must not cost a respawn").toBe(0)
        yield* dht.find()
        expect(sidecar.state.starts, "the same node answers the next lookup").toBe(1)
      }),
      { start: sidecar.start, timeoutMs: 200 },
    )
  })

  test("🔴 changing the published address stops the node advertising the old one", async () => {
    const sidecar = scripted([JSON.stringify({ announced: true }), peers([]), JSON.stringify({ announced: false })])
    await run(
      Effect.gen(function* () {
        const dht = yield* CommunityDht.Service
        yield* dht.find({ announce: "1.2.3.4:4096" })
        expect(sidecar.state.stopped).toBe(0)

        // identify carries the OLD address to everyone the node meets, so a changed setting that
        // left it running would advertise an address the user has already replaced.
        yield* CommunityDht.reconcile({ participates: true, announce: "5.6.7.8:4096" })
        expect(sidecar.state.stopped).toBe(1)
        expect(sidecar.state.written.at(-1)).toBe(JSON.stringify({ op: "withdraw" }))
      }),
      { start: sidecar.start, timeoutMs: 200 },
    )
  })

  test("🔴 a REPLACED node's late death does not settle the live node's request", async () => {
    /**
     * The handlers used to close over the layer's state alone, so a predecessor's `'close'` —
     * arriving after its successor had been spawned — set `alive = false` on the living node and
     * answered its pending request with nothing. Measured on the real seam: after one wedge-kill,
     * that discovery and the next two lookups returned `[]`, and only a lookup 800 ms later found a
     * peer.
     */
    const first = scripted([undefined])
    const second = scripted([peers(["9.9.9.9:4096"])])
    let started = 0
    const start = () => {
      started += 1
      return started === 1 ? first.start() : second.start()
    }
    await run(
      Effect.gen(function* () {
        const dht = yield* CommunityDht.Service
        // The first node never answers: it is killed as wedged, and the layer spawns a replacement.
        expect(yield* dht.find()).toEqual([])

        const late = first.state.kill
        // The successor is spawned by this lookup; the predecessor's `'close'` lands while it waits.
        const found = yield* dht.find().pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Effect.sync(() => late?.())
        expect(yield* Fiber.join(found), "a dead node's goodbye is not the live node's answer").toEqual([
          "9.9.9.9:4096",
        ])
      }),
      { start, timeoutMs: 500 },
    )
  })
})

describe("finding the sidecar binary", () => {
  /**
   * 🔴 Review 1.7 — the desktop package shipped no sidecar AND could not have found one.
   *
   * `binaryPath()` had two candidates: beside the executable, and the dev tree. A packaged Electron
   * app is neither — its extra resources live under `process.resourcesPath`, which is what
   * `packages/host` has looked in since it replaced `@parcel/watcher`. So even after the packager
   * was taught to copy the binary, nothing would have looked for it there.
   */
  test("🔴 a packaged desktop's resources are searched", () => {
    const original = (process as { resourcesPath?: string }).resourcesPath
    // ⚠️ Spelled out rather than imported from `CommunityDht.dhtExecutableName`, ON PURPOSE. This
    // test CONSTRUCTS a file with this name and then asserts `binaryPath()` finds it — so importing
    // the production helper would make it build and then find whatever the code currently says, and
    // a rename would sail through green. An independent spelling is the assertion.
    const exe = process.platform === "win32" ? "novaclaw-dht.exe" : "novaclaw-dht"
    /**
     * ⚠️ A REAL directory in the packaged layout, not the repo — the first version of this test
     * pointed at `packages/` and guarded its assertion with `existsSync`, so it passed without the
     * candidate it was written to pin. The A/B is what said so. A packager's output is a shape, and
     * a shape is cheap to build.
     */
    const resources = mkdtempSync(path.join(tmpdir(), "novaclaw-resources-"))
    mkdirSync(path.join(resources, "dht"))
    writeFileSync(path.join(resources, "dht", exe), "")
    try {
      ;(process as { resourcesPath?: string }).resourcesPath = resources
      expect(CommunityDht.binaryPath(), "a packaged app must look under its own resources").toBe(
        path.join(resources, "dht", exe),
      )
    } finally {
      if (original === undefined) delete (process as { resourcesPath?: string }).resourcesPath
      else (process as { resourcesPath?: string }).resourcesPath = original
      rmSync(resources, { recursive: true, force: true })
    }
  })

  test("⚠️ an explicit override still wins, and the dev tree is the fallback", () => {
    const original = process.env["NOVACLAW_DHT_BINARY"]
    try {
      process.env["NOVACLAW_DHT_BINARY"] = "/somewhere/else/novaclaw-dht"
      expect(CommunityDht.binaryPath()).toBe("/somewhere/else/novaclaw-dht")
    } finally {
      if (original === undefined) delete process.env["NOVACLAW_DHT_BINARY"]
      else process.env["NOVACLAW_DHT_BINARY"] = original
    }
    // The dev fallback names `build/`, the artifact the packager copies — not cargo's scratch tree.
    expect(CommunityDht.binaryPath().split(path.sep).join("/")).toContain("/dht/build/")
  })
})

describe("where the DHT starts, and what may be published (Codex P2/P3)", () => {
  test("🔴 a bootstrap override reaches the sidecar, and absent is not empty", () => {
    /**
     * All three bootstrap addresses were compiled into the Rust binary under one operator's
     * hostname. If those peers move, are blocked or change protocol, no agent inside the OS can
     * repair discovery — the binary has to be replaced, which is exactly what AGENTS.md's
     * self-healing law forbids for an operational fact an outage can hinge on.
     *
     * ⚠️ Measured against the real binary while this landed: with the compiled list, `status`
     * reported `{"table":3}`; with `NOVACLAW_DHT_BOOTSTRAP=""`, `{"table":0}`. Absent means "use
     * what shipped" and empty means "dial nobody" — different instructions, and collapsing them
     * would silently disable bootstrap for everyone who set no preference.
     */
    const seen: Array<ReadonlyArray<string> | undefined> = []
    const sidecar = scripted([peers([])])
    const start = (_binary: string, bootstrap?: ReadonlyArray<string>) => {
      seen.push(bootstrap)
      return sidecar.start()
    }
    return Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const dht = yield* CommunityDht.Service
          yield* dht.find()
          // No store override in this test's config, so the sidecar is started with none and uses
          // its own compiled defaults.
          expect(seen).toEqual([[]])
        }),
        CommunityDht.layerWith({ start, timeoutMs: 200 }),
      ) as Effect.Effect<void>,
    )
  })

  test("🔴 an announce address is PARSED, not pattern-matched", () => {
    /**
     * The regex accepted any one-to-five-digit port and rejected bracketed IPv6, so
     * `example.com:99999` reached the sidecar, failed to convert, and the room was announced with no
     * address attached — a published door nobody can open — while an IPv6-only instance could not
     * publish at all. Both probes come from the review and both now invert.
     */
    expect(CommunityDht.isAnnounceable("example.com:99999")).toBe(false)
    expect(CommunityDht.isAnnounceable("[2001:db8::1]:4096")).toBe(true)

    // A port is a 16-bit number and zero is not one anybody answers on.
    expect(CommunityDht.isAnnounceable("host:0")).toBe(false)
    expect(CommunityDht.isAnnounceable("host:65535")).toBe(true)
    expect(CommunityDht.isAnnounceable("host:65536")).toBe(false)

    // Still the ordinary cases, or the fix would be a different bug.
    expect(CommunityDht.isAnnounceable("novaclaw.app:443")).toBe(true)
    expect(CommunityDht.isAnnounceable("192.168.1.10:4096")).toBe(true)
    expect(CommunityDht.isAnnounceable("")).toBe(false)
    expect(CommunityDht.isAnnounceable(":4096")).toBe(false)
    // Brackets promise IPv6; a name inside them is neither form.
    expect(CommunityDht.isAnnounceable("[notv6]:80")).toBe(false)

    // The parse is exported because callers need the parts, not just the verdict.
    expect(CommunityDht.splitAnnounce("[2001:db8::1]:4096")).toEqual({ host: "2001:db8::1", port: 4096 })
    expect(CommunityDht.splitAnnounce("novaclaw.app:443")).toEqual({ host: "novaclaw.app", port: 443 })
  })
})
