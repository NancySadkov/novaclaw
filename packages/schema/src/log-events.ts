/**
 * Canonical cross-package log-event contract.
 *
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
 * SAME formatter, into the SAME `novaclaw.log` as the still-unkeyed sites do today. A second file
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
 *    case: the seed had 17 sites that interpolate values INTO the sentence
 *    (`` `discord: caught up ${N}+ missed messages in ${id}` ``), which makes `message=` a
 *    high-cardinality field and buries an attribute inside prose. A `message` PARAMETER leaves that
 *    door open at every remaining site forever. Declaring the sentence here shuts it by construction: the
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
 * The registry began as a deliberately small measured seed and grows only through ledger-backed,
 * subsystem-by-subsystem migrations. `mcp.server.output` became the first converted site only after
 * the shrink-only source ledger was in force; the four `patch.file.*` template-literal sites followed
 * as the first whole-subsystem vocabulary pass. Every later pass keeps the same rule: declare only
 * events a live call site emits, and remove exactly those sites from the source ledger.
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
  credential: "Credentials",
  filesystem: "Files and watchers",
  format: "Code formatters",
  git: "Version control",
  instance: "Instance lifecycle",
  kb: "Knowledge",
  location: "Workspace locations",
  llm: "Model protocols",
  messenger: "Messenger",
  mcp: "MCP servers",
  offline: "Offline mode",
  patch: "File changes",
  permission: "Permissions",
  plugin: "Plugins",
  pty: "Terminal sessions",
  question: "Questions",
  resource: "Host resources",
  server: "HTTP server",
  session: "Sessions and agent turns",
  skill: "Skills",
  snapshot: "Snapshots",
  storage: "Storage migrations",
  tool: "Tools",
  worktree: "Worktrees",
  workspace: "Remote workspaces",
} as const

/** The subsystem a key's first segment must name. */
export type Subsystem = keyof typeof SUBSYSTEMS

