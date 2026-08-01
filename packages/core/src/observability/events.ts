/**
 * **THE closed log-event key set.** One dotted `subsystem.object.action[.outcome]` identifier per
 * event, declared once, here, and nowhere else.
 *
 * `todo/logging.md` item 1a. The finding that produced it (§0.3, measured against the real
 * `novaclaw.log`): the on-disk line is already machine-PARSEABLE — logfmt, `key=value` — but the
 * event itself is not machine-ADDRESSABLE, because the only thing naming it is `message=`, an
 * English sentence. `grep 'message="watcher backend"'` is not a query, it is a bet on nobody
 * rewording a string literal. Worse, one word can name two unrelated faults: `Effect.logError(
 * "failed", …)` appears in the HTTP error middleware AND in the formatter, with nothing on the line
 * to tell them apart. This file adds the stable column that a saved query, a telemetry cluster and
 * an agent's repair heuristic can key off.
 *
 * ── what this module is, and what it is NOT ─────────────────────────────────────────────────────
 *
 * It is **data with zero imports** — the same shape as `session/session-error.ts` and, deliberately,
 * the same shape as `jh/log.ts`, which has done exactly this since it was written: a stable machine
 * key carrying typed attributes, with the English generated FROM the key rather than being the
 * record. That convention worked and simply never escaped `jh/`. This is it escaping.
 *
 * It is **not a second logging system.** The wrapper that consumes it (`./log.ts`) calls
 * `Effect.log*` and nothing else, so every keyed record lands in the SAME logfmt line, through the
 * SAME formatter, into the SAME `novaclaw.log` as the ~230 un-keyed sites do today. A second file
 * writer beside `novaclaw.log` is the copy-paste-store defect this project keeps finding
 * (`todo/logging.md` §0.2); there is no second sink here and there must never be one.
 *
 * ── the four properties that make this a contract rather than a convention ──────────────────────
 *
 * 1. **Closed.** `EventKey` is `keyof typeof EVENTS`, so an undeclared key does not compile.
 * 2. **The subsystem is a PARSED FIELD, not a naming habit.** `subsystemOf()` reads the first
 *    segment and `SUBSYSTEMS` closes the set. That is what makes per-subsystem log levels
 *    (`todo/logging.md` 3b, Settings → Developer) a prefix match resolved once, rather than a second
 *    registry somebody has to keep in sync — and it is why the level check can stay free in the
 *    hot loops (§0.10).
 * 3. **The English lives WITH the key.** ⚠️ This is a deliberate departure from item 1b's sketched
 *    `Log.event(key, message, attrs)` signature, and the reason is the one 1b itself calls the acute
 *    case: 17 live sites interpolate values INTO the sentence
 *    (`` `discord: caught up ${N}+ missed messages in ${id}` ``), which makes `message=` a
 *    high-cardinality field and buries an attribute inside prose. A `message` PARAMETER leaves that
 *    door open at all 230 sites forever. Declaring the sentence here shuts it by construction: the
 *    only place a value can go is an attribute. It also means `message=` is constant per key — which
 *    is precisely what lets property 4 be decided per key at all — and it keeps today's
 *    `grep "MCP server log"` working through the whole migration, because the string is unchanged.
 * 4. **Redaction is in the record type, not in a downstream filter.** Every attribute declares a
 *    CLASS, and each class says whether that field may ever leave this machine. So "may this event
 *    egress?" is answered by the declaration, at authoring time — not by a scrubber run over a log
 *    that already captured a prompt, which is a leak with a delay (`todo/logging.md` 1f). The
 *    maintenance plane carries crash signatures; the data plane never egresses (AGENTS.md
 *    design-principle 4).
 *
 * ── how a key is chosen ─────────────────────────────────────────────────────────────────────────
 *
 *   `subsystem` · `object` · `action` · optional `outcome`
 *
 * Subsystem is the module family (closed set below). Object is the noun it acted on. Action is the
 * verb. Outcome is how it ended, and it exists so that one event with two endings is TWO keys with
 * two levels — `mcp.server.spawn.failed` at `warn`, `mcp.server.spawn.ok` at `debug` — rather than
 * one key whose severity varies. Which is also fix 1d: because the level is declared with the key,
 * a developer's debug print CANNOT ship at `error` without declaring a key that says so, and a
 * foreign process's severity (an MCP server relaying its own `error`) becomes an ATTRIBUTE under one
 * of our keys instead of a promotion into our severity space where it competes with our faults.
 *
 * ── the seed set is MEASURED, not invented ──────────────────────────────────────────────────────
 *
 * Every entry carries the `file` it was read from, and `packages/core/test/log-events.test.ts`
 * fails if that file does not exist or no longer contains the declared `message`. So this set cannot
 * fill up with aspirational keys for events nobody emits: a key exists because a call site exists.
 *
 * The seed is deliberately SMALL and it is not the finished vocabulary. It covers the seven message
 * strings that are 69% of every line in the real log (§0.3), plus the three sites `todo/logging.md`
 * §0.4 names as already-broken. Item 1b grows it subsystem by subsystem as it converts call sites;
 * the wrapper and registry shipped separately from that migration, and `mcp.server.output` became
 * the first converted site only after the shrink-only source ledger was in force.
 */

