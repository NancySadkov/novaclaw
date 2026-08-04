// OFF-A unit tests: pure policy checks + the global-config policy loader.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Effect, Schema } from "effect"
import { AgentConfigStore } from "./agent-config-store"
import { CatalogStore } from "./catalog-store"
import { CommandConfigStore } from "./command-config-store"
import { Config } from "./config"
import { ConfigStoreWrite } from "./config-store-write"
import { Database } from "./database/database"
import { LayerNode } from "./effect/layer-node"
import { PluginConfigStore } from "./plugin-config-store"
import { ReferenceConfigStore } from "./reference-config-store"
import { SettingsConfigStore } from "./settings-config-store"
import { SkillConfigStore } from "./skill-config-store"
import {
  Offline,
  PROXY_SINK,
  checkUrl,
  currentPolicy,
  disabledPolicy,
  egressEnv,
  hostFromUrl,
  isLoopbackHost,
  layerManifest,
  loadPolicy,
  noProxyList,
  parseAllowList,
  providerHostsFromConfig,
  reload,
  resetPolicy,
} from "./offline"

describe("offline pure helpers", () => {
  test("loopback detection", () => {
    expect(isLoopbackHost("localhost")).toBe(true)
    expect(isLoopbackHost("127.0.0.1")).toBe(true)
    expect(isLoopbackHost("127.42.0.7")).toBe(true)
    expect(isLoopbackHost("::1")).toBe(true)
    expect(isLoopbackHost("[::1]")).toBe(true)
    expect(isLoopbackHost("192.168.178.40")).toBe(false)
    expect(isLoopbackHost("example.com")).toBe(false)
  })

  test("hostFromUrl: absolute, relative, garbage", () => {
    expect(hostFromUrl("http://192.168.178.40:8000/v1/models")).toBe("192.168.178.40")
    expect(hostFromUrl("https://Example.COM/x")).toBe("example.com")
    expect(hostFromUrl("/relative/path")).toBeUndefined()
    expect(hostFromUrl("not a url")).toBeUndefined()
  })

  test("providerHostsFromConfig walks providers.*.api.url (V2)", () => {
    const hosts = providerHostsFromConfig({
      providers: {
        "dgx-spark": { api: { url: "http://192.168.178.40:8000/v1" } },
        cloudy: { api: { url: "https://api.example.com/v1" } },
        broken: { api: { url: 42 } },
        bare: {},
      },
    })
    expect(hosts.sort()).toEqual(["192.168.178.40", "api.example.com"])
    expect(providerHostsFromConfig(undefined)).toEqual([])
    expect(providerHostsFromConfig({})).toEqual([])
  })

  test("parseAllowList tolerates spacing + empties", () => {
    expect(parseAllowList(" 192.168.178.40 , searx.lan ,")).toEqual(["192.168.178.40", "searx.lan"])
    expect(parseAllowList(undefined)).toEqual([])
  })
})

describe("OFF-C egress env (layer 9)", () => {
  test("disabled policy → no child env overlay (never touch the child)", () => {
    expect(egressEnv(disabledPolicy)).toBeUndefined()
  })

  test("enabled policy → *_PROXY sink + allowlist in NO_PROXY (both cases)", () => {
    const policy = { enabled: true, allowedHosts: new Set(["192.168.178.40", "searx.lan"]) }
    const env = egressEnv(policy)!
    expect(env.HTTP_PROXY).toBe(PROXY_SINK)
    expect(env.https_proxy).toBe(PROXY_SINK)
    expect(env.ALL_PROXY).toBe(PROXY_SINK)
    // loopback forms + allowlisted hosts bypass the sink
    expect(env.NO_PROXY).toContain("127.0.0.1")
    expect(env.NO_PROXY).toContain("192.168.178.40")
    expect(env.NO_PROXY).toContain("searx.lan")
    expect(env.no_proxy).toBe(env.NO_PROXY)
  })

  test("noProxyList always includes loopback, sorted allowlist appended", () => {
    expect(noProxyList({ enabled: true, allowedHosts: new Set(["b.lan", "a.lan"]) })).toBe(
      "localhost,127.0.0.1,::1,a.lan,b.lan",
    )
  })
})

