import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Effect, Logger, References } from "effect"
import {
  ATTRIBUTE_CLASSES,
  derivedContent,
  EVENTS,
  type EventDeclaration,
  type EventKey,
  keyFault,
  keys,
  KEY_GRAMMAR,
  mayEgress,
  RESERVED_ATTRIBUTES,
  subsystemOf,
  SUBSYSTEMS,
} from "@novaclaw/schema/log-events"
import { Log } from "@novaclaw/schema/log"
import { Logging } from "@novaclaw/core/observability/logging"

/**
 * **The mechanical half of `todo/logging.md` 1a.** Ruling 1: an invariant whose violation compiles
 * green ships with a check, or the invariant does not exist.
 *
 * The type in `schema/log-events.ts` closes exactly one door — an UNDECLARED key does not
 * compile. Everything else about a key set compiles green forever and therefore lives here:
 *
 *   · a key that is not `subsystem.object.action[.outcome]` is just a string;
 *   · a key whose first segment names no subsystem breaks 3b's per-subsystem levels silently;
 *   · an attribute named `level` or `cause` puts that name on the logfmt line TWICE, which breaks
 *     the naive `grep`/`cut` mining that is this whole item's requirement — and 39 live call sites
 *     already do it;
 *   · a key declared content-free whose attributes include free text is a redaction leak with a
 *     delay (1f), and nothing about it is visible to a compiler;
 *   · a key for an event nobody emits is a vocabulary nobody can use.
 *
 * ⚠️ **And every guard below is negative-controlled**, because `toEqual([])` against a live tree
 * proves only that the tree is clean today — it cannot show the guard is capable of reporting
 * anything at all. Each real assertion has a sibling that drives the SAME pure function over
 * synthetic input and demands a failure (AGENTS.md pitfall #-1: a counter that can lie about the
 * thing it counts is worse than no counter).
 *
 * ⚠️ **This is a GROWTH ratchet, not a shrink-only ledger** — and that is on purpose, unlike
 * `sdk/js/test/legacy-path-ledger.test.ts` whose set may only get smaller. The key set is SUPPOSED
 * to grow: item 1b converts ~230 call sites subsystem by subsystem and declares a key for each. So
 * pinning a count here would fire on every honest commit and be deleted within a week. What is
 * pinned instead is the SHAPE of the next key — the guard bites on the next BAD entry, which
 * legacy-path-ledger's own comment names as the only form this class of invariant can take.
 */

/** `packages/core/test` → the app repo root, so a declaration's `file` can be resolved. */
const ROOT = path.resolve(import.meta.dir, "..", "..", "..")

const declarations = Object.entries(EVENTS) as ReadonlyArray<readonly [EventKey, EventDeclaration]>

/** The declaration source, read as TEXT — the only way to see a duplicate literal key. */
const SOURCE_PATH = path.join(ROOT, "packages/schema/src/log-events.ts")
const SOURCE = fs.readFileSync(SOURCE_PATH, "utf8")

describe("the sweep reached something", () => {
  test("the key set and the subsystem set are both non-trivial", () => {
    // Every assertion below is a filter over these. If a refactor emptied them, each one would
    // become a tautology that passes forever — the guard-shaped no-op.
    expect(declarations.length).toBeGreaterThanOrEqual(10)
    expect(Object.keys(SUBSYSTEMS).length).toBeGreaterThanOrEqual(5)
    expect(keys().length).toBe(declarations.length)
    expect(fs.existsSync(SOURCE_PATH)).toBe(true)
    expect(SOURCE.length).toBeGreaterThan(5000)
  })

  test("the key list is sorted and free of duplicates", () => {
    const sorted = keys()
    expect(new Set(sorted).size).toBe(sorted.length)
    expect([...sorted].sort()).toEqual([...sorted])
  })
})