/**
 * The four levels on the wire. Core's `observability/logging.ts` accepts exactly these, and
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
 * **The line's own columns.** Core's `observability/logging.ts` emits `timestamp`, `level`, `run`,
 * then the message
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
  /** Inline configuration supplied explicitly through the environment was loaded. */
  "config.content.load": {
    level: "debug",
    message: "loaded custom config from NOVACLAW_CONFIG_CONTENT",
    attributes: {},
    content: "none",
    file: "packages/novaclaw/src/config/config.ts",
  },
  /** The instance is loading resources from its explicit configuration directory. */
  "config.directory.load": {
    level: "debug",
    message: "loading config from NOVACLAW_CONFIG_DIR",
    attributes: { "config.directory": "path" },
    content: "user",
    file: "packages/novaclaw/src/config/config.ts",
  },
  /** Installing dependencies declared by one configuration directory failed in the background. */
  "config.dependency.install.failed": {
    level: "warn",
    message: "background dependency install failed",
    attributes: { "config.directory": "path", "config.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/config/config.ts",
  },
  /** The instance is reading a config document off disk. 929 lines in the measured corpus. */
  "config.file.load": {
    level: "info",
    message: "loading",
    attributes: { path: "path" },
    content: "user",
    file: "packages/novaclaw/src/config/config.ts",
  },
  /** The store-backed global configuration could not load, so safe defaults were used. */
  "config.global.load.failed": {
    level: "error",
    message: "failed to load global config, using defaults",
    attributes: { "config.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/config/config.ts",
  },
  /** A committed config write changed the live process-wide airgap policy. */
  "config.offline.change": {
    level: "info",
    message: "offline policy changed by a config write",
    attributes: { "config.offline.enabled": "flag", "config.offline.hosts": "text" },
    content: "user",
    file: "packages/core/src/config-store-write.ts",
  },
  /** The legacy permission environment override was malformed and was skipped. */
  "config.permission.parse.failed": {
    level: "warn",
    message: "NOVACLAW_PERMISSION contains invalid JSON, skipping",
    attributes: { "config.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/config/config.ts",
  },
  /** One well-known or delegated remote configuration document is being fetched. */
  "config.remote.fetch": {
    level: "debug",
    message: "fetching remote config",
    attributes: { "config.url": "text" },
    content: "user",
    file: "packages/novaclaw/src/config/config.ts",
  },
  /** A provider's well-known remote configuration was decoded and merged. */
  "config.remote.load.ok": {
    level: "debug",
    message: "loaded remote config from well-known",
    attributes: { "config.url": "text" },
    content: "user",
    file: "packages/novaclaw/src/config/config.ts",
  },
  /** A config write committed, but one or more live runtime domains could not re-materialise it. */
  "config.runtime.reload.failed": {
    level: "error",
    message: "a config write committed but the runtime could not re-materialise",
    attributes: { "config.domains": "text", "config.causes": "fault" },
    content: "user",
    file: "packages/core/src/config-store-write.ts",
  },
  /** A durable config change cannot become live until this instance restarts. */
  "config.runtime.restart.required": {
    level: "warn",
    message: "a config write is stored but NOT LIVE until this instance restarts",
    attributes: { "config.keys": "text", "config.reasons": "text" },
    content: "user",
    file: "packages/core/src/config-store-write.ts",
  },
  /** One or more stored config rows were unreadable; valid peers remain available. */
  "config.store.read.degraded": {
    level: "warn",
    message:
      "stored config rows failed validation and are unavailable; every other row still loaded. Fix or delete the named rows in the Registry app.",
    attributes: {
      "config.kind": "id",
      "config.table": "id",
      "config.invalid": "count",
      "config.rows": "text",
    },
    content: "user",
    file: "packages/core/src/config-store-factory.ts",
  },
  /** The OS username could not be read, so the stable friendly fallback was used. */
  "config.username.read.failed": {
    level: "warn",
    message: "failed to read system username, using fallback",
    attributes: { "config.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/config/config.ts",
  },

  // ── credential ────────────────────────────────────────────────────────────────────────────────
  /** The durable credential key could not be loaded or created; credential I/O stays disabled. */
  "credential.cipher.load.failed": {
    level: "error",
    message: "Credential encryption is unavailable; credential reads and writes are disabled.",
    attributes: { "credential.cause": "fault" },
    content: "user",
    file: "packages/core/src/credential-cipher.ts",
  },

  // ── filesystem ────────────────────────────────────────────────────────────────────────────────
  /** The native fast-file-finder could not initialize; search degrades to empty results. */
  "filesystem.search.init.failed": {
    level: "warn",
    message: "failed to initialize fff",
    attributes: { "filesystem.directory": "path", "filesystem.error": "fault" },
    content: "user",
    file: "packages/core/src/filesystem/search.ts",
  },
  /** The watcher service could not initialize and the location continues without file events. */
  "filesystem.watcher.init.failed": {
    level: "error",
    message: "failed to init watcher service",
    attributes: { "filesystem.cause": "fault" },
    content: "user",
    file: "packages/core/src/filesystem/watcher.ts",
  },
  /** A live OS watcher subscription could not be released during reconciliation. */
  "filesystem.watcher.release.failed": {
    level: "error",
    message: "watcher: failed to release a subscription",
    attributes: { directory: "path", "filesystem.cause": "fault" },
    content: "user",
    file: "packages/core/src/filesystem/watcher.ts",
  },
  /** Reconciliation itself failed before it could settle all watcher subscriptions. */
  "filesystem.watcher.resubscribe.failed": {
    level: "error",
    message: "watcher: re-subscribe failed",
    attributes: { directory: "path", "filesystem.cause": "fault" },
    content: "user",
    file: "packages/core/src/filesystem/watcher.ts",
  },
  /** A replacement subscription failed, so the prior ignore list remains authoritative. */
  "filesystem.watcher.resubscribe.stale": {
    level: "error",
    message: "watcher: re-subscribe failed — the PREVIOUS ignore list is still in force",
    attributes: {
      directory: "path",
      "filesystem.ignore.attempted": "text",
      "filesystem.ignore.active": "text",
    },
    content: "user",
    file: "packages/core/src/filesystem/watcher.ts",
  },
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
  /** The OS watcher backend could not establish a subscription for one directory. */
  "filesystem.watcher.subscribe.failed": {
    level: "error",
    message: "failed to subscribe",
    attributes: { directory: "path", "filesystem.cause": "fault" },
    content: "user",
    file: "packages/core/src/filesystem/watcher.ts",
  },

  // ── format ────────────────────────────────────────────────────────────────────────────────────
  /** One configured formatter command is about to run for a file. */
  "format.command.run": {
    level: "info",
    message: "running",
    attributes: { "format.file": "path", "format.command": "text" },
    content: "user",
    file: "packages/novaclaw/src/format/index.ts",
  },
  /** A formatter command exited non-zero. */
  "format.file.format.failed": {
    level: "error",
    message: "failed",
    attributes: { "format.file": "path", "format.command": "text", "format.environment": "text" },
    content: "user",
    file: "packages/novaclaw/src/format/index.ts",
  },
  /** The formatter process could not be spawned. */
  "format.file.spawn.failed": {
    level: "error",
    message: "failed to format file",
    attributes: {
      "format.file": "path",
      "format.command": "text",
      "format.environment": "text",
      "format.cause": "fault",
    },
    content: "user",
    file: "packages/novaclaw/src/format/index.ts",
  },
  /** Formatting was requested for one file. */
  "format.file.start": {
    level: "info",
    message: "formatting",
    attributes: { "format.file": "path" },
    content: "user",
    file: "packages/novaclaw/src/format/index.ts",
  },
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

  // ── git ───────────────────────────────────────────────────────────────────────────────────────
  /** A tree diff exceeded its bounded patch budget; remaining files carry omission markers. */
  "git.tree.diff.truncated": {
    level: "warn",
    message: "Git.tree.diff:",
    attributes: { "git.files": "count", "git.computed": "count", "git.bytes": "count" },
    content: "none",
    file: "packages/core/src/git.ts",
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
  /** One optional instance service failed to initialize; the remaining services continue. */
  "instance.bootstrap.service.failed": {
    level: "warn",
    message: "init failed",
    attributes: { "instance.cause": "fault" },
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
  /** One cached instance is about to be disposed. */
  "instance.store.dispose": {
    level: "info",
    message: "disposing instance",
    attributes: { directory: "path" },
    content: "user",
    file: "packages/novaclaw/src/project/instance-store.ts",
  },
  /** Every cached instance is about to be disposed. */
  "instance.store.dispose.all": {
    level: "info",
    message: "disposing all instances",
    attributes: {},
    content: "none",
    file: "packages/novaclaw/src/project/instance-store.ts",
  },
  /** An instance entry failed before bulk disposal could obtain its context. */
  "instance.store.dispose.failed": {
    level: "warn",
    message: "instance dispose failed",
    attributes: { directory: "path", "instance.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/project/instance-store.ts",
  },
  /** One cached instance is being replaced with a fresh context. */
  "instance.store.reload": {
    level: "info",
    message: "reloading instance",
    attributes: { directory: "path" },
    content: "user",
    file: "packages/novaclaw/src/project/instance-store.ts",
  },

  // ── kb ────────────────────────────────────────────────────────────────────────────────────────
  /** The optional in-process graph could not open; memory stays safely degraded. */
  "kb.memory.open.failed": {
    level: "warn",
    message: "kb-memory failed to open:",
    attributes: { "kb.cause": "fault" },
    content: "user",
    file: "packages/core/src/kb-graph/memory.ts",
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

  // ── llm ───────────────────────────────────────────────────────────────────────────────────────
  /** A protocol request exceeded its provider's cache-breakpoint cap; excess markers were dropped. */
  "llm.cache.breakpoint.truncated": {
    level: "warn",
    message: "cache breakpoints beyond the protocol limit were dropped",
    attributes: { "llm.protocol": "id", "llm.dropped": "count", "llm.limit": "count" },
    content: "none",
    file: "packages/llm/src/protocols/anthropic-messages.ts",
  },

  // ── messenger ─────────────────────────────────────────────────────────────────────────────────
  /** Account reconciliation is skipped because its durable account list could not be read. */
  "messenger.account.reconcile.skipped": {
    level: "warn",
    message:
      "messenger: skipping reconcile — the account table could not be read; live connections are left exactly as they are",
    attributes: {},
    content: "none",
    file: "packages/core/src/messenger/gateway.ts",
  },
  /** An operator's self-chat was attached to a newly created console session. */
  "messenger.console.bind.created": {
    level: "info",
    message: "messenger: bound the self-chat to a fresh console session",
    attributes: { "messenger.account_label": "text" },
    content: "user",
    file: "packages/core/src/messenger/gateway.ts",
  },
  /** Discord's bounded reconnect fetch filled one page, so older messages may remain unavailable. */
  "messenger.discord.backfill.truncated": {
    level: "info",
    message: "discord: caught up missed messages; older ones beyond the page were skipped",
    attributes: { "messenger.limit": "count", "messenger.chat": "text" },
    content: "user",
    file: "packages/core/src/messenger/driver/discord.ts",
  },
  /** The explicitly opted-in WhatsApp/Baileys driver was loaded into the registry. */
  "messenger.driver.whatsapp.enabled": {
    level: "info",
    message: "messenger: WhatsApp (Baileys) driver enabled",
    attributes: {},
    content: "none",
    file: "packages/novaclaw/src/messenger/external-driver-source.ts",
  },
  /** The singleton instance-global messenger gateway is starting. */
  "messenger.gateway.start": {
    level: "info",
    message: "messenger gateway starting",
    attributes: {},
    content: "none",
    file: "packages/core/src/messenger/gateway.ts",
  },
  /** An inbound message is refused because the durable route could not be read. */
  "messenger.inbound.route.rejected": {
    level: "warn",
    message:
      "messenger: cannot route inbound — the messenger database could not be read; the message was not delivered",
    attributes: { "messenger.route": "text" },
    content: "user",
    file: "packages/core/src/messenger/gateway.ts",
  },
  /** A best-effort operator notice could not be delivered through a connected account. */
  "messenger.operator.notice.failed": {
    level: "warn",
    message: "messenger: could not deliver an operator notice",
    attributes: {
      "messenger.chat": "text",
      "messenger.account": "id",
      "messenger.failure": "fault",
    },
    content: "user",
    file: "packages/core/src/messenger/gateway.ts",
  },
  /** No connected operator binding exists, so only the durable Settings banner carries a notice. */
  "messenger.operator.notice.unbound": {
    level: "info",
    message: "messenger: no connected operator chat to notify — the Settings banner carries the notice alone",
    attributes: {},
    content: "none",
    file: "packages/core/src/messenger/gateway.ts",
  },
  /** A MessengerStore read failed instead of fabricating an empty answer. */
  "messenger.store.read.failed": {
    level: "warn",
    message: "MessengerStore: the messenger database could not be read",
    attributes: { "messenger.operation": "text", "messenger.cause": "fault" },
    content: "user",
    file: "packages/core/src/messenger/store.ts",
  },

  // ── mcp ───────────────────────────────────────────────────────────────────────────────────────
  /** A remote MCP server cannot authenticate until the operator supplies a registered OAuth client id. */
  "mcp.auth.registration.required": {
    level: "warn",
    message: "MCP server requires a pre-registered client ID",
    attributes: { server: "id" },
    content: "none",
    file: "packages/novaclaw/src/mcp/index.ts",
  },
  /** A remote MCP server requires the operator to complete its authentication flow. */
  "mcp.auth.required": {
    level: "warn",
    message: "MCP server requires authentication",
    attributes: { server: "id", "mcp.hint": "text" },
    content: "user",
    file: "packages/novaclaw/src/mcp/index.ts",
  },
  /** Listing one kind of catalog entry failed; the other connected servers remain usable. */
  "mcp.catalog.list.failed": {
    level: "warn",
    message: "failed to get MCP catalog entries",
    attributes: { server: "id", "mcp.catalog": "id", "mcp.error": "fault" },
    content: "user",
    file: "packages/novaclaw/src/mcp/catalog.ts",
  },
  /** One advertised MCP prompt could not be resolved into its command template. */
  "mcp.prompt.resolve.failed": {
    level: "warn",
    message: "MCP prompt resolution failed",
    attributes: { "mcp.prompt": "text", "mcp.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/mcp/external-command-source.ts",
  },
  /** MCP prompts are unavailable for a location, so its command source degrades to empty. */
  "mcp.command.prompts.unavailable": {
    level: "debug",
    message: "MCP prompts unavailable for V2 location",
    attributes: { directory: "path", "mcp.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/mcp/external-command-source.ts",
  },
  /** A config entry lacks the discriminator needed to decode an MCP server. */
  "mcp.config.entry.invalid": {
    level: "error",
    message: "Ignoring MCP config entry without type",
    attributes: { server: "id" },
    content: "none",
    file: "packages/novaclaw/src/mcp/index.ts",
  },
  /** A config write added or changed an enabled MCP server, so its replacement is connecting. */
  "mcp.config.server.connecting": {
    level: "info",
    message: "MCP server added or changed by a config write — connecting",
    attributes: { server: "id" },
    content: "none",
    file: "packages/novaclaw/src/mcp/index.ts",
  },
  /** A config write disabled an MCP server and its live client is being closed. */
  "mcp.config.server.disabled": {
    level: "info",
    message: "MCP server disabled by a config write",
    attributes: { server: "id" },
    content: "none",
    file: "packages/novaclaw/src/mcp/index.ts",
  },
  /** A config write removed an MCP server and its live client is being forgotten. */
  "mcp.config.server.removed": {
    level: "info",
    message: "MCP server removed by a config write",
    attributes: { server: "id" },
    content: "none",
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
  /** A request named a server that has no connected client. */
  "mcp.request.client.missing": {
    level: "warn",
    message: "MCP client not found for request",
    attributes: { server: "id", "mcp.operation": "id" },
    content: "none",
    file: "packages/novaclaw/src/mcp/index.ts",
  },
  /** A request reached a connected MCP client but the remote operation failed. */
  "mcp.request.failed": {
    level: "error",
    message: "MCP request failed",
    attributes: { server: "id", "mcp.operation": "id", "mcp.target": "text", "mcp.error": "fault" },
    content: "user",
    file: "packages/novaclaw/src/mcp/index.ts",
  },
  /** An MCP server could not reach the connected state during creation. */
  "mcp.server.unavailable": {
    level: "warn",
    message: "MCP server unavailable",
    attributes: { server: "id", "mcp.transport": "id", "mcp.status": "id" },
    content: "none",
    file: "packages/novaclaw/src/mcp/index.ts",
  },
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
  /** A connected server has no cached tool definitions, so it contributes no tools. */
  "mcp.tool.cache.missing": {
    level: "warn",
    message: "missing cached tools for connected server",
    attributes: { server: "id" },
    content: "none",
    file: "packages/novaclaw/src/mcp/index.ts",
  },
  /** MCP tools are unavailable for a location, so its tool source degrades to empty. */
  "mcp.tool.source.unavailable": {
    level: "debug",
    message: "MCP tools unavailable for V2 location",
    attributes: { directory: "path", "mcp.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/mcp/external-tool-source.ts",
  },

  // ── offline ───────────────────────────────────────────────────────────────────────────────────
  /** Offline mode engaged its HTTP allowlist policy. */
  "offline.policy.activate": {
    level: "info",
    message: "offline mode ACTIVE — HTTP restricted to loopback + provider hosts",
    attributes: { "offline.policy.hosts": "text" },
    content: "user",
    file: "packages/core/src/offline.ts",
  },
  /** Offline mode refused a non-allowlisted outbound HTTP request. */
  "offline.request.blocked": {
    level: "warn",
    message: "offline mode blocked outbound request",
    attributes: { "offline.request.url": "text", "offline.request.host": "text" },
    content: "user",
    file: "packages/core/src/offline.ts",
  },

  // ── patch ─────────────────────────────────────────────────────────────────────────────────────
  /** A patch created a file. The path used to be interpolated into `message=`. */
  "patch.file.add": {
    level: "info",
    message: "Added file:",
    attributes: { "patch.file": "path" },
    content: "user",
    file: "packages/novaclaw/src/patch/index.ts",
  },
  /** A patch removed a file. The path used to be interpolated into `message=`. */
  "patch.file.delete": {
    level: "info",
    message: "Deleted file:",
    attributes: { "patch.file": "path" },
    content: "user",
    file: "packages/novaclaw/src/patch/index.ts",
  },
  /** A patch moved a file, possibly while changing its contents. */
  "patch.file.move": {
    level: "info",
    message: "Moved file:",
    attributes: { "patch.from": "path", "patch.to": "path" },
    content: "user",
    file: "packages/novaclaw/src/patch/index.ts",
  },
  /** A patch changed a file in place. The path used to be interpolated into `message=`. */
  "patch.file.update": {
    level: "info",
    message: "Updated file:",
    attributes: { "patch.file": "path" },
    content: "user",
    file: "packages/novaclaw/src/patch/index.ts",
  },

  // ── permission ────────────────────────────────────────────────────────────────────────────────
  /** A permission request is waiting for the user's decision. */
  "permission.request.ask": {
    level: "info",
    message: "asking",
    attributes: { "permission.request.id": "id", "permission.name": "text", "permission.patterns": "text" },
    content: "user",
    file: "packages/novaclaw/src/permission/index.ts",
  },
  /** One requested pattern was evaluated against the effective permission rules. */
  "permission.rule.evaluate": {
    level: "info",
    message: "evaluated",
    attributes: { "permission.name": "text", "permission.pattern": "text", "permission.action": "id" },
    content: "user",
    file: "packages/novaclaw/src/permission/index.ts",
  },

  // ── plugin ────────────────────────────────────────────────────────────────────────────────────
  /** One plugin event handler failed; its subscription continues. */
  "plugin.event.delivery.failed": {
    level: "error",
    message: "Plugin event handler failed",
    attributes: { "plugin.event.type": "id", "plugin.event.id": "id", "plugin.cause": "fault" },
    content: "user",
    file: "packages/core/src/plugin/host.ts",
  },
  /** A subscriber's bounded event queue was full, so one event was dropped. */
  "plugin.event.dropped": {
    level: "warn",
    message: "Plugin event dropped — subscriber buffer full",
    attributes: { "plugin.event.type": "id", "plugin.event.id": "id", "plugin.event.capacity": "count" },
    content: "none",
    file: "packages/core/src/plugin/host.ts",
  },
  /** A plugin event subscription stopped outside normal interruption. */
  "plugin.event.subscription.stopped": {
    level: "error",
    message: "Plugin event subscription stopped",
    attributes: { "plugin.event.type": "id", "plugin.cause": "fault" },
    content: "user",
    file: "packages/core/src/plugin/host.ts",
  },
  /** A plugin subscribed to a public event that the kernel bus cannot publish. */
  "plugin.event.subscription.unsupported": {
    level: "warn",
    message: "Plugin subscribed to an event type the kernel never publishes",
    attributes: { "plugin.event.type": "id" },
    content: "none",
    file: "packages/core/src/plugin/host.ts",
  },
  /** One external plugin could not be imported or decoded; its peers remain available. */
  "plugin.external.load.failed": {
    level: "warn",
    message: "external plugin failed to load and is UNAVAILABLE — every other plugin still loaded",
    attributes: { "plugin.package": "text", "plugin.cause": "fault" },
    content: "user",
    file: "packages/core/src/config/plugin/external.ts",
  },

  // ── pty ──────────────────────────────────────────────────────────────────────────────────────
  /** A client began receiving retained and live output from a running terminal session. */
  "pty.client.attach": {
    level: "info",
    message: "client attached to session",
    attributes: { "pty.id": "id", "pty.directory": "path" },
    content: "user",
    file: "packages/core/src/pty.ts",
  },
  /** A terminal process is about to be spawned. */
  "pty.session.create": {
    level: "info",
    message: "creating session",
    attributes: { "pty.id": "id", "pty.command": "text", "pty.arguments": "text", "pty.directory": "path" },
    content: "user",
    file: "packages/core/src/pty.ts",
  },
  /** A terminal process exited and its retained session became inactive. */
  "pty.session.exit": {
    level: "info",
    message: "session exited",
    attributes: { "pty.id": "id", "pty.exit_code": "count" },
    content: "none",
    file: "packages/core/src/pty.ts",
  },
  /** A retained terminal session is being removed. */
  "pty.session.remove": {
    level: "info",
    message: "removing session",
    attributes: { "pty.id": "id" },
    content: "none",
    file: "packages/core/src/pty.ts",
  },

  // ── question ──────────────────────────────────────────────────────────────────────────────────
  /** A session is waiting for answers to one or more questions. */
  "question.request.ask": {
    level: "info",
    message: "asking",
    attributes: { "question.request": "id", "question.count": "count" },
    content: "none",
    file: "packages/novaclaw/src/question/index.ts",
  },
  /** The user rejected a pending question request. */
  "question.request.reject": {
    level: "info",
    message: "rejected",
    attributes: { "question.request": "id" },
    content: "none",
    file: "packages/novaclaw/src/question/index.ts",
  },
  /** A rejection named no pending question request. */
  "question.request.reject.unknown": {
    level: "warn",
    message: "reject for unknown request",
    attributes: { "question.request": "id" },
    content: "none",
    file: "packages/novaclaw/src/question/index.ts",
  },
  /** The user answered a pending question request. */
  "question.request.reply": {
    level: "info",
    message: "replied",
    attributes: { "question.request": "id", "question.answers": "text" },
    content: "user",
    file: "packages/novaclaw/src/question/index.ts",
  },
  /** A reply named no pending question request. */
  "question.request.reply.unknown": {
    level: "warn",
    message: "reply for unknown request",
    attributes: { "question.request": "id" },
    content: "none",
    file: "packages/novaclaw/src/question/index.ts",
  },

  // ── resource ──────────────────────────────────────────────────────────────────────────────────
  /** Host memory/disk headroom could not be measured; the model receives an unavailable notice. */
  "resource.headroom.measure.failed": {
    level: "warn",
    message: "Resource headroom measurement failed:",
    attributes: { "resource.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/storage/resource-pressure-context.ts",
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

  // ── session ───────────────────────────────────────────────────────────────────────────────────
  "session.changes.refresh.failed": {
    level: "warn",
    message: "changes-summary refresh failed",
    attributes: { "session.id": "id", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.compaction.manual.failed": {
    level: "error",
    message: "manual compaction failed",
    attributes: { "session.id": "id", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.compaction.manual.settled": {
    level: "info",
    message: "manual compaction settled",
    attributes: { "session.id": "id", compacted: "flag" },
    content: "none",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.context.pack.evicted": {
    level: "warn",
    message: "context pack evicted history from the outgoing request",
    attributes: {
      "session.id": "id",
      "session.dropped": "count",
      "session.kept.tokens": "count",
      "session.context.size": "count",
    },
    content: "none",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.context.pressure.high": {
    level: "warn",
    message: "ctx_pressure: real prompt near the context window",
    attributes: {
      "session.id": "id",
      "session.prompt.tokens": "count",
      "session.estimated.tokens": "count",
      "session.context.size": "count",
    },
    content: "none",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.control.operator": {
    level: "info",
    message: "session under operator control — Nova is not responding",
    attributes: { "session.id": "id" },
    content: "none",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.doom.runaway.detected": {
    level: "info",
    message: "doom-loop runaway self-check",
    attributes: { "session.id": "id", "session.tool.calls": "count" },
    content: "none",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.doom.streak.detected": {
    level: "info",
    message: "doom-loop failure streak",
    attributes: {
      "session.id": "id",
      "session.tool": "id",
      "session.target": "text",
      count: "count",
    },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.drain.exit": {
    level: "info",
    message: "exit(result) recorded — stopping the drain",
    attributes: { "session.id": "id", step: "count" },
    content: "none",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.drive.cap.reached": {
    level: "warn",
    message: "self-drive cap reached",
    attributes: { "session.id": "id", rounds: "count" },
    content: "none",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.drive.continue": {
    level: "info",
    message: "self-drive continuation",
    attributes: { "session.id": "id", round: "count" },
    content: "none",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.finish.recover": {
    level: "info",
    message: "finish recovery: provider truncated at its output-token limit",
    attributes: { "session.id": "id", step: "count", recoveries: "count" },
    content: "none",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.finish.recover.paused": {
    level: "warn",
    message: "finish recovery: truncated twice — pausing the drain",
    attributes: { "session.id": "id", step: "count" },
    content: "none",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.finish.reground": {
    level: "info",
    message: "finish re-grounding nudge",
    attributes: { "session.id": "id" },
    content: "none",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.introspection.interject": {
    level: "info",
    message: "introspection interjecting",
    attributes: { "session.id": "id" },
    content: "none",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.introspection.judge.failed": {
    level: "warn",
    message: "introspection judge failed",
    attributes: { "session.id": "id", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.memory.extract.empty": {
    level: "warn",
    message: "memory extraction: model returned an empty completion",
    attributes: { "session.id": "id" },
    content: "none",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.memory.extract.failed": {
    level: "warn",
    message: "memory extraction failed",
    attributes: { "session.id": "id", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.memory.invalidate.stale": {
    level: "info",
    message: "invalidated recalled file memories after a confirmed missing-path read",
    attributes: { "session.id": "id", "session.memory.invalidated": "count" },
    content: "none",
    file: "packages/core/src/session/runner/llm.ts",
  },
  /** A stored session message could not be decoded for an API response. */
  "session.message.decode.failed": {
    level: "error",
    message: "failed to decode session message",
    attributes: { "session.id": "id", "session.message": "id", "session.ref": "id" },
    content: "none",
    file: "packages/server/src/handlers/session.ts",
  },
  "session.provider.attempt.retry": {
    level: "warn",
    message: "provider attempt failed — retrying",
    attributes: {
      "session.id": "id",
      attempt: "count",
      "session.attempts.max": "count",
      "session.provider.reason": "id",
      "session.provider.message": "fault",
    },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.provider.response.broken": {
    level: "warn",
    message: "provider response ended before its final frame",
    attributes: {
      "session.id": "id",
      "session.provider.reason": "id",
      "session.provider.message": "fault",
    },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.quality.check.errored": {
    level: "warn",
    message: "quality check errored",
    attributes: { "session.id": "id", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.quality.check.failed": {
    level: "info",
    message: "quality check FAILED — steering",
    attributes: { "session.id": "id", "session.quality.label": "text" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.quality.check.passed": {
    level: "debug",
    message: "quality check passed",
    attributes: { "session.id": "id", "session.quality.label": "text" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  /** Clearing a staged session revert failed at the snapshot boundary. */
  "session.revert.clear.failed": {
    level: "error",
    message: "failed to clear session revert",
    attributes: {
      "session.id": "id",
      "session.ref": "id",
      "snapshot.operation": "id",
      "snapshot.error": "fault",
    },
    content: "user",
    file: "packages/server/src/handlers/session.ts",
  },
  /** Staging a session revert failed at the snapshot boundary. */
  "session.revert.stage.failed": {
    level: "error",
    message: "failed to stage session revert",
    attributes: {
      "session.id": "id",
      "session.ref": "id",
      "snapshot.operation": "id",
      "snapshot.error": "fault",
    },
    content: "user",
    file: "packages/server/src/handlers/session.ts",
  },
  "session.steer.stream.interrupted": {
    level: "info",
    message: "steer arrived mid-generation — cutting the stream",
    attributes: { "session.id": "id" },
    content: "none",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.strict.action.failed": {
    level: "warn",
    message: "strict action part failed",
    attributes: { "session.id": "id", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.strict.attempt.failed": {
    level: "error",
    message: "strict attempt failed",
    attributes: { "session.id": "id", attempt: "count", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.strict.finalize.failed": {
    level: "error",
    message: "strict finalize failed",
    attributes: { "session.id": "id", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.strict.resume.failed": {
    level: "warn",
    message: "strict resume state unreadable",
    attributes: { "session.id": "id", "session.defect": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.strict.retention.failed": {
    level: "warn",
    message: "strict retention purge failed",
    attributes: { "session.id": "id", "session.defect": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.strict.summary.failed": {
    level: "warn",
    message: "strict summary failed",
    attributes: { "session.id": "id", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.title.early.failed": {
    level: "warn",
    message: "early auto-title failed",
    attributes: { "session.id": "id", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.title.generate.empty": {
    level: "warn",
    message: "auto-title: model returned an empty completion",
    attributes: { "session.id": "id" },
    content: "none",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.title.generate.failed": {
    level: "warn",
    message: "auto-title failed",
    attributes: { "session.id": "id", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.tool.textual.recovered": {
    level: "info",
    message: "textual tool-call recovery",
    attributes: { "session.id": "id", "session.tool.tell": "id", "session.tool.detail": "text" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.turn.empty.paused": {
    level: "warn",
    message:
      "The model produced two turns in a row with no reply and no tool call. This usually means the model server is dropping tool calls emitted on the reasoning channel — enable a reasoning parser (e.g. vLLM `--reasoning-parser`) or disable thinking for tool turns.",
    attributes: { "session.id": "id" },
    content: "none",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.turn.empty.recovered": {
    level: "info",
    message: "empty-turn recovery",
    attributes: { "session.id": "id" },
    content: "none",
    file: "packages/core/src/session/runner/llm.ts",
  },

  // ── skill ─────────────────────────────────────────────────────────────────────────────────────
  /** A file advertised by a remote skill catalog could not be downloaded. */
  "skill.discovery.download.failed": {
    level: "error",
    message: "failed to download skill file",
    attributes: { "skill.url": "text", "skill.error": "fault" },
    content: "user",
    file: "packages/core/src/skill/discovery.ts",
  },
  /** A versioned remote skill could not replace its cached copy atomically. */
  "skill.discovery.refresh.failed": {
    level: "error",
    message: "failed to refresh skill",
    attributes: { "skill.name": "text", "skill.error": "fault" },
    content: "user",
    file: "packages/core/src/skill/discovery.ts",
  },
  /** A discovered skill document could not be parsed and was omitted from the registry. */
  "skill.file.load.failed": {
    level: "error",
    message: "failed to load skill",
    attributes: { "skill.file": "path", "skill.error": "fault" },
    content: "user",
    file: "packages/novaclaw/src/skill/index.ts",
  },
  /** A remote catalog entry lacks the required SKILL.md document and is ignored. */
  "skill.index.entry.invalid": {
    level: "warn",
    message: "skill entry missing SKILL.md",
    attributes: { "skill.url": "text", "skill.name": "text" },
    content: "user",
    file: "packages/novaclaw/src/skill/discovery.ts",
  },
  /** A remote skill catalog index is about to be fetched. */
  "skill.index.fetch": {
    level: "info",
    message: "fetching index",
    attributes: { "skill.url": "text" },
    content: "user",
    file: "packages/novaclaw/src/skill/discovery.ts",
  },
  /** A remote skill catalog index could not be fetched or decoded. */
  "skill.index.fetch.failed": {
    level: "error",
    message: "failed to fetch skill index",
    attributes: { "skill.url": "text", "skill.error": "fault" },
    content: "user",
    file: "packages/core/src/skill/discovery.ts",
  },
  /** A configured local skill directory does not exist. */
  "skill.path.missing": {
    level: "warn",
    message: "skill path not found",
    attributes: { "skill.path": "path" },
    content: "user",
    file: "packages/novaclaw/src/skill/index.ts",
  },
  /** A later skill shadows an earlier document carrying the same declared name. */
  "skill.registry.duplicate": {
    level: "warn",
    message: "duplicate skill name",
    attributes: { "skill.name": "text", "skill.existing": "path", "skill.duplicate": "path" },
    content: "user",
    file: "packages/novaclaw/src/skill/index.ts",
  },
  /** The skill registry finished loading. The other half of the `init` collision (§0.4). */
  "skill.registry.init": {
    level: "info",
    message: "init",
    attributes: { count: "count" },
    content: "none",
    file: "packages/novaclaw/src/skill/index.ts",
  },
  /** A bounded global or project skill scan failed and contributes no documents. */
  "skill.scan.failed": {
    level: "error",
    message: "failed to scan skills",
    attributes: { "skill.scope": "id", "skill.directory": "path", "skill.error": "fault" },
    content: "user",
    file: "packages/novaclaw/src/skill/index.ts",
  },

  // ── snapshot ─────────────────────────────────────────────────────────────────────────────────
  /** The hourly maintenance loop itself failed; the next scheduled iteration will retry. */
  "snapshot.cleanup.loop.failed": {
    level: "error",
    message: "cleanup loop failed",
    attributes: { "snapshot.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** Snapshot-object garbage collection completed. */
  "snapshot.cleanup.run": {
    level: "info",
    message: "cleanup",
    attributes: { "snapshot.prune": "id" },
    content: "none",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** Snapshot-object garbage collection failed without disabling later attempts. */
  "snapshot.cleanup.run.failed": {
    level: "warn",
    message: "cleanup failed",
    attributes: { "snapshot.exit": "count", "snapshot.stderr": "fault" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** A full textual diff could not be computed; its caller receives an empty diff. */
  "snapshot.diff.compute.failed": {
    level: "warn",
    message: "failed to get diff",
    attributes: { "snapshot.hash": "text", "snapshot.exit": "count", "snapshot.stderr": "fault" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** A large change set was bounded for display; revert still uses the complete snapshot. */
  "snapshot.diff.compute.truncated": {
    level: "warn",
    message: "Snapshot.diffFull: change set too large; display is partial",
    attributes: {
      "snapshot.files.total": "count",
      "snapshot.files.listed": "count",
      "snapshot.files.omitted": "count",
      "snapshot.files.computed": "count",
      "snapshot.diff.bytes": "count",
    },
    content: "none",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** Batched object loading failed and the diff falls back to individual git-show calls. */
  "snapshot.diff.load.fallback": {
    level: "info",
    message: "git cat-file --batch failed during snapshot diff, falling back to per-file git show",
    attributes: { "snapshot.refs": "count", "snapshot.stderr": "fault" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** Batched object output was malformed and the diff falls back to individual git-show calls. */
  "snapshot.diff.parse.fallback": {
    level: "info",
    message: "git cat-file --batch output was malformed during snapshot diff, falling back to per-file git show",
    attributes: { "snapshot.reason": "id", "snapshot.header": "fault" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** Git could not enumerate the tracked and untracked snapshot candidates. */
  "snapshot.files.list.failed": {
    level: "warn",
    message: "failed to list snapshot files",
    attributes: {
      "snapshot.diff.exit": "count",
      "snapshot.diff.stderr": "fault",
      "snapshot.other.exit": "count",
      "snapshot.other.stderr": "fault",
    },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** Git could not stage a bounded set of paths into the private snapshot index. */
  "snapshot.files.stage.failed": {
    level: "warn",
    message: "failed to add snapshot files",
    attributes: { "snapshot.exit": "count", "snapshot.stderr": "fault" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** Newly ignored paths are removed from the private snapshot index. */
  "snapshot.files.untrack": {
    level: "info",
    message: "removing gitignored files from snapshot",
    attributes: { count: "count" },
    content: "none",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** Snapshot patch metadata could not list the files changed from a tree hash. */
  "snapshot.patch.list.failed": {
    level: "warn",
    message: "failed to get diff",
    attributes: { "snapshot.hash": "text", "snapshot.exit": "count" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** Restoring the snapshot index succeeded, but writing it into the worktree failed. */
  "snapshot.restore.checkout.failed": {
    level: "error",
    message: "failed to restore snapshot",
    attributes: { "snapshot.hash": "text", "snapshot.exit": "count", "snapshot.stderr": "fault" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** Git could not load the requested snapshot tree into the private index. */
  "snapshot.restore.read.failed": {
    level: "error",
    message: "failed to restore snapshot",
    attributes: { "snapshot.hash": "text", "snapshot.exit": "count", "snapshot.stderr": "fault" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** Restoration of a complete snapshot tree started. */
  "snapshot.restore.run": {
    level: "info",
    message: "restore",
    attributes: { "snapshot.hash": "text" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** A compatible batch of paths is being restored from one snapshot tree. */
  "snapshot.revert.batch.start": {
    level: "info",
    message: "reverting",
    attributes: { "snapshot.hash": "text", count: "count" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** Batch checkout failed and the same paths will be retried individually. */
  "snapshot.revert.checkout.fallback": {
    level: "info",
    message: "batched checkout failed, falling back to single-file revert",
    attributes: { "snapshot.hash": "text", count: "count" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** A path absent from its snapshot tree is being removed from the worktree. */
  "snapshot.revert.file.deleted": {
    level: "info",
    message: "file did not exist in snapshot, deleting",
    attributes: { "snapshot.file": "path", "snapshot.hash": "text" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** Checkout failed but the tree proves the path existed, so the worktree copy is preserved. */
  "snapshot.revert.file.kept": {
    level: "info",
    message: "file existed in snapshot but checkout failed, keeping",
    attributes: { "snapshot.file": "path", "snapshot.hash": "text" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** A single path is being restored from a snapshot tree. */
  "snapshot.revert.file.start": {
    level: "info",
    message: "reverting",
    attributes: { "snapshot.file": "path", "snapshot.hash": "text" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** Batch tree inspection failed and the same paths will be retried individually. */
  "snapshot.revert.list.fallback": {
    level: "info",
    message: "batched ls-tree failed, falling back to single-file revert",
    attributes: { "snapshot.hash": "text", count: "count" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** The private Git repository used for snapshots was created. */
  "snapshot.store.init": {
    level: "info",
    message: "initialized",
    attributes: {},
    content: "none",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** The current worktree state was recorded as a Git tree. */
  "snapshot.tree.track": {
    level: "info",
    message: "tracking",
    attributes: { "snapshot.hash": "text", "snapshot.cwd": "path", "snapshot.store": "path" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },

  // ── storage ───────────────────────────────────────────────────────────────────────────────────
  /** A legacy message document is copied into the current layout. */
  "storage.message.copy": {
    level: "info",
    message: "copying",
    attributes: { "storage.source": "path", "storage.destination": "path" },
    content: "user",
    file: "packages/novaclaw/src/storage/storage.ts",
  },
  /** Migration is about to copy the messages belonging to one session. */
  "storage.message.migrate": {
    level: "info",
    message: "migrating messages for session",
    attributes: { "storage.session": "id" },
    content: "none",
    file: "packages/novaclaw/src/storage/storage.ts",
  },
  /** One numbered migration is starting. */
  "storage.migration.run": {
    level: "info",
    message: "running migration",
    attributes: { "storage.index": "count" },
    content: "none",
    file: "packages/novaclaw/src/storage/storage.ts",
  },
  /** A numbered migration failed and later migrations will not run. */
  "storage.migration.run.failed": {
    level: "error",
    message: "failed to run migration",
    attributes: { "storage.index": "count", "storage.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/storage/storage.ts",
  },
  /** A legacy part document is copied into the current layout. */
  "storage.part.copy": {
    level: "info",
    message: "copying",
    attributes: { "storage.source": "path", "storage.destination": "path" },
    content: "user",
    file: "packages/novaclaw/src/storage/storage.ts",
  },
  /** Migration is about to copy the parts belonging to one message. */
  "storage.part.migrate": {
    level: "info",
    message: "migrating parts for message",
    attributes: { "storage.message": "id" },
    content: "none",
    file: "packages/novaclaw/src/storage/storage.ts",
  },
  /** One legacy project directory is being inspected and migrated. */
  "storage.project.migrate": {
    level: "info",
    message: "migrating project",
    attributes: { "storage.legacy_project": "path" },
    content: "user",
    file: "packages/novaclaw/src/storage/storage.ts",
  },
  /** A legacy session document is copied into the current layout. */
  "storage.session.copy": {
    level: "info",
    message: "copying",
    attributes: { "storage.source": "path", "storage.destination": "path" },
    content: "user",
    file: "packages/novaclaw/src/storage/storage.ts",
  },
  /** Migration is about to copy the sessions belonging to one project. */
  "storage.session.migrate": {
    level: "info",
    message: "migrating sessions for project",
    attributes: { "storage.project": "id" },
    content: "none",
    file: "packages/novaclaw/src/storage/storage.ts",
  },

  // ── tool ──────────────────────────────────────────────────────────────────────────────────────
  /** Retired in-process tool files were found and deliberately skipped in favour of MCP. */
  "tool.config.load.skipped": {
    level: "warn",
    message:
      "NOT LOADED: config-dir tool files were ignored. NovaClaw no longer runs third-party tool code inside its own process, so these files are NOT providing any tool to your sessions. MCP is the supported out-of-process tool seam: re-expose them as an MCP server and connect it with `novaclaw mcp add`. Delete the directory to silence this warning.",
    attributes: { "tool.directory": "path", "tool.files": "text", "tool.count": "count" },
    content: "user",
    file: "packages/novaclaw/src/tool/external-tool-source.ts",
  },
  /** The retired-tool-file compatibility scan could not read one configured directory. */
  "tool.config.scan.failed": {
    level: "debug",
    message: "could not scan config dir for retired tool files",
    attributes: { "tool.directory": "path", "tool.error": "fault" },
    content: "user",
    file: "packages/novaclaw/src/tool/external-tool-source.ts",
  },
  /** The hourly cleanup of saved, truncated tool output failed unexpectedly. */
  "tool.truncation.cleanup.failed": {
    level: "error",
    message: "truncation cleanup failed",
    attributes: { "tool.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/tool/truncate.ts",
  },

  // ── worktree ──────────────────────────────────────────────────────────────────────────────────
  /** A populated worktree could not load its instance. */
  "worktree.bootstrap.load.failed": {
    level: "error",
    message: "worktree bootstrap failed",
    attributes: { "worktree.directory": "path", "worktree.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/worktree/index.ts",
  },
  /** A new worktree could not populate its checkout. */
  "worktree.checkout.failed": {
    level: "error",
    message: "worktree checkout failed",
    attributes: { "worktree.directory": "path", "worktree.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/worktree/index.ts",
  },
  /** The asynchronous worktree boot task failed outside its handled stages. */
  "worktree.bootstrap.run.failed": {
    level: "error",
    message: "worktree bootstrap failed",
    attributes: { "worktree.directory": "path", "worktree.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/worktree/index.ts",
  },
  /** An explicitly configured worktree start command exited non-zero. */
  "worktree.start.command.failed": {
    level: "error",
    message: "worktree start command failed",
    attributes: { "worktree.start.kind": "id", "worktree.directory": "path", "worktree.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/worktree/index.ts",
  },
  /** The asynchronous worktree reset start task failed unexpectedly. */
  "worktree.start.task.failed": {
    level: "error",
    message: "worktree start task failed",
    attributes: { "worktree.directory": "path", "worktree.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/worktree/index.ts",
  },

  // ── workspace ─────────────────────────────────────────────────────────────────────────────────
  /** One registered workspace adapter could not enumerate its available workspaces. */
  "workspace.adapter.list.failed": {
    level: "warn",
    message: "workspace adapter list failed",
    attributes: { "workspace.adapter": "text", "workspace.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/control-plane/workspace.ts",
  },
  /** A workspace was removed from the store after its backing adapter became unavailable. */
  "workspace.adapter.remove.failed": {
    level: "error",
    message: "adapter not available when removing workspace",
    attributes: { "workspace.adapter": "text" },
    content: "user",
    file: "packages/novaclaw/src/control-plane/workspace.ts",
  },
  /** A replayed remote event could not be emitted on the local global bus. */
  "workspace.event.emit.failed": {
    level: "warn",
    message: "failed to emit global event",
    attributes: { "workspace.id": "id", "workspace.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/control-plane/workspace.ts",
  },
  /** A serialized remote event could not be replayed into the local event store. */
  "workspace.event.replay.failed": {
    level: "warn",
    message: "failed to replay global event",
    attributes: { "workspace.id": "id", "workspace.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/control-plane/workspace.ts",
  },
  /** A workspace's long-lived synchronization listener stopped unexpectedly. */
  "workspace.listener.run.failed": {
    level: "warn",
    message: "workspace listener failed",
    attributes: { "workspace.id": "id", "workspace.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/control-plane/workspace.ts",
  },
  /** A session record was reassigned to the current remote workspace. */
  "workspace.session.steal": {
    level: "info",
    message: "sync session stolen",
    attributes: { "session.id": "id", "workspace.id": "id" },
    content: "none",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/handlers/sync.ts",
  },
  /** The control plane could not establish the remote workspace's global event stream. */
  "workspace.sync.connect.failed": {
    level: "warn",
    message: "failed to connect to global sync",
    attributes: { "workspace.name": "text", "workspace.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/control-plane/workspace.ts",
  },
  /** A complete sync-event replay finished under strict workspace ownership. */
  "workspace.sync.replay.ok": {
    level: "info",
    message: "sync replay complete",
    attributes: {
      "session.id": "id",
      "workspace.events": "count",
      "workspace.sequence.first": "count",
      "workspace.sequence.last": "count",
    },
    content: "none",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/handlers/sync.ts",
  },
  /** A peer requested replay of a non-empty sync-event history. */
  "workspace.sync.replay.start": {
    level: "info",
    message: "sync replay requested",
    attributes: {
      "session.id": "id",
      "workspace.events": "count",
      "workspace.sequence.first": "count",
      "workspace.sequence.last": "count",
      "workspace.directory": "path",
    },
    content: "user",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/handlers/sync.ts",
  },
  /** A successful remote workspace response did not decode as the expected representation. */
  "workspace.target.decode.failed": {
    level: "warn",
    message: "workspace target response decode failed",
    attributes: { "workspace.id": "id", "workspace.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/control-plane/workspace.ts",
  },
  /** A request could not reach the resolved remote workspace target. */
  "workspace.target.request.failed": {
    level: "warn",
    message: "workspace target request failed",
    attributes: { "workspace.id": "id", "workspace.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/control-plane/workspace.ts",
  },
  /** A remote workspace target responded, but rejected the request at the HTTP boundary. */
  "workspace.target.response.rejected": {
    level: "warn",
    message: "workspace target request failed",
    attributes: { "workspace.id": "id", "workspace.http.status": "count", "workspace.body": "text" },
    content: "user",
    file: "packages/novaclaw/src/control-plane/workspace.ts",
  },
  /** The workspace adapter could not resolve its local or remote execution target. */
  "workspace.target.resolve.failed": {
    level: "warn",
    message: "workspace target failed",
    attributes: { "workspace.id": "id", "workspace.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/control-plane/workspace.ts",
  },
  /** The final source synchronization failed before a session moved between workspaces. */
  "workspace.warp.sync.failed": {
    level: "warn",
    message: "session warp final source sync failed",
    attributes: { "workspace.id": "id", "session.id": "id", "workspace.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/control-plane/workspace.ts",
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

export * as LogEvents from "./log-events"