describe("offline layer manifest (N/9 indicator)", () => {
  test("disabled → 0/9 active", () => {
    const manifest = layerManifest(disabledPolicy)
    expect(manifest.enabled).toBe(false)
    expect(manifest.active).toBe(0)
    expect(manifest.total).toBe(9)
    expect(manifest.layers.every((l) => !l.active)).toBe(true)
  })

  test("enabled → 9/9 active, layer 9 is the process guard", () => {
    const manifest = layerManifest({ enabled: true, allowedHosts: new Set(["x.lan"]) })
    expect(manifest.active).toBe(9)
    expect(manifest.layers[8]!.layer).toBe(9)
    expect(manifest.layers[8]!.name).toMatch(/process egress/i)
    expect(manifest.layers[8]!.active).toBe(true)
  })
})

describe("checkUrl", () => {
  const policy = { enabled: true, allowedHosts: new Set(["192.168.178.40"]) }

  test("disabled policy allows everything", () => {
    expect(checkUrl("https://evil.example.com", disabledPolicy).allowed).toBe(true)
  })

  test("loopback always allowed", () => {
    expect(checkUrl("http://127.0.0.1:4096/path", policy).allowed).toBe(true)
    expect(checkUrl("http://localhost:8000/v1", policy).allowed).toBe(true)
  })

  test("allowlisted provider host allowed; others fail-closed with a legible message", () => {
    expect(checkUrl("http://192.168.178.40:8000/v1/chat/completions", policy).allowed).toBe(true)
    const verdict = checkUrl("https://api.openai.com/v1/chat", policy)
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) {
      expect(verdict.host).toBe("api.openai.com")
      expect(verdict.message).toContain("api.openai.com")
      expect(verdict.message).toContain("NOVACLAW_OFFLINE_ALLOW")
    }
  })

  test("relative URLs are not egress", () => {
    expect(checkUrl("/global/health", policy).allowed).toBe(true)
  })

  test("empty allowlist blocks all non-loopback (the local-model case)", () => {
    const empty = { enabled: true, allowedHosts: new Set<string>() }
    expect(checkUrl("https://registry.npmjs.org/x", empty).allowed).toBe(false)
    const verdict = checkUrl("https://registry.npmjs.org/x", empty)
    if (!verdict.allowed) expect(verdict.message).toContain("allowed: none")
  })
})

describe("loadPolicy", () => {
  const tmpConfig = (content?: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offline-test-"))
    if (content !== undefined) fs.writeFileSync(path.join(dir, "novaclaw.jsonc"), content)
    return dir
  }

  test("disabled by default (no env, no config)", () => {
    const policy = loadPolicy({ configDir: tmpConfig(), env: {} })
    expect(policy.enabled).toBe(false)
  })

  test("env NOVACLAW_OFFLINE=1 enables; allowlist from global config providers + env", () => {
    const dir = tmpConfig(`{
      // JSONC comments must not break the loader (nor the :// in URLs)
      "providers": { "dgx-spark": { "api": { "url": "http://192.168.178.40:8000/v1" } } },
    }`)
    const policy = loadPolicy({
      configDir: dir,
      env: { NOVACLAW_OFFLINE: "1", NOVACLAW_OFFLINE_ALLOW: "searx.lan" },
    })
    expect(policy.enabled).toBe(true)
    expect([...policy.allowedHosts].sort()).toEqual(["192.168.178.40", "searx.lan"])
  })

  test("config offline:true enables without env", () => {
    const dir = tmpConfig(`{ "offline": true, "providers": {} }`)
    const policy = loadPolicy({ configDir: dir, env: {} })
    expect(policy.enabled).toBe(true)
    expect(policy.allowedHosts.size).toBe(0)
  })

  test("missing config dir stays fail-safe (policy off unless env forces it)", () => {
    const policy = loadPolicy({ configDir: path.join(os.tmpdir(), "definitely-missing-xyz"), env: {} })
    expect(policy.enabled).toBe(false)
    const forced = loadPolicy({
      configDir: path.join(os.tmpdir(), "definitely-missing-xyz"),
      env: { NOVACLAW_OFFLINE: "true" },
    })
    expect(forced.enabled).toBe(true)
    expect(forced.allowedHosts.size).toBe(0)
  })
})