/**
 * **The closed subsystem set — the first segment of every key.**
 *
 * Small on purpose: `todo/logging.md` 3b renders one row per subsystem in Settings → Developer, and
 * a list a person scrolls is a list nobody uses. Grow it when a subsystem's first key is declared,
 * never in advance. The value is the human label that surface will show.
 */
export const SUBSYSTEMS = {
  config: "Configuration",
  filesystem: "Files and watchers",
  format: "Code formatters",
  instance: "Instance lifecycle",
  location: "Workspace locations",
  mcp: "MCP servers",
  server: "HTTP server",
  skill: "Skills",
} as const

/** The subsystem a key's first segment must name. */
export type Subsystem = keyof typeof SUBSYSTEMS

/**
 * The four levels on the wire. `minimumLogLevel()` in `./logging.ts` accepts exactly these, and
 * `todo/logging.md` §0.8 settles the count: six recurs across the industry, and six is already too
 * many for a product surface — the renderer's extra `notice` is a UI concern, not a wire severity.
 */
export type Level = "debug" | "info" | "warn" | "error"

/**
 * **What an attribute value is allowed to be, and whether it may leave this machine.**
 *
 * `egress: false` does not mean "scrub it later". It means an event carrying this class is
 * content-bearing, is written to the local log only, and can never be part of a crash signature.
 * Classifying at the FIELD is what makes that decision reviewable at authoring time.
 *
 * ⚠️ `path` is deliberately NOT egress-safe. A filesystem path carries the user's account name and
 * their project names; it reads like metadata and behaves like content.
 */
export const ATTRIBUTE_CLASSES = {
  /** An identifier we minted, or a value from a closed vocabulary: a session id, a backend name. */
  id: { egress: true, value: "string" },
  /** A number. */
  count: { egress: true, value: "number" },
  /** A boolean. */
  flag: { egress: true, value: "boolean" },
  /** A filesystem path — carries the user's account and project names. Never egresses. */
  path: { egress: false, value: "string" },
  /** Free text from a person, a model, or a foreign process. Never egresses. */
  text: { egress: false, value: "string" },
  /** Our own error text. Routinely embeds paths, payloads and prompts. Never egresses. */
  fault: { egress: false, value: "string" },
} as const

export type AttributeClass = keyof typeof ATTRIBUTE_CLASSES

/** The TypeScript value each attribute class admits, so a call site is typed by its key. */
export type AttributeValue = {
  readonly id: string
  readonly count: number
  readonly flag: boolean
  readonly path: string
  readonly text: string
  readonly fault: string
}

/**
 * Whether an event may EVER carry user content.
 *
 * Declared per key rather than only derived from its attributes, because the derivation alone would
 * let a key silently change class the day somebody adds a `text` field to it — which is exactly the
 * "bolt redaction on afterwards" failure. The test asserts the two agree, so the declaration is an
 * intent that cannot drift from the fact (the same shape as the version single-source pin).
 */
export type ContentClass = "none" | "user"

export type EventDeclaration = {
  /** The severity this event is always logged at. Not a call-site choice — see fix 1d above. */
  readonly level: Level
  /**
   * The English sentence. It becomes `message=` verbatim, so it stays greppable exactly as it is
   * today. A CONSTANT: no interpolation, ever — values belong in `attributes`.
   */
  readonly message: string
  /** Every attribute this event may carry, by name, with its class. */
  readonly attributes: Readonly<Record<string, AttributeClass>>
  /** May this event ever carry user content? Must agree with `attributes` — checked. */
  readonly content: ContentClass
  /** The source file this event was measured from. Checked to exist and to carry `message`. */
  readonly file: string
}