describe("every key is well formed, and the subsystem is a parsed field", () => {
  test("no declared key breaks the grammar or names an undeclared subsystem", () => {
    expect(declarations.map(([key]) => keyFault(key)).filter((fault) => fault !== undefined)).toEqual([])
  })

  test("subsystemOf returns a DECLARED subsystem for every key — 3b's prefix match is sound", () => {
    // This is the assertion that makes "the first segment is load-bearing" true rather than a
    // naming habit: Settings → Developer renders one row per subsystem and resolves a level by
    // prefix, so a key whose prefix is not in the closed set would be unreachable from that surface.
    expect(declarations.filter(([key]) => !(subsystemOf(key) in SUBSYSTEMS)).map(([key]) => key)).toEqual([])
  })

  test("every declared subsystem is REACHED by at least one key", () => {
    // Ruling 10's shape: a closed compiled set whose every member is reachable. A subsystem with no
    // events would render an empty, unexplained row in Settings → Developer.
    const used = new Set(declarations.map(([key]) => subsystemOf(key)))
    expect(Object.keys(SUBSYSTEMS).filter((name) => !used.has(name as never))).toEqual([])
  })

  test("the grammar actually bites (negative control)", () => {
    // The real validator, over synthetic keys. Two segments is not enough, five is too many, an
    // uppercase or underscored segment is not the grammar, and an undeclared first segment is the
    // failure 3b would otherwise discover in production.
    expect(keyFault("mcp.server")).toContain("not subsystem.object.action")
    expect(keyFault("mcp.server.spawn.failed.again")).toContain("not subsystem.object.action")
    expect(keyFault("mcp.Server.spawn")).toContain("not subsystem.object.action")
    expect(keyFault("mcp.server_spawn.start")).toContain("not subsystem.object.action")
    expect(keyFault("mcp..spawn")).toContain("not subsystem.object.action")
    // ⚠️ Deliberately a name that will never be declared. An earlier draft used `telemetry`, which
    // is a subsystem this product plausibly grows — and a negative control that a legitimate future
    // commit turns red is a control that gets deleted rather than believed.
    expect(keyFault("notasubsystem.beacon.send")).toContain("not a declared subsystem")
    // …and a well-formed key with a declared subsystem passes, in both arities.
    expect(keyFault("mcp.server.spawn")).toBeUndefined()
    expect(keyFault("mcp.server.spawn.failed")).toBeUndefined()
    expect(KEY_GRAMMAR.test("mcp.server.spawn.failed")).toBe(true)
    // The parser answers `undefined` rather than guessing for a string it does not recognise.
    expect(subsystemOf("notasubsystem.beacon.send")).toBeUndefined()
    expect(subsystemOf("mcp.server.spawn")).toBe("mcp")
  })
})

describe("attributes cannot shadow the line's own columns", () => {
  /** Offenders: `key → attribute` pairs whose name is already a column in the logfmt line. */
  const shadowing = (entries: ReadonlyArray<readonly [string, EventDeclaration]>) =>
    entries.flatMap(([key, declaration]) =>
      Object.keys(declaration.attributes)
        .filter((name) => RESERVED_ATTRIBUTES.includes(name))
        .map(
          (name) =>
            `${key} declares an attribute named "${name}", which is already a column on the log line. ` +
            `It would appear TWICE and break naive parsing — namespace it (e.g. "${subsystemOf(key)}.${name}").`,
        ),
    )

  test("no declared attribute reuses a reserved column", () => {
    expect(shadowing(declarations)).toEqual([])
  })

  test("the shadow check bites (negative control)", () => {
    // The live tree is clean because this file existed before the keys did. Drive the same function
    // over the shape that is NOT clean: the MCP relay passed a bare `level` before fix 1d.
    const synthetic: EventDeclaration = {
      level: "info",
      message: "MCP server log",
      attributes: { server: "id", level: "id" },
      content: "none",
      file: "packages/novaclaw/src/mcp/index.ts",
    }
    expect(shadowing([["mcp.server.output", synthetic]])).toEqual([
      'mcp.server.output declares an attribute named "level", which is already a column on the log line. ' +
        'It would appear TWICE and break naive parsing — namespace it (e.g. "mcp.level").',
    ])
    // …and the namespaced form the real declaration uses is not an offender.
    expect(shadowing([["mcp.server.output", { ...synthetic, attributes: { "mcp.level": "id" } }]])).toEqual([])
  })

  test("every attribute class is one the value table knows", () => {
    const unknown = declarations.flatMap(([key, declaration]) =>
      Object.entries(declaration.attributes)
        .filter(([, name]) => !(name in ATTRIBUTE_CLASSES))
        .map(([field, name]) => `${key}.${field} is class "${name}", which is not declared`),
    )
    expect(unknown).toEqual([])
  })
})