// Config→SQLite sourcing (dependability follow-up): once the stores are seeded they are the ONLY
// runtime truth — the jsonc is an import/export wire and must never override them. Before the
// first boot has seeded anything, the jsonc IS the declared config (seedAll is about to import
// it), so the loader falls back to it. These tests build a real sqlite file with the production
// table shapes and inject it via `dbFile`.
describe("loadPolicy store sourcing", () => {
  const tmpConfig = (content?: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offline-store-test-"))
    if (content !== undefined) fs.writeFileSync(path.join(dir, "novaclaw.jsonc"), content)
    return dir
  }
  const makeStoreDb = (input: {
    offline?: boolean
    providers?: Array<{ id: string; layers: unknown[] }>
    extraSetting?: boolean
  }) => {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "offline-store-db-")), "novaclaw.db")
    const db = new Database(file)
    db.run("CREATE TABLE runtime_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    db.run("CREATE TABLE catalog_provider (id TEXT PRIMARY KEY, layers TEXT NOT NULL)")
    if (input.offline !== undefined)
      db.run("INSERT INTO runtime_setting (key, value) VALUES ('offline', ?)", [JSON.stringify(input.offline)])
    if (input.extraSetting) db.run("INSERT INTO runtime_setting (key, value) VALUES ('shell', '\"cmd\"')")
    for (const provider of input.providers ?? [])
      db.run("INSERT INTO catalog_provider (id, layers) VALUES (?, ?)", [provider.id, JSON.stringify(provider.layers)])
    db.close()
    return file
  }

  test("store offline:true engages the policy with catalog-layer hosts — no jsonc involved", () => {
    const dbFile = makeStoreDb({
      offline: true,
      providers: [{ id: "dgx-spark", layers: [{ api: { url: "http://192.168.178.40:8000/v1" } }] }],
    })
    const policy = loadPolicy({ configDir: tmpConfig(), env: {}, dbFile })
    expect(policy.enabled).toBe(true)
    expect([...policy.allowedHosts]).toEqual(["192.168.178.40"])
  })

  test("a STALE jsonc offline:true never overrides a seeded store that says off", () => {
    const dbFile = makeStoreDb({ offline: false, extraSetting: true })
    const dir = tmpConfig(`{ "offline": true, "providers": { "x": { "api": { "url": "https://evil.example" } } } }`)
    const policy = loadPolicy({ configDir: dir, env: {}, dbFile })
    expect(policy.enabled).toBe(false)
  })

  test("seeded store WITHOUT an offline row means off (no jsonc fallback once seeded)", () => {
    const dbFile = makeStoreDb({ extraSetting: true })
    const dir = tmpConfig(`{ "offline": true }`)
    expect(loadPolicy({ configDir: dir, env: {}, dbFile }).enabled).toBe(false)
  })

  test("pre-seed (missing db) falls back to the jsonc that is about to be imported", () => {
    const dir = tmpConfig(`{ "offline": true, "providers": { "p": { "api": { "url": "http://10.0.0.5:8000" } } } }`)
    const policy = loadPolicy({
      configDir: dir,
      env: {},
      dbFile: path.join(os.tmpdir(), "definitely-missing-dir", "no.db"),
    })
    expect(policy.enabled).toBe(true)
    expect([...policy.allowedHosts]).toEqual(["10.0.0.5"])
  })

  test("env stays the highest-precedence escape hatch; allowlist merges store + env hosts", () => {
    const dbFile = makeStoreDb({
      offline: false,
      providers: [{ id: "spark", layers: [{ api: { url: "http://192.168.178.40:8000/v1" } }] }],
    })
    const policy = loadPolicy({
      configDir: tmpConfig(),
      env: { NOVACLAW_OFFLINE: "1", NOVACLAW_OFFLINE_ALLOW: "searx.lan" },
      dbFile,
    })
    expect(policy.enabled).toBe(true)
    expect([...policy.allowedHosts].sort()).toEqual(["192.168.178.40", "searx.lan"])
  })

  test("multi-layer providers contribute every layer api.url host", () => {
    const dbFile = makeStoreDb({
      offline: true,
      providers: [
        {
          id: "p",
          layers: [{ api: { url: "http://10.1.1.1:1" } }, { api: { url: "http://10.2.2.2:2" } }],
        },
      ],
    })
    const policy = loadPolicy({ configDir: tmpConfig(), env: {}, dbFile })
    expect([...policy.allowedHosts].sort()).toEqual(["10.1.1.1", "10.2.2.2"])
  })
})