/**
 * **The line's own columns.** `./logging.ts` emits `timestamp`, `level`, `run`, then the message
 * parts, then `cause`, spans and annotations. An attribute reusing one of these names puts the key
 * on the line TWICE, and duplicate keys break the naive `grep`/`cut` mining that is this whole
 * item's requirement.
 *
 * ⚠️ **This was measured as a live defect, not invented.** On 2026-07-31, 39 single-line
 * `Effect.log` sites passed a field named `cause` (36) or `message` (3), and the MCP relay's
 * multi-line field object passed `level`, emitting `level=INFO … level=error` on one line. The MCP
 * collision is now fixed as `mcp.level`; the remaining names are 1b migration work. Declaring the
 * reserved set here makes every conversion prove its fix and stops the next collision being added.
 */
export const RESERVED_ATTRIBUTES: ReadonlyArray<string> = ["timestamp", "level", "run", "event", "message", "cause"]

/**
 * ── THE KEY SET ─────────────────────────────────────────────────────────────────────────────────
 *
 * Grouped by subsystem. Every entry names the file it was measured from, and the test proves that
 * file still carries the message.
 */
export const EVENTS = {
  // ── config ────────────────────────────────────────────────────────────────────────────────────
  /** The instance is reading a config document off disk. 929 lines in the measured corpus. */
  "config.file.load": {
    level: "info",
    message: "loading",
    attributes: { path: "path" },
    content: "user",
    file: "packages/novaclaw/src/config/config.ts",
  },

  // ── filesystem ────────────────────────────────────────────────────────────────────────────────
  /** Which watcher backend a location got. The single most frequent line in the corpus (1511). */
  "filesystem.watcher.start": {
    level: "info",
    message: "watcher backend",
    attributes: { directory: "path", platform: "id", backend: "id" },
    content: "user",
    file: "packages/core/src/filesystem/watcher.ts",
  },
  /** No watcher backend exists for this platform — the location runs without file events. */
  "filesystem.watcher.start.unsupported": {
    level: "error",
    message: "watcher backend not supported",
    attributes: { directory: "path", platform: "id" },
    content: "user",
    file: "packages/core/src/filesystem/watcher.ts",
  },

  // ── format ────────────────────────────────────────────────────────────────────────────────────
  /** The formatter registry finished loading. 1183 lines share the word `init` with `skill` (§0.4). */
  "format.registry.init": {
    level: "info",
    message: "init",
    attributes: {},
    content: "none",
    file: "packages/novaclaw/src/format/index.ts",
  },
  /** Formatting is switched off entirely for this instance. 1144 lines. */
  "format.registry.init.disabled": {
    level: "info",
    message: "all formatters are disabled",
    attributes: {},
    content: "none",
    file: "packages/novaclaw/src/format/index.ts",
  },
  /**
   * A formatter command exited non-zero.
   *
   * ⚠️ One of the TWO unrelated sites that both log the bare word `failed` — the miniature of this
   * whole item (`todo/logging.md` §0.4). The other is `server.request.fail` below. Same word, two
   * subsystems, and until this key existed nothing on the line could tell them apart.
   */
  "format.file.format.failed": {
    level: "error",
    message: "failed",
    attributes: { command: "id", "format.file": "path" },
    content: "user",
    file: "packages/novaclaw/src/format/index.ts",
  },

  // ── instance ──────────────────────────────────────────────────────────────────────────────────
  /** An instance began bootstrapping its services. 1146 lines. */
  "instance.bootstrap.start": {
    level: "info",
    message: "bootstrapping",
    attributes: { directory: "path" },
    content: "user",
    file: "packages/novaclaw/src/project/bootstrap.ts",
  },
  /** A directory had no instance yet, so one is being created. 1146 lines. */
  "instance.store.create": {
    level: "info",
    message: "creating instance",
    attributes: { directory: "path" },
    content: "user",
    file: "packages/novaclaw/src/project/instance-store.ts",
  },

  // ── location ──────────────────────────────────────────────────────────────────────────────────
  /** A location's service graph is being built. 1508 lines. */
  "location.services.boot": {
    level: "info",
    message: "booting location services",
    attributes: { directory: "path", workspaceID: "id" },
    content: "user",
    file: "packages/core/src/location-services.ts",
  },

  // ── mcp ───────────────────────────────────────────────────────────────────────────────────────
  /**
   * An MCP server relayed a log record of its own.
   *
   * Fix 1d, shipped: this sentence used to be logged at all four of OUR levels depending on what the
   * foreign server said, so a stranger's output could compete with our faults for the operator's
   * attention. The foreign severity is now an ATTRIBUTE (`mcp.level`) under one key at one level,
   * and the namespacing also lifts it off the line's own `level=` column.
   */
  "mcp.server.output": {
    level: "info",
    message: "MCP server log",
    attributes: { server: "id", "mcp.logger": "id", "mcp.level": "id", "mcp.data": "text" },
    content: "user",
    file: "packages/novaclaw/src/mcp/index.ts",
  },
  /** An MCP server's connection dropped; its tools are gone until it reconnects. */
  "mcp.connection.close": {
    level: "warn",
    message: "MCP connection closed",
    attributes: { server: "id" },
    content: "none",
    file: "packages/novaclaw/src/mcp/index.ts",
  },

  // ── server ────────────────────────────────────────────────────────────────────────────────────
  /**
   * The HTTP boundary turned a defect into a 500 and handed the caller a reference.
   *
   * The second `failed` site (see `format.file.format.failed`). `server.cause` is namespaced because
   * a bare `cause` would collide with the line's own `cause=` column.
   */
  "server.request.fail": {
    level: "error",
    message: "failed",
    attributes: { ref: "id", "server.error": "fault", "server.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/middleware/error.ts",
  },

  // ── skill ─────────────────────────────────────────────────────────────────────────────────────
  /** The skill registry finished loading. The other half of the `init` collision (§0.4). */
  "skill.registry.init": {
    level: "info",
    message: "init",
    attributes: { count: "count" },
    content: "none",
    file: "packages/novaclaw/src/skill/index.ts",
  },
} as const satisfies Record<string, EventDeclaration>

/** The closed key set as a literal union. An undeclared key does not compile. */
export type EventKey = keyof typeof EVENTS

/**
 * The attributes a given key accepts, typed by their declared classes. This is what makes the
 * redaction classification bite at the call site rather than in a review: a field is not merely
 * named, it is classified, and the class decides both its TypeScript type and whether it egresses.
 */
export type Attributes<K extends EventKey> = {
  readonly [Name in keyof (typeof EVENTS)[K]["attributes"]]: AttributeValue[(typeof EVENTS)[K]["attributes"][Name] &
    AttributeClass]
}

/** Every declared key, sorted. */
export const keys = (): ReadonlyArray<EventKey> => (Object.keys(EVENTS) as EventKey[]).sort()

/**
 * **The grammar.** `subsystem.object.action` with an optional fourth `outcome` segment; segments are
 * lowercase alphanumeric and may not be empty.
 *
 * Exported and pure so the test can drive it over synthetic keys — a validator that can only ever be
 * run against inputs it already accepts proves nothing (AGENTS.md pitfall #-1: a counter that can
 * lie about the thing it counts is worse than no counter).
 */
export const KEY_GRAMMAR = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2,3}$/