describe("redaction is in the record, and it cannot drift from the attributes", () => {
  /** Keys whose declared content class disagrees with what their attributes actually imply. */
  const drifted = (entries: ReadonlyArray<readonly [string, EventDeclaration]>) =>
    entries
      .filter(([, declaration]) => derivedContent(declaration) !== declaration.content)
      .map(
        ([key, declaration]) =>
          `${key} declares content:"${declaration.content}" but its attributes imply ` +
          `"${derivedContent(declaration)}" — fix whichever is wrong, deliberately.`,
      )

  test("no key's declared content class disagrees with its own fields", () => {
    expect(drifted(declarations)).toEqual([])
  })

  test("the content check bites (negative control)", () => {
    // The failure this exists to catch is not someone writing the wrong word today. It is someone
    // adding a `text` field to a content-free key a year from now and nothing noticing — which is
    // how a scrubber ends up bolted onto a log that already captured a prompt (1f).
    const contentFree: EventDeclaration = {
      level: "warn",
      message: "MCP connection closed",
      attributes: { server: "id" },
      content: "none",
      file: "packages/novaclaw/src/mcp/index.ts",
    }
    expect(drifted([["mcp.connection.close", contentFree]])).toEqual([])
    const withUserText: EventDeclaration = { ...contentFree, attributes: { server: "id", detail: "text" } }
    expect(drifted([["mcp.connection.close", withUserText]])).toEqual([
      'mcp.connection.close declares content:"none" but its attributes imply "user" — fix whichever is wrong, deliberately.',
    ])
    // A path is content too: it carries the user's account name and their project names.
    expect(drifted([["mcp.connection.close", { ...contentFree, attributes: { dir: "path" } }]])).toHaveLength(1)
  })

  test("mayEgress answers from the declaration, not from a scrubber", () => {
    // The precondition for 1f and for anything the maintenance plane carries. Nothing consumes it
    // yet — the point of 1a is that the answer exists in the type BEFORE a later slice needs it.
    expect(mayEgress("mcp.connection.close")).toBe(true)
    expect(mayEgress("mcp.server.output")).toBe(false)
    expect(mayEgress("kb.memory.open.failed")).toBe(false)
    expect(mayEgress("credential.cipher.load.failed")).toBe(false)
    expect(mayEgress("config.file.load")).toBe(false)
    expect(mayEgress("git.tree.diff.truncated")).toBe(true)
    expect(mayEgress("resource.headroom.measure.failed")).toBe(false)
    expect(mayEgress("storage.migration.run.failed")).toBe(false)
    expect(mayEgress("messenger.discord.backfill.truncated")).toBe(false)
    expect(mayEgress("messenger.operator.notice.failed")).toBe(false)
    expect(mayEgress("messenger.store.read.failed")).toBe(false)
    // Every content-free key must really be free of non-egress fields.
    const leaks = declarations
      .filter(([key]) => mayEgress(key))
      .flatMap(([key, declaration]) =>
        Object.entries(declaration.attributes)
          .filter(([, name]) => !ATTRIBUTE_CLASSES[name].egress)
          .map(([field]) => `${key}.${field}`),
      )
    expect(leaks).toEqual([])
  })
})

