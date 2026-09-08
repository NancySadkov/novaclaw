import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Config } from "@/config/config"
import { MCP } from "../../src/mcp/index"
import { testEffect } from "../lib/effect"

/**
 * **An MCP server added through any supported route is still there after the process restarts.**
 *
 * That sentence was false in every route the product ships (v0.2.0-prep B3a, fixed 2026-07-28):
 * `MCP.add` did `s.config[name] = mcp` — process memory — while `POST /api/mcp` answered 200, and
 * `nova-cli mcp add` wrote a jsonc document that, on any instance which had booted once, nothing
 * would ever read again (`mcp` is served from SQLite and the jsonc seed is `isEmpty`-gated).
 *
 * ⚠️ Asserting that `s.config[name]` got set proves nothing — that IS the bug. So this file only
 * ever believes a **rebuilt service graph over the same database file**: write through one graph,
 * throw it away, build a second one from scratch, and read the server back through the production
 * read path (`Config.getGlobal()` → `ConfigStoreWrite.overlay` → the settings store), which is the
 * same path `MCP.state` consults when it decides what to connect at boot.
 *
 * The database is a real FILE rather than the suite's default `:memory:` precisely so "restart"
 * means something: under `:memory:` every distinct layer build is a private database, so a
 * round-trip through one would be measuring nothing.
 *
 * ⚠️ BOTH DIRECTIONS WERE MADE TO BITE, not argued.
 *
 * 1. **The check catches the bug it was written for.** Deleting the one `ConfigStoreWrite.apply`
 *    line in `MCP.persistServer` — i.e. restoring the pre-B3a memory-only behaviour — turns 3 of
 *    these 4 tests red (the 4th is the control, which correctly still passes):
 *
 *      109 |     expect(servers["survivor"]).toBeDefined()
 *      error: expect(received).toBeDefined()
 *      Received: undefined
 *
 * 2. **NEGATIVE CONTROL** — *"does not survive when the write lands in a different store"*. The
 *    dangerous way for this file to pass is vacuously: if Effect handed the second graph back the
 *    FIRST graph's memoized services, the read would be answered out of the writer's own live state
 *    and would report "persisted" no matter what the code did. Pointing the reader at a second
 *    database file proves the rebuild is a genuine re-read, and it models the real defect class — a
 *    write that lands somewhere the reader does not look, which is precisely what the jsonc document
 *    was. Repointing that read back at `MAIN_DB` fails it, so the control discriminates:
 *
 *      error: expect(received).toBeUndefined()
 *      Received: { type: "remote", url: "https://control.example.com/mcp", oauth: false }
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "novaclaw-mcp-persist-"))

/** The write-and-read database (the positive round-trip), and the control's decoy. */
const MAIN_DB = path.join(TMP, "main.db")
const DECOY_DB = path.join(TMP, "decoy.db")
/** A third file for the service-level test, so `MCP.state`'s boot never inherits another test's servers. */
const SERVICE_DB = path.join(TMP, "service.db")

afterAll(() => {
  // Best-effort: Windows can hold SQLite/WAL handles until finalizers run, and a temp file we
  // failed to delete must never fail the suite that wrote it.
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    /* ignore */
  }
})

type McpEntry = Parameters<MCP.Interface["persist"]>[1]

const entry = (value: Record<string, unknown>) => value as unknown as McpEntry

/**
 * Compile a graph whose `Database` is the given FILE. `LayerNode.compile` resolves replacements
 * across its whole walk, so every store in the tree gets this database, not just the root node.
 */
const overDatabase = <A, E>(root: LayerNode.Node<A, E, any>, file: string) =>
  LayerNode.compile(root, [[Database.node, Database.layerFromPath(file)]])

/** The write side: a fresh MCP service over `file`, torn down when the effect completes. */
const writeThrough = <A>(file: string, use: (mcp: MCP.Interface) => Effect.Effect<A>) =>
  Effect.runPromise(
    MCP.Service.use(use).pipe(Effect.scoped, Effect.provide(overDatabase(MCP.node, file)), Effect.orDie),
  )