// ── A3 — the airgap ACTUALLY APPLIES (v0.2.0-prep Wave 1) ────────────────────────────────────
//
// The defect these tests pin: `Offline.layer` computed the policy ONCE and captured it in
// `check`/`egressEnv`/`manifest`, so flipping airgap ON through Settings blocked NOTHING until the
// process restarted — while `/shell/offline`, which re-reads the same stores on every request,
// reported 9/9 layers active. The guard was off while the status surface said it was on
// (v0.2.0 ruling 3: *a fault is never described falsely*).
//
// So the gate has to be end-to-end and it has to be over the REAL graph: the real store layers,
// the real `ConfigStoreWrite.apply` (the exact path PATCH /config takes), and the SAME
// `Offline.Service` instance before and after — nothing is rebuilt mid-test.
//
// Why a temp FILE db and not the suite's `:memory:` one: the offline loader reads the settings and
// catalog rows through its OWN read-only sqlite connection (`readRowsSync` — it runs at layer init,
// before any Effect layer exists), and `:memory:` is per-connection, so it would see an empty
// database no matter what the write path stored. `Flag.NOVACLAW_DB` is read once at module load,
// which is why `Offline.layerWith` takes the source explicitly.
describe("A3: a config write engages the airgap without a restart", () => {
  const decodeInfo = Schema.decodeUnknownSync(Config.Info)

  const provider = (id: string, url: string) => ({
    providers: { [id]: { name: id, api: { type: "native", url, settings: {} } } },
  })

  const tmp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offline-live-"))
    return { configDir: dir, dbFile: path.join(dir, "novaclaw.db") }
  }

  const graph = (configDir: string, dbFile: string) =>
    LayerNode.compile(
      LayerNode.group([
        Database.node,
        AgentConfigStore.node,
        CatalogStore.node,
        CommandConfigStore.node,
        PluginConfigStore.node,
        ReferenceConfigStore.node,
        SettingsConfigStore.node,
        SkillConfigStore.node,
        Offline.node,
      ]),
      [
        [Database.node, Database.layerFromPath(dbFile)],
        [Offline.node, Offline.layerWith({ configDir, env: {}, dbFile })],
      ],
    )

  // The live policy is process-wide by design (see offline.ts): drop it between tests so one
  // temp db cannot answer the next test's question.
  afterEach(() => resetPolicy())

  test("reload before any layer installed a source is a no-op — nothing is guarding", () => {
    resetPolicy()
    expect(currentPolicy()).toBe(disabledPolicy)
    expect(reload().enabled).toBe(false)
  })

  test("flipping `offline` ON blocks on the NEXT call, and the manifest stops lying", async () => {
    const { configDir, dbFile } = tmp()
    await Effect.runPromise(
      Effect.gen(function* () {
        const offline = yield* Offline.Service
        // A provider the airgap must keep reachable, written the way Settings writes it.
        yield* ConfigStoreWrite.apply(decodeInfo(provider("spark", "http://192.168.178.40:8000/v1")))

        // Airgap OFF: the WAN is open, OFF-C touches no child env, and the N/9 indicator agrees.
        expect(offline.policy.enabled).toBe(false)
        expect(offline.check("https://api.openai.com/v1/chat").allowed).toBe(true)
        expect(offline.egressEnv()).toBeUndefined()
        expect(offline.manifest().active).toBe(0)

        // The NEGATIVE CONTROL, captured inline: this is exactly what the old implementation froze
        // at layer-build time. It must still read `false` after the write below — proving the write
        // is real and that only the re-read is what makes the live service follow it.
        const frozen = loadPolicy({ configDir, env: {}, dbFile })

        // The write path PATCH /config takes. NOTHING is rebuilt after this line.
        yield* ConfigStoreWrite.apply(decodeInfo({ offline: true }))

        expect(offline.policy.enabled).toBe(true)
        expect(offline.check("https://api.openai.com/v1/chat").allowed).toBe(false)
        // …while the configured provider and loopback stay reachable.
        expect(offline.check("http://192.168.178.40:8000/v1/chat/completions").allowed).toBe(true)
        expect(offline.check("http://127.0.0.1:4096/global/health").allowed).toBe(true)
        // OFF-C (layer 9) follows on the same call, and the status surface now agrees with the guard.
        expect(offline.egressEnv()?.HTTP_PROXY).toBe(PROXY_SINK)
        expect(offline.egressEnv()?.NO_PROXY).toContain("192.168.178.40")
        expect(offline.manifest().enabled).toBe(true)
        expect(offline.manifest().active).toBe(9)

        expect(frozen.enabled).toBe(false)
        expect(checkUrl("https://api.openai.com/v1/chat", frozen).allowed).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(graph(configDir, dbFile))),
    )
  }, 15_000)

  test("a provider added WHILE airgapped joins the allowlist without a restart", async () => {
    const { configDir, dbFile } = tmp()
    await Effect.runPromise(
      Effect.gen(function* () {
        const offline = yield* Offline.Service
        yield* ConfigStoreWrite.apply(decodeInfo({ offline: true }))
        expect(offline.policy.enabled).toBe(true)
        expect(offline.check("http://10.9.9.9:8000/v1/models").allowed).toBe(false)

        // Self-healing (AGENTS.md): an agent repairing a moved endpoint must not need a reboot.
        yield* ConfigStoreWrite.apply(decodeInfo(provider("local", "http://10.9.9.9:8000/v1")))
        expect(offline.check("http://10.9.9.9:8000/v1/models").allowed).toBe(true)
        expect(offline.check("https://api.openai.com/v1/chat").allowed).toBe(false)
      }).pipe(Effect.scoped, Effect.provide(graph(configDir, dbFile))),
    )
  }, 15_000)

  test("turning `offline` back OFF re-opens on the next call (the toggle is symmetric)", async () => {
    const { configDir, dbFile } = tmp()
    await Effect.runPromise(
      Effect.gen(function* () {
        const offline = yield* Offline.Service
        yield* ConfigStoreWrite.apply(decodeInfo({ offline: true }))
        expect(offline.check("https://api.openai.com/v1/chat").allowed).toBe(false)

        yield* ConfigStoreWrite.apply(decodeInfo({ offline: false }))
        expect(offline.policy.enabled).toBe(false)
        expect(offline.check("https://api.openai.com/v1/chat").allowed).toBe(true)
        expect(offline.egressEnv()).toBeUndefined()
        expect(offline.manifest().active).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(graph(configDir, dbFile))),
    )
  }, 15_000)
})