describe("the key set is MEASURED against the tree, not invented", () => {
  /**
   * How a declaration is tied to the tree: `"message"` while the site still logs the raw English,
   * `"key"` once item 1b has converted it, `undefined` when neither is there.
   *
   * ⚠️ **Both arms are required and the second one is not decoration.** An earlier draft checked the
   * message alone — which would have gone red on 1b's very first conversion, because converting a
   * site is precisely what MOVES the sentence out of it and into the declaration. A guard that
   * fails when the migration it exists to support makes progress is a guard that gets deleted.
   */
  const anchorOf = (declaration: EventDeclaration, key: string, root: string): "message" | "key" | undefined => {
    const full = path.join(root, declaration.file)
    if (!fs.existsSync(full)) return undefined
    const text = fs.readFileSync(full, "utf8")
    if (text.includes(JSON.stringify(declaration.message))) return "message"
    return text.includes(JSON.stringify(key)) ? "key" : undefined
  }

  /** Keys whose cited file is missing, or carries neither the declared message nor the key. */
  const unanchored = (entries: ReadonlyArray<readonly [string, EventDeclaration]>, root: string) =>
    entries
      .filter(([key, declaration]) => anchorOf(declaration, key, root) === undefined)
      .map(
        ([key, declaration]) =>
          `${key} cites ${declaration.file}, which contains neither the literal ` +
          `${JSON.stringify(declaration.message)} nor ${JSON.stringify(key)}. Either the call site moved, ` +
          "the message was reworded without the declaration following it, or the key was declared for an " +
          "event nothing emits.",
      )

  test("every declared key points at a live call site", () => {
    // This is what stops the vocabulary filling with keys for events nobody emits. A key exists
    // because a call site exists, and the seed set was read off the tree rather than imagined.
    expect(unanchored(declarations, ROOT)).toEqual([])
  })

  test("the anchor check bites (negative control)", () => {
    const absent: EventDeclaration = {
      level: "info",
      message: "a sentence no file contains",
      attributes: {},
      content: "none",
      file: "packages/novaclaw/src/mcp/index.ts",
    }
    expect(unanchored([["mcp.server.spawn", absent]], ROOT)).toHaveLength(1)
    expect(anchorOf(absent, "mcp.server.spawn", ROOT)).toBeUndefined()
    expect(unanchored([["mcp.server.spawn", { ...absent, file: "packages/no/such/file.ts" }]], ROOT)).toHaveLength(1)
    // Both arms really are reachable: the migrated live declaration anchors by key, while the
    // synthetic declaration below still proves that a source file may anchor by message.
    expect(anchorOf(EVENTS["mcp.connection.close"], "mcp.connection.close", ROOT)).toBe("key")
    // …anchored by KEY: this very file quotes "mcp.connection.close" all over. Pointing the check
    // at a file whose contents this test controls is what makes the second arm provable without
    // waiting for 1b to convert something. ⚠️ The sentinel message is ASSEMBLED rather than written
    // as a literal, because a literal written here would be found here — the first attempt at this
    // control returned "message" for exactly that reason.
    const sentinel = "zz" + "-no-such-" + "sentence"
    expect(
      anchorOf(
        { ...absent, message: sentinel, file: "packages/core/test/log-events.test.ts" },
        "mcp.connection.close",
        ROOT,
      ),
    ).toBe("key")
  })

  test("no key is declared twice in the source text", () => {
    // `Object.keys` cannot see a duplicate literal — the later one silently wins at runtime — so the
    // only way to catch a copy-pasted entry is to read the declaration as text.
    const duplicated = keys().filter((key) => SOURCE.split(`"${key}": {`).length > 2)
    expect(duplicated).toEqual([])
    // …and the counter is real: a string that IS repeated in the file is found.
    expect(SOURCE.split('level: "info"').length).toBeGreaterThan(2)
  })
})

/**
 * ── the part that is EXERCISED rather than inspected ────────────────────────────────────────────
 *
 * Everything above reads declarations. This block runs the real wrapper through the real Effect
 * logger and the real logfmt formatter and reads the line that comes out, because the claim that
 * matters — *a keyed record lands in the same line, through the same formatter, in the same file* —
 * is a claim about behaviour and cannot be established by reading a type.
 */

/** Capture the formatted lines a program produces, through the PRODUCTION formatter. */
function lines<E>(effect: Effect.Effect<void, E>, level: "Debug" | "Info" = "Info"): string[] {
  const captured: string[] = []
  const capture = Logger.map(Logging.formatter("testrun0"), (line) => {
    captured.push(line)
  })
  Effect.runSync(
    effect.pipe(
      Effect.provide(Logger.layer([capture], { mergeWithExisting: false })),
      Effect.provideService(References.MinimumLogLevel, level),
    ) as Effect.Effect<void>,
  )
  return captured
}

/** logfmt → the ordered list of keys on the line. Deliberately naive: that is the requirement. */
const columns = (line: string): string[] =>
  (line.match(/(?:^| )([A-Za-z][\w.]*)=/g) ?? []).map((match) => match.trim().slice(0, -1))