/**
 * The read side — and the restart. A brand-new `Config` graph over `file`: new layer build, new
 * SQLite connection, nothing carried over from the writer.
 */
const serversAfterRestart = (file: string) =>
  Effect.runPromise(
    Config.Service.use((cfg) => cfg.getGlobal()).pipe(
      Effect.map((info) => info.mcp?.servers ?? {}),
      Effect.scoped,
      Effect.provide(overDatabase(Config.node, file)),
      Effect.orDie,
    ),
  )

const REMOTE = { type: "remote", url: "https://example.com/mcp", oauth: false }

describe("MCP server persistence", () => {
  test("a persisted server survives a rebuild of the whole service graph", async () => {
    await writeThrough(MAIN_DB, (mcp) => mcp.persist("survivor", entry(REMOTE)))

    const servers = await serversAfterRestart(MAIN_DB)
    expect(servers["survivor"]).toBeDefined()
    expect(servers["survivor"]).toMatchObject({ type: "remote", url: "https://example.com/mcp" })
  }, 60_000)

  test("does not survive when the write lands in a different store (negative control)", async () => {
    await writeThrough(MAIN_DB, (mcp) =>
      mcp.persist("control", entry({ ...REMOTE, url: "https://control.example.com/mcp" })),
    )

    // Same assertion, same helper, a store the write never touched. If this were also "defined",
    // the test above would be measuring the writer's own memory rather than a restart.
    const servers = await serversAfterRestart(DECOY_DB)
    expect(servers["control"]).toBeUndefined()
  }, 60_000)

  test("adding two servers keeps the first — the settings key is patch-merged, not replaced", async () => {
    await writeThrough(MAIN_DB, (mcp) =>
      Effect.gen(function* () {
        yield* mcp.persist("first", entry(REMOTE))
        yield* mcp.persist("second", entry({ ...REMOTE, url: "https://second.example.com/mcp" }))
      }),
    )

    const servers = await serversAfterRestart(MAIN_DB)
    expect(Object.keys(servers)).toEqual(expect.arrayContaining(["first", "second"]))
  }, 60_000)
})

const it = testEffect(overDatabase(MCP.node, SERVICE_DB))

describe("MCP add/connect/disconnect write through to the store", () => {
  it.instance(
    "add persists the server even when the connection fails, and the switch position outlives it",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service

        // An unparseable URL fails inside `connectRemote` BEFORE any transport is constructed, so
        // this is deterministic without a network, a child process, or a mocked MCP SDK — which
        // matters because sibling suites in this directory mock that SDK process-wide.
        const added = yield* mcp.add("toggled", entry({ type: "remote", url: "not-a-url", oauth: false }))
        const result = added.status
        const status = "status" in result ? result : result["toggled"]
        expect(status?.status).toBe("failed")

        // ⭐ ruling 2, both halves at once: the CONNECTION honestly reports failure, and the
        // MUTATION honestly succeeded. Before B3a the second half was a lie.
        let servers = yield* Effect.promise(() => serversAfterRestart(SERVICE_DB))
        expect(servers["toggled"]).toMatchObject({ type: "remote", url: "not-a-url", disabled: false })

        // The app's per-server switch (`dialog-select-mcp.tsx`) is a durable PREFERENCE, so the OFF
        // position has to outlive the process. The connection state deliberately does not: nothing
        // stores "connected", because a stored "connected" is a claim about a process that is gone.
        yield* mcp.disconnect("toggled")
        servers = yield* Effect.promise(() => serversAfterRestart(SERVICE_DB))
        expect(servers["toggled"]).toMatchObject({ disabled: true })

        yield* mcp.connect("toggled")
        servers = yield* Effect.promise(() => serversAfterRestart(SERVICE_DB))
        expect(servers["toggled"]).toMatchObject({ disabled: false })
      }),
    60_000,
  )
})