/** Why `key` is not a well-formed event key, or `undefined` when it is. */
export function keyFault(key: string): string | undefined {
  if (!KEY_GRAMMAR.test(key))
    return `"${key}" is not subsystem.object.action[.outcome] — 3 or 4 lowercase alphanumeric segments`
  const subsystem = key.slice(0, key.indexOf("."))
  if (!(subsystem in SUBSYSTEMS))
    return `"${key}" starts with "${subsystem}", which is not a declared subsystem — add it to SUBSYSTEMS or rename the key`
  return undefined
}

/**
 * **The subsystem, PARSED.** Not a string search over the whole key and not a second registry: the
 * first segment, read once. `todo/logging.md` 3b's per-subsystem levels and §0.10's "a level check
 * must be free when the level is off" both depend on this being a field rather than a convention.
 *
 * Typed to return `Subsystem` for a declared key; every declared key is checked to satisfy that.
 */
export function subsystemOf(key: EventKey): Subsystem
export function subsystemOf(key: string): Subsystem | undefined
export function subsystemOf(key: string): Subsystem | undefined {
  const first = key.slice(0, key.indexOf("."))
  return first in SUBSYSTEMS ? (first as Subsystem) : undefined
}

/**
 * The content class an event's ATTRIBUTES actually imply: content-free only when every field may
 * egress. Compared against the declared `content` by the test, so intent and fact cannot diverge.
 */
export function derivedContent(declaration: EventDeclaration): ContentClass {
  const classes = Object.values(declaration.attributes)
  return classes.every((name) => ATTRIBUTE_CLASSES[name].egress) ? "none" : "user"
}

/**
 * Whether this event may leave the machine at all — the precondition for `todo/logging.md` 1f's
 * filter and for anything the maintenance plane carries. Nothing consumes it yet, by design: the
 * point of 1a is that the answer EXISTS in the type before a later slice needs it.
 */
export const mayEgress = (key: EventKey): boolean => EVENTS[key].content === "none"

export * as LogEvents from "./events"