describe("a keyed record lands in the SAME line as every other log record", () => {
  test("the line carries event=, keeps message= verbatim, and flattens the attributes", () => {
    const [line] = lines(
      Log.event("filesystem.watcher.start", {
        directory: "/home/nancy/my project",
        platform: "win32",
        backend: "parcel",
      }),
    )
    expect(line).toBeDefined()
    // The stable column a saved query keys off. `grep 'event=filesystem\.'` works from this commit.
    expect(line).toContain("event=filesystem.watcher.start")
    // The English is the declaration's, verbatim — so today's `grep "watcher backend"` keeps working
    // through the whole of item 1b.
    expect(line).toContain('message="watcher backend"')
    // The attributes are top-level logfmt columns, exactly as the un-keyed second argument is today.
    expect(line).toContain("platform=win32")
    expect(line).toContain("backend=parcel")
    // …and a value carrying a space is still JSON-quoted exactly as it is today. The wrapper hands
    // its attributes to the SAME formatter; it does not re-encode them.
    expect(line).toContain('directory="/home/nancy/my project"')
    // …and it is one line in the existing envelope, not a record of its own shape.
    expect(line.startsWith("timestamp=")).toBe(true)
    expect(line).toContain("level=INFO")
    expect(line).toContain("run=testrun0")
  })

  test("the key sits in a fixed column, right after run=", () => {
    const [line] = lines(Log.event("skill.registry.init", { count: 12 }))
    expect(columns(line ?? "").slice(0, 5)).toEqual(["timestamp", "level", "run", "event", "message"])
    expect(line).toContain("count=12")
  })

  test("the DECLARED level is the level that is emitted", () => {
    // Fix 1d, exercised: severity is a property of the event, not a choice at the call site. A
    // developer's debug print cannot reach `ERROR` without a key that says `error`.
    expect(lines(Log.event("mcp.connection.close", { server: "searxng" }))[0]).toContain("level=WARN")
    expect(
      lines(Log.event("server.request.fail", { ref: "err_1", "server.error": "x", "server.cause": "y" }))[0],
    ).toContain("level=ERROR")
    expect(lines(Log.event("skill.registry.init", { count: 1 }))[0]).toContain("level=INFO")
  })

  test("the two unrelated `failed` sites are finally distinguishable", () => {
    // `todo/logging.md` §0.4's argument in miniature: one word, two subsystems, and until now
    // nothing on the line could tell them apart.
    const server = lines(
      Log.event("server.request.fail", { ref: "err_1", "server.error": "e", "server.cause": "c" }),
    )[0]
    const format = lines(
      Log.event("format.file.format.failed", {
        "format.file": "a.ts",
        "format.command": '["prettier","a.ts"]',
        "format.environment": '{"PRIVATE_TOKEN":"secret"}',
      }),
    )[0]
    expect(server).toContain("message=failed")
    expect(format).toContain("message=failed")
    expect(server).toContain("event=server.request.fail")
    expect(format).toContain("event=format.file.format.failed")
    expect(subsystemOf("server.request.fail")).toBe("server")
    expect(subsystemOf("format.file.format.failed")).toBe("format")
    expect(mayEgress("format.file.format.failed")).toBe(false)
  })

  test("a keyed line has NO duplicate column — and the raw path does (negative control)", () => {
    const keyed = lines(
      Log.event("mcp.server.output", { server: "s", "mcp.logger": "l", "mcp.level": "error", "mcp.data": "hi" }),
    )[0]
    const seen = columns(keyed ?? "")
    expect(new Set(seen).size).toBe(seen.length)
    expect(keyed).toContain("mcp.level=error")
    // ── the control, and it is a live measurement rather than a fabrication ─────────────────────
    // Two ways the raw path puts one name on the line twice, both reproduced here rather than
    // asserted from reading the source. If either assertion ever fails, the formatter was fixed —
    // delete that half of the control and say so.
    //
    // (1) The formatter maps EVERY message part onto the single name `message`, so a multi-argument
    //     raw call emits that column twice. Three live sites pass a field named `message`.
    const raw = lines(Effect.logInfo("first", "second"))[0]
    expect(columns(raw ?? "").filter((name) => name === "message")).toHaveLength(2)
    // (2) A FIELD may collide with one of the line's own columns. This reproduces the retired MCP
    //     relay shape: a bare `level` carrying the foreign server's severity made the line say
    //     `level=INFO … level=error`, so a naive `grep -o 'level=[^ ]*'` got two answers. Fix 1d now
    //     emits `mcp.level`; 36 further raw sites still collide with `cause` until their 1b passes.
    //     RESERVED_ATTRIBUTES is what stops a DECLARED key ever reaching this state.
    const shadowed = lines(Effect.logInfo("MCP server log", { server: "s", level: "error" }))[0]
    expect(columns(shadowed ?? "").filter((name) => name === "level")).toHaveLength(2)
    expect(shadowed).toContain("level=INFO")
    expect(shadowed).toContain("level=error")
  })

  test("snapshot truncation keeps every budget dimension as a numeric field", () => {
    const [line] = lines(
      Log.event("snapshot.diff.compute.truncated", {
        "snapshot.files.total": 750,
        "snapshot.files.listed": 500,
        "snapshot.files.omitted": 250,
        "snapshot.files.computed": 300,
        "snapshot.diff.bytes": 4_194_304,
      }),
    )
    expect(line).toContain("level=WARN")
    expect(line).toContain("event=snapshot.diff.compute.truncated")
    expect(line).toContain('message="Snapshot.diffFull: change set too large; display is partial"')
    expect(line).toContain("snapshot.files.total=750")
    expect(line).toContain("snapshot.files.listed=500")
    expect(line).toContain("snapshot.files.omitted=250")
    expect(line).toContain("snapshot.files.computed=300")
    expect(line).toContain("snapshot.diff.bytes=4194304")
  })

  test("snapshot phases with the same English remain distinguishable by key", () => {
    const checkout = lines(
      Log.event("snapshot.restore.checkout.failed", {
        "snapshot.hash": "abc123",
        "snapshot.exit": 1,
        "snapshot.stderr": "checkout failed",
      }),
    )[0]
    const read = lines(
      Log.event("snapshot.restore.read.failed", {
        "snapshot.hash": "abc123",
        "snapshot.exit": 2,
        "snapshot.stderr": "read-tree failed",
      }),
    )[0]
    expect(checkout).toContain('message="failed to restore snapshot"')
    expect(read).toContain('message="failed to restore snapshot"')
    expect(checkout).toContain("event=snapshot.restore.checkout.failed")
    expect(read).toContain("event=snapshot.restore.read.failed")
    // A Git tree hash fingerprints user files; it is local-only text, not an egress-safe id.
    expect(mayEgress("snapshot.restore.read.failed")).toBe(false)
  })

  test("runner retries separate the provider fault from the stable event identity", () => {
    const [line] = lines(
      Log.event("session.provider.attempt.retry", {
        "session.id": "ses_1",
        attempt: 2,
        "session.attempts.max": 3,
        "session.provider.reason": "Transport",
        "session.provider.message": "connection refused at a private endpoint",
      }),
    )
    expect(line).toContain("event=session.provider.attempt.retry")
    expect(line).toContain('message="provider attempt failed — retrying"')
    expect(line).toContain("session.provider.reason=Transport")
    expect(line).toContain('session.provider.message="connection refused at a private endpoint"')
    expect(mayEgress("session.provider.attempt.retry")).toBe(false)
  })

  test("session revert failures retain their public reference without a reserved cause column", () => {
    const [line] = lines(
      Log.event("session.revert.stage.failed", {
        "session.id": "ses_1",
        "session.ref": "err_1234",
        "snapshot.operation": "preview",
        "snapshot.error": "private snapshot path failed",
      }),
    )
    expect(line).toContain("event=session.revert.stage.failed")
    expect(line).toContain('message="failed to stage session revert"')
    expect(line).toContain("session.ref=err_1234")
    expect(line).toContain("snapshot.operation=preview")
    expect(line).toContain('snapshot.error="private snapshot path failed"')
    expect(columns(line ?? "").filter((name) => name === "cause")).toEqual([])
    expect(mayEgress("session.revert.stage.failed")).toBe(false)
    expect(mayEgress("session.message.decode.failed")).toBe(true)
  })

  test("workspace transport and HTTP rejection share their English without sharing an identity", () => {
    const [transport] = lines(
      Log.event("workspace.target.request.failed", {
        "workspace.id": "wrk_1",
        "workspace.cause": "connection refused at a private endpoint",
      }),
    )
    const [rejected] = lines(
      Log.event("workspace.target.response.rejected", {
        "workspace.id": "wrk_1",
        "workspace.http.status": 403,
        "workspace.body": "private response body",
      }),
    )
    expect(transport).toContain("event=workspace.target.request.failed")
    expect(rejected).toContain("event=workspace.target.response.rejected")
    expect(transport).toContain('message="workspace target request failed"')
    expect(rejected).toContain('message="workspace target request failed"')
    expect(rejected).toContain("workspace.http.status=403")
    expect(mayEgress("workspace.target.request.failed")).toBe(false)
    expect(mayEgress("workspace.target.response.rejected")).toBe(false)
  })

  test("workspace replay bounds are typed while the source directory stays local", () => {
    const [line] = lines(
      Log.event("workspace.sync.replay.start", {
        "session.id": "ses_1",
        "workspace.events": 4,
        "workspace.sequence.first": 2,
        "workspace.sequence.last": 5,
        "workspace.directory": "/private/project",
      }),
    )
    expect(line).toContain("event=workspace.sync.replay.start")
    expect(line).toContain('message="sync replay requested"')
    expect(line).toContain("workspace.events=4")
    expect(line).toContain("workspace.sequence.first=2")
    expect(line).toContain("workspace.sequence.last=5")
    expect(mayEgress("workspace.sync.replay.start")).toBe(false)
    expect(mayEgress("workspace.sync.replay.ok")).toBe(true)
  })

  test("remote config URLs are structured but remain on the data plane", () => {
    const [line] = lines(Log.event("config.remote.fetch", { "config.url": "https://private.example/config" }), "Debug")
    expect(line).toContain("event=config.remote.fetch")
    expect(line).toContain('message="fetching remote config"')
    expect(line).toContain("config.url=https://private.example/config")
    expect(mayEgress("config.remote.fetch")).toBe(false)
  })

  test("config-write partial outcomes preserve arrays without exposing their content", () => {
    const [reload] = lines(
      Log.event("config.runtime.reload.failed", {
        "config.domains": '["agents","catalog"]',
        "config.causes": '["private materialisation fault"]',
      }),
    )
    const [restart] = lines(
      Log.event("config.runtime.restart.required", {
        "config.keys": '["plugins"]',
        "config.reasons": '["module cache cannot reload a private package"]',
      }),
    )
    expect(reload).toContain("event=config.runtime.reload.failed")
    expect(reload).toContain('message="a config write committed but the runtime could not re-materialise"')
    expect(reload).toContain("config.domains=")
    expect(reload).toContain("config.causes=")
    expect(restart).toContain("event=config.runtime.restart.required")
    expect(mayEgress("config.runtime.reload.failed")).toBe(false)
    expect(mayEgress("config.runtime.restart.required")).toBe(false)
    expect(mayEgress("config.offline.change")).toBe(false)
  })

  test("watcher fallback records both attempted and still-active ignore lists", () => {
    const [line] = lines(
      Log.event("filesystem.watcher.resubscribe.stale", {
        directory: "/private/project",
        "filesystem.ignore.attempted": '["new/**"]',
        "filesystem.ignore.active": '["old/**"]',
      }),
    )
    expect(line).toContain("event=filesystem.watcher.resubscribe.stale")
    expect(line).toContain("filesystem.ignore.attempted=")
    expect(line).toContain("filesystem.ignore.active=")
    expect(mayEgress("filesystem.watcher.resubscribe.stale")).toBe(false)
  })

  test("filesystem-search initialization failures name the directory but stay local", () => {
    const [line] = lines(
      Log.event("filesystem.search.init.failed", {
        "filesystem.directory": "/private/project",
        "filesystem.error": "native index unavailable",
      }),
    )
    expect(line).toContain("event=filesystem.search.init.failed")
    expect(line).toContain('message="failed to initialize fff"')
    expect(line).toContain("filesystem.directory=/private/project")
    expect(line).toContain('filesystem.error="native index unavailable"')
    expect(mayEgress("filesystem.search.init.failed")).toBe(false)
  })

  test("offline-policy events preserve host context without putting it on the maintenance plane", () => {
    const [active] = lines(
      Log.event("offline.policy.activate", {
        "offline.policy.hosts": '["private-model.example"]',
      }),
    )
    const [blocked] = lines(
      Log.event("offline.request.blocked", {
        "offline.request.url": "https://private.example/prompt",
        "offline.request.host": "private.example",
      }),
    )
    expect(active).toContain("event=offline.policy.activate")
    expect(active).toContain('message="offline mode ACTIVE — HTTP restricted to loopback + provider hosts"')
    expect(active).toContain("offline.policy.hosts=")
    expect(blocked).toContain("event=offline.request.blocked")
    expect(blocked).toContain('message="offline mode blocked outbound request"')
    expect(blocked).toContain("offline.request.url=https://private.example/prompt")
    expect(blocked).toContain("offline.request.host=private.example")
    expect(mayEgress("offline.policy.activate")).toBe(false)
    expect(mayEgress("offline.request.blocked")).toBe(false)
  })

  test("permission decisions separate their closed action from user-controlled patterns", () => {
    const [evaluated] = lines(
      Log.event("permission.rule.evaluate", {
        "permission.name": "bash",
        "permission.pattern": "private-command --token secret",
        "permission.action": "ask",
      }),
    )
    const [asking] = lines(
      Log.event("permission.request.ask", {
        "permission.request.id": "per_123",
        "permission.name": "bash",
        "permission.patterns": '["private-command --token secret"]',
      }),
    )
    expect(evaluated).toContain("event=permission.rule.evaluate")
    expect(evaluated).toContain("message=evaluated")
    expect(evaluated).toContain("permission.action=ask")
    expect(evaluated).toContain('permission.pattern="private-command --token secret"')
    expect(asking).toContain("event=permission.request.ask")
    expect(asking).toContain("message=asking")
    expect(asking).toContain("permission.request.id=per_123")
    expect(asking).toContain("permission.patterns=")
    expect(mayEgress("permission.rule.evaluate")).toBe(false)
    expect(mayEgress("permission.request.ask")).toBe(false)
  })

  test("PTY lifecycle fields stay structured and command content stays local", () => {
    const [created] = lines(
      Log.event("pty.session.create", {
        "pty.id": "pty_1",
        "pty.command": "/private/bin/my shell",
        "pty.arguments": '["--login","project name"]',
        "pty.directory": "/private/project",
      }),
    )
    const [exited] = lines(Log.event("pty.session.exit", { "pty.id": "pty_1", "pty.exit_code": 3 }))
    expect(created).toContain("event=pty.session.create")
    expect(created).toContain('message="creating session"')
    expect(created).toContain('pty.command="/private/bin/my shell"')
    expect(created).toContain('pty.arguments="[\\"--login\\",\\"project name\\"]"')
    expect(created).toContain("pty.directory=/private/project")
    expect(exited).toContain("pty.exit_code=3")
    expect(mayEgress("pty.session.create")).toBe(false)
    expect(mayEgress("pty.session.exit")).toBe(true)
  })

  test("an UN-keyed record is untouched — the 36 remaining call sites are not affected", () => {
    // 1a adds a column; it takes nothing away and rewrites nothing. This is the assertion that says
    // the wrapper is a column rather than a second system.
    const [line] = lines(Effect.logInfo("watcher backend", { directory: "/tmp/x", backend: "parcel" }))
    expect(columns(line ?? "")).toEqual(["timestamp", "level", "run", "message", "directory", "backend"])
    expect(line).not.toContain("event=")
  })

  test("a debug-level record is suppressed at INFO, as it is in production", () => {
    // §0.10: a level check must be free when the level is off. Nothing keyed changes that — the
    // wrapper is `Effect.log*`, so the existing `References.MinimumLogLevel` gate still decides.
    expect(lines(Effect.logDebug("quiet"), "Info")).toEqual([])
    expect(lines(Effect.logDebug("loud"), "Debug")).toHaveLength(1)
  })
})
