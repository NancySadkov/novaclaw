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
  // Log lines RELAYED from a client process (the renderer's ring, via `POST /log`) rather than
  // produced here. Its own subsystem instead of folding into `server`, because these subsystems exist
  // to give per-subsystem log LEVELS: an operator turning down renderer chatter should not have to
  // turn down the HTTP server's own logs to do it, and the two genuinely come from different
  // processes. Added 2026-08-07 with the `client.log.*` events.
  client: "Client-relayed logs",
  community: "Peer-to-peer community",
  config: "Configuration",
  credential: "Credentials",
  filesystem: "Files and watchers",
  format: "Code formatters",
  git: "Version control",
  instance: "Instance lifecycle",
  kb: "Knowledge",
  location: "Workspace locations",
  llm: "Model protocols",
  /**
   * **The log tier reporting on itself.** Added 2026-08-08 with `log.file.usage`, and the reason it
   * is its own subsystem rather than a member of `instance` is the one job subsystems have: an
   * operator who wants to know how fast their log grows should not have to raise the level of the
   * instance lifecycle to find out, and an operator silencing instance chatter should not lose the
   * only line that says whether the retention budget fits them.
   */
  log: "The log tier itself",
  messenger: "Messenger",
  mcp: "MCP servers",
  offline: "Offline mode",
  patch: "File changes",
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
 * **What plane an attribute belongs to — the ONE declaration, from which egress is derived.**
 *
 * Three values, not two, and the middle one is `todo/logging.md` **1e**:
 *
 * - `"none"` — carries nothing about this user. A count, a flag, a token from a closed vocabulary.
 *   These are the only things the maintenance plane may ever carry.
 * - `"correlated"` — carries no user *content*, but is a **join key into the data plane**: a session
 *   id, a workspace id, a prefix hash. Reading one tells you nothing; **collecting** them tells you
 *   what this person did and when. See {@link CORRELATION_ATTRIBUTES} for the full argument.
 * - `"user"` — may carry content the user, a model or a foreign process produced. Local log only.
 *
 * ⚠️ **`egress` is DERIVED from this and is not a second field.** An earlier shape declared both
 * `egress: true|false` on the class and `content` on the event, which is two literals for one fact —
 * the ruling-6 shape this project keeps re-finding. The class declares WHERE the value belongs; the
 * boolean everything downstream wants is `content === "none"`, computed.
 */
export type ContentClass = "none" | "correlated" | "user"

/** Least to most restrictive. An event's class is the MAXIMUM over its attributes'. */
export const CONTENT_ORDER: Readonly<Record<ContentClass, number>> = { none: 0, correlated: 1, user: 2 }

/**
 * **What an attribute value is allowed to be, and which plane it belongs to.**
 *
 * `content: "user"` does not mean "scrub it later". It means an event carrying this class is
 * content-bearing, is written to the local log only, and can never be part of a crash signature.
 * Classifying at the FIELD is what makes that decision reviewable at authoring time.
 *
 * ⚠️ `path` is deliberately NOT egress-safe. A filesystem path carries the user's account name and
 * their project names; it reads like metadata and behaves like content.
 */
export const ATTRIBUTE_CLASSES = {
  /**
   * A value from a **closed vocabulary we control**: a backend name, a protocol, an operation, an
   * error kind, a per-fault reference. ⚠️ *Not* a session id — see `correlate`, and read the note on
   * {@link CORRELATION_ATTRIBUTES} for why that distinction had to be made in the type.
   */
  id: { content: "none", value: "string" },
  /** A number. */
  count: { content: "none", value: "number" },
  /** A boolean. */
  flag: { content: "none", value: "boolean" },
  /**
   * **A correlation id — an identifier we minted that names one unit of the user's own work.**
   * Content-free and never egresses. `todo/logging.md` 1e.
   */
  correlate: { content: "correlated", value: "string" },
  /** A filesystem path — carries the user's account and project names. Never egresses. */
  path: { content: "user", value: "string" },
  /** Free text from a person, a model, or a foreign process. Never egresses. */
  text: { content: "user", value: "string" },
  /** Our own error text. Routinely embeds paths, payloads and prompts. Never egresses. */
  fault: { content: "user", value: "string" },
  /**
   * **A bounded list of strings, kept as a LIST.** `todo/logging.md` 1h's second seam: ignore
   * globs, command argv, changed config keys and failure reasons were all crossing the scalar-only
   * boundary as hand-written `JSON.stringify(…)` at the call site — which preserves the bytes and
   * discards the type, and puts the encoding decision in 20 places. The call site now passes
   * `readonly string[]`; {@link encodeList} owns the one encoding, and it is bounded.
   */
  list: { content: "user", value: "string[]" },
} as const satisfies Record<string, { readonly content: ContentClass; readonly value: string }>

export type AttributeClass = keyof typeof ATTRIBUTE_CLASSES

/**
 * Whether values of this class may leave the machine. **Derived**, so there is nowhere to write the
 * answer down a second time and no way for the two copies to disagree.
 */
export const egressSafe = (cls: AttributeClass): boolean => ATTRIBUTE_CLASSES[cls].content === "none"

/** The TypeScript value each attribute class admits, so a call site is typed by its key. */
export type AttributeValue = {
  readonly id: string
  readonly count: number
  readonly flag: boolean
  readonly correlate: string
  readonly path: string
  readonly text: string
  readonly fault: string
  readonly list: ReadonlyArray<string>
}

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
  /** Which plane this event belongs to. Must agree with `attributes` — checked. */
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

// ── correlation ids (todo/logging.md 1e) ────────────────────────────────────────────────────────

/**
 * **THE CORRELATION VOCABULARY — every attribute that names a unit of work, declared once.**
 *
 * `todo/logging.md` 1e: *correlation ids as first-class attributes*. The point of the item is one
 * sentence — **a log line that mentions a session id inside its `message=` is neither queryable nor
 * redactable, and an attribute is both.** The declaration model already makes the first half
 * structurally impossible, because `message` is a constant on the declaration and `Log.event` takes
 * no message parameter, so there is no expression a value could be interpolated into. What was
 * missing is the second half, and it has two parts that this table supplies:
 *
 *  1. **One name per thing.** A session id was spelled `session.id` at 55 declarations and
 *     `storage.session` at one — *measured 2026-08-07, not supposed* — which is the "one description
 *     existing twice" defect in miniature: `grep 'session.id=ses_x'` silently misses the storage
 *     migration's lines. A correlator now has exactly one name, decided here.
 *  2. **One class per name.** The class is decided by this table, not per event, so `session.id`
 *     cannot be `correlate` on one key and `text` on the next.
 *
 * ── 🔴 the egress ruling, and it is a REVERSAL ──────────────────────────────────────────────────
 *
 * Before this table, a session id was class `id` — **`egress: true`** — and 30 keys carrying one
 * were declared `content: "none"`. That is not a theoretical hole: `Telemetry.build` was exercised
 * on 2026-08-07 with `event: "session.drain.exit"` and returned `ok: true` with
 * `attributes: { "session.id": "ses_…" }` in the envelope, while `observability/telemetry.ts`'s own
 * disclosure says in as many words *"No hostname, username, machine id, **session id**, project name
 * or working directory."* One of the two was false, and per ruling 2 a subsystem does not get to
 * describe itself falsely. **The prose was right and the type was wrong**, so the type moved.
 *
 * **The argument, stated rather than assumed.** A session id is not user *content* — it is an opaque
 * token we minted and it quotes nobody. It is a **join key into the data plane**, and that is a
 * different thing from content:
 *
 *  · One id is inert. A **stream** of ids is a behavioural trace: how many sessions this person ran,
 *    when, how often they crashed, which ones came back. That is telemetry about a person wearing a
 *    maintenance-plane label — exactly the fingerprinting `releaseLine()` already strips a build
 *    stamp to avoid.
 *  · It is a key that **joins across planes**. The moment an id exists on both sides — a crash report
 *    here, a shared URL or a pasted log there — the maintenance plane can be joined to the data plane
 *    that AGENTS.md promises never egresses. A join key does not have to carry content to defeat the
 *    separation; it only has to be stable.
 *  · **It costs us nothing.** Correlation exists to close the self-healing loop, and that loop is
 *    LOCAL: the agent repairing an instance reads the instance's own file, where every class is
 *    written regardless of plane. Meanwhile the maintenance plane already has its grouping key in the
 *    `run=` column — per-process, minted at boot, naming no user artefact. So `correlate` gives up no
 *    capability that anything actually uses.
 *
 * ⇒ **A correlation id is `correlate`: content-free, and it never leaves this machine.** The one
 * exception is argued per entry below, and there are exactly two shapes of it — an id that names a
 * FAULT rather than a user's work (`ref`), and an id that names a message on our OWN in-process bus.
 *
 * ⚠️ **Ordinals are deliberately NOT correlators.** `step`, `attempt`, `round` are `count` and stay
 * egress-safe: a step number identifies nothing on its own, and it only becomes a correlator in
 * combination with a `correlate` field, which never egresses. It is listed here anyway so the
 * decision is written down once instead of being re-made per event.
 */
export const CORRELATION_ATTRIBUTES = {
  // ── the user's own units of work: correlate, never egresses ─────────────────────────────────
  /** The session — the kernel's one entity, and the thing a user would recognise as "my chat". */
  "session.id": "correlate",
  /** A message inside a session. Names one turn of the user's conversation. */
  "session.message": "correlate",
  /** One compaction of one session's history. */
  "session.compaction.id": "correlate",
  /**
   * A hash over a session's message prefix. ⚠️ A hash of user content is still a fingerprint OF
   * user content: two records carrying it prove the same conversation. `snapshot.hash` below was
   * already classified this way for exactly this reason; these two were not, which is the
   * inconsistency this table exists to make impossible.
   */
  "session.hash.expected": "correlate",
  "session.hash.actual": "correlate",
  /** A remote workspace the user created. */
  "workspace.id": "correlate",
  /** A terminal session the user opened. */
  "pty.id": "correlate",
  /** One question put to the user, and answered by them. */
  "question.request": "correlate",
  /** The legacy on-disk project id — derived from the user's own directory. */
  "storage.project": "correlate",

  // ── the two arguable exceptions, argued ────────────────────────────────────────────────────
  /**
   * A per-fault public reference (`err_1234`) minted so a user can quote a failure back to us. It
   * names a FAULT, not a unit of the user's work; it is born on the maintenance plane and is useless
   * without the fault it labels. Egress-safe, deliberately: this is the id whose whole job is to
   * survive the trip.
   */
  ref: "id",
  "session.ref": "id",
  /**
   * A message on one of our OWN in-process buses. It is minted per process, dies with it, and names
   * a frame of our plumbing rather than anything the user made. Egress-safe.
   */
  "instance.event.id": "id",
  "plugin.event.id": "id",

  // ── already local-only, listed so the classification is stated ONCE ────────────────────────
  /** A Git tree hash. It fingerprints the user's files, so it has always been local-only text. */
  "snapshot.hash": "text",

  // ── an ordinal, and the reason it is not a correlator ──────────────────────────────────────
  /** A step number within a session. Identifies nothing on its own. */
  step: "count",
} as const satisfies Record<string, AttributeClass>

/**
 * **The name shapes that MUST be decided in the table above.**
 *
 * The table alone is a list somebody has to remember to add to — which is a habit, not a mechanism
 * (the same gap `todo/logging.md` 1b filed against "check the registry before declaring"). So the
 * check runs in both directions: a name in the table must be declared with the table's class, **and
 * a name that READS like a correlator must be in the table.** A future `turn.id`, `trace.id` or
 * `agent.session` cannot be declared as an egress-safe `id` without someone opening this file.
 *
 * Measured against the live set: 13 of 218 attribute names match. Wide enough to bite, narrow enough
 * that it is not a rename tax on ordinary fields.
 */
export const CORRELATOR_SEGMENTS: ReadonlyArray<string> = [
  "id",
  "ref",
  "request",
  "session",
  "hash",
  "trace",
  "span",
  "correlation",
  "turn",
  "project",
]

/** Does this attribute name READ as a correlator, and therefore have to be decided deliberately? */
export const isCorrelatorShaped = (name: string): boolean => {
  const segments = name.split(".")
  // The last segment names the THING (`workspace.id`), and `hash` anywhere is a fingerprint
  // (`session.hash.expected` ends in `expected` and is still a hash).
  return CORRELATOR_SEGMENTS.includes(segments[segments.length - 1] ?? "") || segments.includes("hash")
}

/** Why this `name: cls` pair is not an acceptable correlation declaration, or `undefined`. */
export function correlationFault(name: string, cls: AttributeClass): string | undefined {
  const declared = (CORRELATION_ATTRIBUTES as Readonly<Record<string, AttributeClass>>)[name]
  if (declared !== undefined)
    return declared === cls
      ? undefined
      : `"${name}" is class "${cls}" here but CORRELATION_ATTRIBUTES says "${declared}". A correlation id has ONE class, decided there.`
  if (isCorrelatorShaped(name))
    return `"${name}" reads as a correlation id but is not in CORRELATION_ATTRIBUTES. Add it with its class and the reason it may or may not egress — never leave it to default.`
  return undefined
}

// ── bounded list encoding (todo/logging.md 1h, second seam) ─────────────────────────────────────

/** At most this many items survive; the rest become one `…+N more` element. */
export const LIST_MAX_ITEMS = 20
/** Each item is truncated to this many characters. */
export const LIST_MAX_ITEM_CHARS = 200

/**
 * **The one encoding for a `list` attribute**, so the call site passes a `readonly string[]` and
 * never decides how a list becomes a log column. Bounded on both axes, because an ignore list, an
 * argv or a set of failure reasons has no natural ceiling and a log line does.
 *
 * JSON, because the surrounding line is logfmt and a JSON array is the one encoding that survives
 * `cut -d= -f2` and re-parses without a bespoke reader.
 */
export const encodeList = (values: ReadonlyArray<string>): string => {
  const shown = values
    .slice(0, LIST_MAX_ITEMS)
    .map((value) => (value.length > LIST_MAX_ITEM_CHARS ? value.slice(0, LIST_MAX_ITEM_CHARS) + "…" : value))
  const rest = values.length - shown.length
  return JSON.stringify(rest > 0 ? [...shown, `…+${rest} more`] : shown)
}

// ── the message is a constant, and that is what keeps ids OUT of it ─────────────────────────────

/**
 * Why this declared `message` is not a constant sentence, or `undefined` when it is.
 *
 * The whole of 1e rests on values living in attributes rather than in prose, and the mechanism is
 * that `message` is declared here and `Log.event` has no message parameter. This is the guard for
 * the one way that could still be defeated: writing the interpolation INTO the declaration.
 */
export function messageFault(message: string): string | undefined {
  const shape = /\$\{|%[sdifjo]\b|\{\}|\{[0-9]\}/.exec(message)
  return shape === null
    ? undefined
    : `message contains the interpolation marker ${JSON.stringify(shape[0])}. A declared message is a CONSTANT — the value belongs in an attribute, which is the only form a query or a redaction pass can see.`
}

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
    attributes: { "config.offline.enabled": "flag", "config.offline.hosts": "list" },
    content: "user",
    file: "packages/core/src/config-store-write.ts",
  },
  /** A config PATCH named a top-level key the schema does not define; the whole patch is refused. */
  "config.patch.key.unknown": {
    level: "warn",
    message: "config PATCH refused, unknown top-level key",
    attributes: { "config.keys": "list", "config.hidden": "count" },
    content: "user",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/groups/config.ts",
  },
  /**
   * The OS dropped file events because more changed than its buffer could hold.
   *
   * ⚠️ NOT an error — it is the signal that a caller's picture of the tree is stale and wants a
   * rescan. Silence here is how a watcher goes quietly wrong after a branch switch or an install.
   */
  "filesystem.watcher.overflow": {
    level: "warn",
    message: "file watcher overflowed — events were dropped",
    attributes: { directory: "path" },
    content: "user",
    file: "packages/core/src/filesystem/watcher.ts",
  },
  /** A config PATCH carried a `null` value; the whole patch is refused (deletion is a separate verb). */
  "config.patch.value.null": {
    level: "warn",
    message: "config PATCH refused, null is not a deletion",
    attributes: { "config.keys": "list", "config.hidden": "count" },
    content: "user",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/groups/config.ts",
  },
  /** The legacy permission environment override was malformed and was skipped. */
  "config.permission.parse.failed": {
    level: "warn",
    message: "NOVACLAW_PERMISSION contains invalid JSON, skipping",
    attributes: { "config.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/config/config.ts",
  },
  /** A configured reference could not be materialised into the cache; the turn continues without it. */
  "config.reference.materialize.failed": {
    level: "warn",
    message: "failed to materialize reference",
    attributes: { "config.reference": "text", "config.repository": "text", "config.cause": "fault" },
    content: "user",
    file: "packages/core/src/reference.ts",
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
  /**
   * A `ConfigStoreWrite.remove` committed. `info` and content-bearing: a deletion is the one config
   * write that cannot be undone by re-reading the previous value, so the paths it took — and any
   * default ref cleared as a consequence — are what an operator needs when asking *where did my
   * model entry go*.
   */
  "config.remove.applied": {
    level: "info",
    message: "config paths were removed",
    attributes: { "config.paths": "list", "config.cleared": "list" },
    content: "user",
    file: "packages/core/src/config-store-write.ts",
  },
  /** A config write committed, but one or more live runtime domains could not re-materialise it. */
  "config.runtime.reload.failed": {
    level: "error",
    message: "a config write committed but the runtime could not re-materialise",
    attributes: { "config.domains": "list", "config.causes": "list" },
    content: "user",
    file: "packages/core/src/config-store-write.ts",
  },
  /** A durable config change cannot become live until this instance restarts. */
  "config.runtime.restart.required": {
    level: "warn",
    message: "a config write is stored but NOT LIVE until this instance restarts",
    attributes: { "config.keys": "list", "config.reasons": "list" },
    content: "user",
    file: "packages/core/src/config-store-write.ts",
  },
  /**
   * A boot-time DATA repair changed a stored setting. `warn`, and content-bearing, because the
   * notice quotes the user's own command back at them: a repair the user cannot read about is a
   * setting that silently stopped being what they typed (ruling 2).
   */
  "config.settings.migrated": {
    level: "warn",
    message: "a stored setting was repaired by a migration",
    attributes: { "config.notice": "text" },
    content: "user",
    file: "packages/core/src/settings-config-migrate.ts",
  },
  /** A partially invalid config still seeded its valid keys. Never faults startup. */
  "config.settings.seed.skipped": {
    level: "warn",
    message: "settings seed skipped invalid keys",
    attributes: { "config.notice": "text" },
    content: "user",
    file: "packages/core/src/settings-config-seed.ts",
  },
  /**
   * A whole config DOCUMENT was dropped before seeding — bad JSON, or one field that failed schema
   * validation. Decoding is all-or-nothing per document, so a single malformed provider entry costs
   * the user every provider, agent and command in that file. It used to happen in silence and
   * surface much later as "every turn fails model resolution", which names the wrong subsystem.
   */
  "config.catalog.seed.dropped": {
    level: "warn",
    message: "a config document was dropped and none of it was seeded",
    attributes: { "config.path": "text", "config.notice": "text" },
    content: "user",
    file: "packages/core/src/catalog-seed.ts",
  },
  /** Some settings keys were dropped as invalid; the rest applied. The notice names them. */
  "config.settings.skipped": {
    level: "warn",
    message: "settings keys were skipped",
    attributes: { "config.notice": "text" },
    content: "user",
    file: "packages/core/src/config.ts",
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
      "filesystem.ignore.attempted": "list",
      /** Whether the directory is watched at all. Was prose inside the list field below. */
      "filesystem.watched": "flag",
      "filesystem.ignore.active": "list",
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
  /**
   * The platform HAS a backend but the host library did not load — almost always a build that
   * shipped without it beside the executable. Separate from `.start.unsupported` on purpose: that
   * one means "nobody wrote this platform yet", this one means "a file is missing from this build",
   * and collapsing them would hide a packaging regression inside a known limitation.
   */
  "filesystem.watcher.start.unavailable": {
    level: "error",
    message: "watcher host library unavailable",
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
    attributes: { "format.file": "path", "format.command": "list" },
    content: "user",
    file: "packages/novaclaw/src/format/index.ts",
  },
  /** A formatter command exited non-zero. */
  "format.file.format.failed": {
    level: "error",
    message: "failed",
    attributes: { "format.file": "path", "format.command": "list", "format.environment": "list" },
    content: "user",
    file: "packages/novaclaw/src/format/index.ts",
  },
  /** The formatter process could not be spawned. */
  "format.file.spawn.failed": {
    level: "error",
    message: "failed to format file",
    attributes: {
      "format.file": "path",
      "format.command": "list",
      "format.environment": "list",
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
  /** An optional capability could not start; its refusal is cached while the rest of the instance stays live. */
  "instance.capability.start.failed": {
    level: "error",
    message: "optional capability could not start",
    attributes: { "instance.capability": "id", "instance.cause": "fault" },
    content: "user",
    file: "packages/core/src/effect/capability.ts",
  },
  /** A loaded external capability failed its periodic ping and was stopped/degraded. */
  "instance.capability.health.failed": {
    level: "error",
    message: "capability service health check failed",
    attributes: { "instance.capability": "id", "instance.cause": "fault" },
    content: "user",
    file: "packages/core/src/capability-service-runtime.ts",
  },
  /** A queued-service admission tick failed; the process-scoped pump retries on its next interval. */
  "instance.capability.pump.failed": {
    level: "error",
    message: "capability service queue pump failed",
    attributes: { "instance.cause": "fault" },
    content: "user",
    file: "packages/core/src/capability-service-runtime.ts",
  },
  /**
   * The instance database could not be opened, upgraded, or recognised, so the boot STOPPED. The
   * one fault on this list that is deliberately not survivable: coming up on an unusable or
   * half-migrated store would let the user act on an instance that looks healthy. `kind` separates
   * the cases that have different repairs (unreadable · corrupt · foreign · migration · unknown),
   * and nothing on that path renames, moves or deletes the file.
   */
  "instance.database.refused": {
    level: "error",
    message: "the instance database could not be used; NovaClaw stopped rather than write into it",
    attributes: {
      "instance.database": "path",
      "instance.database.kind": "id",
      "instance.database.migration": "id",
      "instance.cause": "text",
    },
    content: "user",
    file: "packages/core/src/database/database.ts",
  },
  /** Disposing one instance failed while its HTTP lifecycle was tearing down; the response still returns. */
  "instance.dispose.failed": {
    level: "warn",
    message: "instance disposal failed",
    attributes: { "instance.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/lifecycle.ts",
  },
  /**
   * One or more runtime flags could not be parsed from the environment, so each fell back to its
   * declared default and the instance booted anyway. Before this key existed, a single malformed
   * variable was an unrecoverable boot defect.
   */
  "instance.flags.parse.failed": {
    level: "warn",
    message: "runtime flags could not be parsed; the affected flags fell back to their defaults",
    attributes: { "instance.flags": "id", "instance.cause": "text" },
    content: "user",
    file: "packages/novaclaw/src/effect/runtime-flags.ts",
  },
  /** Disposing every instance failed during a swallow-errors shutdown; the disposed event is still emitted. */
  "instance.global.dispose.failed": {
    level: "warn",
    message: "global disposal failed",
    attributes: { "instance.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/server/global-lifecycle.ts",
  },
  /** An event observer threw. The publisher continues — one bad listener must not stop the bus. */
  "instance.listener.notify.failed": {
    level: "error",
    message: "event listener failed",
    attributes: { "instance.event.id": "id", "instance.event.type": "id", "instance.cause": "fault" },
    content: "user",
    file: "packages/core/src/event.ts",
  },
  /** One scheduler tick failed. The loop keeps its cadence; a tick is retried by the next interval. */
  "instance.scheduler.tick.failed": {
    level: "error",
    message: "calendar scheduler tick failed",
    attributes: { "instance.cause": "fault" },
    content: "user",
    file: "packages/core/src/schedule/scheduler.ts",
  },
  /**
   * A fired schedule's session was created and its prompt admitted, but nothing in this process
   * picked it up — no executor was attached to the wake relay. The work is durable and will run when
   * one is, so this is a WARNING, not a failure: the launch succeeded and the run did not begin.
   */
  "instance.scheduler.launch.unstarted": {
    level: "warn",
    message: "scheduled session was queued but no executor started it",
    attributes: { "session.id": "correlate" },
    content: "correlated",
    file: "packages/core/src/schedule/scheduler.ts",
  },
  /**
   * A compaction cycle stopped after the cheap prune because `compaction.summarize` is false.
   * Informational: the reclaim happened, no summary was written, and the transcript is untouched.
   */
  "session.compaction.prune.only": {
    level: "info",
    message: "compaction pruned without summarising",
    attributes: { "session.id": "correlate" },
    content: "correlated",
    file: "packages/core/src/session/compaction.ts",
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
  /**
   * A named per-instance disposer rejected — that subsystem did not let go.
   *
   * Distinct from `instance.store.dispose.failed`, which is about an instance whose CONTEXT never
   * resolved. This one means the instance was fine and a specific subsystem under it refused, which
   * at shutdown is how unflushed state gets lost. It was silent before: the disposers ran through an
   * `allSettled` whose results were discarded, and they had no names to report anyway.
   */
  "instance.disposer.run.failed": {
    level: "warn",
    message: "instance disposer did not finish",
    attributes: { directory: "path", "instance.disposers": "list" },
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
  /**
   * One passage could not be absorbed. Best-effort BY DESIGN: this runs detached from the request
   * that started it, so nobody is watching to retry, and abandoning the remaining passages because
   * one failed would lose a whole document to a single bad chunk.
   */
  /**
   * An absorption pass FINISHED, with what it produced.
   *
   * ⚠️ A success line, not just a failure one. This work is detached from the request that started
   * it, so without this a pass that ran and extracted NOTHING is indistinguishable from one that
   * never started — which is exactly the ambiguity that cost a debugging round on 2026-08-12.
   */
  "kb.absorb.run.done": {
    level: "info",
    message: "absorbed a document",
    attributes: { "kb.passages": "count", "kb.entities": "count" },
    // Two counts carry nothing of the user's — the redaction guard caught this declared as "user".
    content: "none",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/handlers/memory.ts",
  },
  /** The whole absorption pass could not start or run — the passages are stored regardless. */
  "kb.absorb.run.failed": {
    level: "warn",
    message: "could not absorb a document:",
    attributes: { "kb.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/handlers/memory.ts",
  },
  "kb.absorb.passage.failed": {
    level: "warn",
    message: "could not absorb a passage:",
    attributes: { "kb.cause": "fault" },
    content: "user",
    file: "packages/core/src/kb-graph/absorb.ts",
  },
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
  /** The remote model catalogue could not be refreshed; the cached catalogue stays in force. */
  "llm.catalog.fetch.failed": {
    level: "error",
    message: "failed to fetch models.dev",
    attributes: { "llm.cause": "fault" },
    content: "user",
    file: "packages/core/src/models-dev.ts",
  },

  // ── log ───────────────────────────────────────────────────────────────────────────────────────
  /**
   * **How big this instance's log directory is and how fast it is growing — the measurement the
   * Phase-2 defaults table was filed without.**
   *
   * `todo/logging.md` handed this key to Phase 3 with an unusually blunt confession attached:
   * *"Every one of these is a guess dressed in a measurement… Until it exists the Phase-2 defaults
   * table is still a guess — do not cite 8 MB / 256 MB / 30 d as measured."* One line per instance
   * boot, from `core/src/observability/logging.ts`, so **every install measures itself** instead of
   * inheriting one developer's 27 days on one machine at INFO — a number that then moved 2× within
   * nine days of being taken.
   *
   * ⭐ **Every attribute is `count`, so the whole event is `content: "none"` and rides the
   * maintenance plane.** That is not an accident of the fields, it is the point: *"is 256 MB right"*
   * is a fleet question, and this is the one log line that can answer it without carrying a byte of
   * anyone's work. It is also why the level is `info` and not `debug` — a datapoint nobody collects
   * by default is a datapoint that does not exist.
   *
   * ⚠️ **The SIZE and the RATE are two keys, and that is the whole design decision.** Size is always
   * knowable; a rate is not — a brand-new instance, or one whose segment rotated a minute ago, has
   * no span to divide by. Every declared attribute is required, so folding them into one key would
   * force a sentinel (`0`? `-1`?) into a column that reads as a measurement, and *"the rate is
   * 0 B/h"* is a false description of *"nobody knows yet"* (ruling 2). **The absence of a
   * `log.file.rate` line beside a `log.file.usage` line IS the answer "too early to say."** Same
   * shape as 1c's four `client.log.*` keys rather than one with the level as an attribute.
   */
  "log.file.usage": {
    level: "info",
    message: "log directory usage",
    attributes: {
      "log.bytes": "count",
      "log.active.bytes": "count",
      "log.segments": "count",
    },
    content: "none",
    file: "packages/core/src/observability/logging.ts",
  },
  /**
   * **The measured write rate, and it only ships when there is one.**
   *
   * Emitted beside `log.file.usage` at boot, and only when the active segment has accumulated for
   * longer than `LogRead.MIN_RATE_SPAN_MS`. `log.span.hours` is the denominator and
   * `log.active.bytes` the numerator, both on the line, so a reader can check the division rather
   * than trust it — and can discount a rate taken over an hour differently from one taken over a
   * month.
   *
   * ⚠️ Measured over the ACTIVE segment alone. A rotated segment's stamp is its SEAL time, so the
   * lines inside it are older than their own filename; using it as a history start understates the
   * span and therefore OVERSTATES the rate, and getting the true start means gunzipping the oldest
   * segment on the boot path. See `observability/log-read.ts`'s `usage`.
   *
   * ⚠️ RAW bytes, before gzip. Rotated history compresses ~16× on this corpus (§0.5), so anything
   * turning this into *"days until the budget fills"* applies that ratio itself; storing the derived
   * answer here would be two places computing one number (ruling 6).
   */
  "log.file.rate": {
    level: "info",
    message: "log write rate",
    attributes: {
      "log.bytes.per.hour": "count",
      "log.active.bytes": "count",
      "log.span.hours": "count",
    },
    content: "none",
    file: "packages/core/src/observability/logging.ts",
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
      "messenger.failure": "text",
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
    attributes: { "offline.policy.hosts": "list" },
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
  /** --pure was set, so no external plugin was loaded. */
  "plugin.external.skipped": {
    level: "debug",
    message: "skipping external plugins",
    attributes: {},
    content: "none",
    file: "packages/core/src/config/plugin/external.ts",
  },

  // ── pty ──────────────────────────────────────────────────────────────────────────────────────
  /** A client began receiving retained and live output from a running terminal session. */
  "pty.client.attach": {
    level: "info",
    message: "client attached to session",
    attributes: { "pty.id": "correlate", "pty.directory": "path" },
    content: "user",
    file: "packages/core/src/pty.ts",
  },
  /** A terminal process is about to be spawned. */
  "pty.session.create": {
    level: "info",
    message: "creating session",
    attributes: { "pty.id": "correlate", "pty.command": "text", "pty.arguments": "list", "pty.directory": "path" },
    content: "user",
    file: "packages/core/src/pty.ts",
  },
  /** A terminal process exited and its retained session became inactive. */
  "pty.session.exit": {
    level: "info",
    message: "session exited",
    attributes: { "pty.id": "correlate", "pty.exit_code": "count" },
    content: "correlated",
    file: "packages/core/src/pty.ts",
  },
  /** A retained terminal session is being removed. */
  "pty.session.remove": {
    level: "info",
    message: "removing session",
    attributes: { "pty.id": "correlate" },
    content: "correlated",
    file: "packages/core/src/pty.ts",
  },

  // ── question ──────────────────────────────────────────────────────────────────────────────────
  /** A session is waiting for answers to one or more questions. */
  "question.request.ask": {
    level: "info",
    message: "asking",
    attributes: { "question.request": "correlate", "question.count": "count" },
    content: "correlated",
    file: "packages/novaclaw/src/question/index.ts",
  },
  /** The user rejected a pending question request. */
  "question.request.reject": {
    level: "info",
    message: "rejected",
    attributes: { "question.request": "correlate" },
    content: "correlated",
    file: "packages/novaclaw/src/question/index.ts",
  },
  /** A rejection named no pending question request. */
  "question.request.reject.unknown": {
    level: "warn",
    message: "reject for unknown request",
    attributes: { "question.request": "correlate" },
    content: "correlated",
    file: "packages/novaclaw/src/question/index.ts",
  },
  /** The user answered a pending question request. */
  "question.request.reply": {
    level: "info",
    message: "replied",
    attributes: { "question.request": "correlate", "question.answers": "list" },
    content: "user",
    file: "packages/novaclaw/src/question/index.ts",
  },
  /** A reply named no pending question request. */
  "question.request.reply.unknown": {
    level: "warn",
    message: "reply for unknown request",
    attributes: { "question.request": "correlate" },
    content: "correlated",
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
  /** A client opened the per-instance SSE event stream. */
  "server.event.connected": {
    level: "info",
    message: "event stream connected",
    attributes: {},
    content: "none",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/handlers/event.ts",
  },
  /** The per-instance SSE event stream closed. */
  "server.event.disconnected": {
    level: "info",
    message: "event stream disconnected",
    attributes: {},
    content: "none",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/handlers/event.ts",
  },
  /** A file search was served. The query is user text and never egresses. */
  "server.file.find": {
    level: "info",
    message: "find file",
    attributes: {
      "server.query": "text",
      "server.type": "id",
      "server.directory": "path",
      "server.limit": "count",
      "server.results": "count",
      "server.duration": "count",
    },
    content: "user",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/handlers/file.ts",
  },
  /** A client opened the instance-global SSE event stream. */
  "server.global.event.connected": {
    level: "info",
    message: "global event stream connected",
    attributes: {},
    content: "none",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/handlers/global.ts",
  },
  /** The instance-global SSE event stream closed. */
  "server.global.event.disconnected": {
    level: "info",
    message: "global event stream disconnected",
    attributes: {},
    content: "none",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/handlers/global.ts",
  },
  /** mDNS was asked for but the resolved hostname is loopback, which would advertise an unreachable address. */
  "server.mdns.publish.skipped": {
    level: "warn",
    message: "mDNS enabled but hostname is loopback, skipping publish",
    attributes: {},
    content: "none",
    file: "packages/novaclaw/src/server/server.ts",
  },
  /** First-boot recipe seeding created entries. */
  "server.recipes.seeded": {
    level: "info",
    message: "seeded recipes",
    attributes: { "server.created": "count" },
    content: "none",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/server.ts",
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
  /** A request body failed schema decoding. Emitted by both HTTP boundaries; this file is the anchor. */
  "server.schema.rejection": {
    level: "warn",
    message: "schema rejection",
    attributes: { "server.kind": "id", "server.reason": "text" },
    content: "user",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/middleware/schema-error.ts",
  },
  /** A child session did not inherit its parent session-defined adhoc recipes. The spawn still succeeds. */
  "session.adhoc.copy.failed": {
    level: "warn",
    message: "adhoc tool copy-on-spawn failed",
    attributes: { "session.id": "correlate", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/spawner.ts",
  },

  // ── session ───────────────────────────────────────────────────────────────────────────────────
  // A session whose working folder vanished is now RUN in a scratch folder rather than isolated.
  // `warn` not `info`: the session keeps working, but it is no longer where the user put it, and an
  // operator reading the log needs to see that without hunting.
  // The renderer's own log ring, relayed through `POST /log`. FOUR entries rather than one with the
  // level as an attribute: a registered event's level is fixed by its declaration, and collapsing
  // them would make every client line arrive at one severity — so an operator filtering for errors
  // would either miss the client's errors or drown in its debug.
  //
  // ⚠️ These exist because the handler previously called `Effect.logDebug`/`logInfo`/… selected into a
  // variable, which the log-event ledger could not see: it matched CALLS, and a reference assigned to
  // a variable is not one. Free-form client text is exactly what the keyed vocabulary is for — the
  // message is DATA on a keyed event, not an unkeyed log line.
  "client.log.debug": {
    level: "debug",
    message: "client log",
    attributes: { "client.service": "id", "client.message": "text" },
    content: "user",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/handlers/control.ts",
  },
  "client.log.info": {
    level: "info",
    message: "client log",
    attributes: { "client.service": "id", "client.message": "text" },
    content: "user",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/handlers/control.ts",
  },
  "client.log.warn": {
    level: "warn",
    message: "client log",
    attributes: { "client.service": "id", "client.message": "text" },
    content: "user",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/handlers/control.ts",
  },
  "client.log.error": {
    level: "error",
    message: "client log",
    attributes: { "client.service": "id", "client.message": "text" },
    content: "user",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/handlers/control.ts",
  },

  "session.folder.substituted": {
    level: "warn",
    message: "session working folder is gone; running in a scratch folder",
    attributes: { "session.id": "correlate", "session.folder.missing": "path", "session.folder.scratch": "path" },
    content: "user",
    file: "packages/novaclaw/src/session-worker/execution.ts",
  },

  "session.changes.refresh.failed": {
    level: "warn",
    message: "changes-summary refresh failed",
    attributes: { "session.id": "correlate", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/maintenance.ts",
  },
  "session.compaction.manual.failed": {
    level: "error",
    message: "manual compaction failed",
    attributes: { "session.id": "correlate", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.compaction.manual.settled": {
    level: "info",
    message: "manual compaction settled",
    attributes: { "session.id": "correlate", compacted: "flag" },
    content: "correlated",
    file: "packages/core/src/session/runner/llm.ts",
  },
  /** A cheap-tier prune was planned. `session.commit` says whether it will be applied. */
  "session.compaction.prune.planned": {
    level: "info",
    message: "compaction prune planned",
    attributes: {
      "session.commit": "flag",
      "session.targets": "count",
      "session.reclaim": "count",
      "session.scanned": "count",
    },
    content: "none",
    file: "packages/core/src/session/compaction.ts",
  },
  /** A stored compaction no longer matches its prefix hash, so it was not applied. */
  "session.compaction.stale.rejected": {
    level: "warn",
    message: "stale session compaction rejected",
    attributes: {
      "session.id": "correlate",
      "session.compaction.id": "correlate",
      "session.prefix.seq": "count",
      "session.hash.expected": "correlate",
      "session.hash.actual": "correlate",
    },
    content: "correlated",
    file: "packages/core/src/session/history.ts",
  },
  "session.context.pack.evicted": {
    level: "warn",
    message: "context pack evicted history from the outgoing request",
    attributes: {
      "session.id": "correlate",
      "session.dropped": "count",
      "session.kept.tokens": "count",
      "session.context.size": "count",
    },
    content: "correlated",
    file: "packages/core/src/session/runner/llm.ts",
  },
  /**
   * The per-turn request footprint — what the outgoing request costs, and which part of it grew.
   *
   * `debug`, deliberately: it fires on EVERY turn, so at `info` it would drown the log it is meant
   * to make readable. The value is the series, not any single line.
   *
   * ⚠️ **All-`count` is what makes `content: "none"` a fact here.** The measurement knows the largest
   * tool's NAME and does not send it — a `define_tool` name is user-authored, so it is not the closed
   * vocabulary `id` promises. See `session/runner/footprint.ts` for why the struct is richer than the
   * event.
   */
  "session.request.footprint": {
    level: "debug",
    message: "outgoing request footprint",
    attributes: {
      "session.id": "correlate",
      "request.bytes.total": "count",
      "request.bytes.system": "count",
      "request.bytes.messages": "count",
      "request.bytes.tools": "count",
      "request.count.system": "count",
      "request.count.messages": "count",
      "request.count.tools": "count",
      "request.tools.share.percent": "count",
      "request.tokens.estimated": "count",
      "request.tools.largest.bytes": "count",
    },
    content: "correlated",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.context.pressure.high": {
    level: "warn",
    message: "ctx_pressure: real prompt near the context window",
    attributes: {
      "session.id": "correlate",
      "session.prompt.tokens": "count",
      "session.estimated.tokens": "count",
      "session.context.size": "count",
    },
    content: "correlated",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.control.operator": {
    level: "info",
    message: "session under operator control — Nova is not responding",
    attributes: { "session.id": "correlate" },
    content: "correlated",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.doom.runaway.detected": {
    level: "info",
    message: "doom-loop runaway self-check",
    attributes: { "session.id": "correlate", "session.tool.calls": "count" },
    content: "correlated",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.doom.streak.detected": {
    level: "info",
    message: "doom-loop failure streak",
    attributes: {
      "session.id": "correlate",
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
    attributes: { "session.id": "correlate", step: "count" },
    content: "correlated",
    file: "packages/core/src/session/runner/llm.ts",
  },
  /** A session drain ended in failure rather than interruption. The session settles back to idle. */
  "session.drain.failed": {
    level: "error",
    message: "failed to drain session",
    attributes: { "session.id": "correlate", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/execution/local.ts",
  },
  "session.drive.cap.reached": {
    level: "warn",
    message: "self-drive cap reached",
    attributes: { "session.id": "correlate", rounds: "count" },
    content: "correlated",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.drive.continue": {
    level: "info",
    message: "self-drive continuation",
    attributes: { "session.id": "correlate", round: "count" },
    content: "correlated",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.drive.goal.unavailable": {
    level: "warn",
    message: "durable self-drive goal unavailable",
    attributes: { "session.id": "correlate", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.drive.plan.unavailable": {
    level: "warn",
    message: "durable self-drive plan unavailable",
    attributes: { "session.id": "correlate", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.finish.recover": {
    level: "info",
    message: "finish recovery: provider truncated at its output-token limit",
    attributes: { "session.id": "correlate", step: "count", recoveries: "count" },
    content: "correlated",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.finish.recover.paused": {
    level: "warn",
    message: "finish recovery: truncated twice — pausing the drain",
    attributes: { "session.id": "correlate", step: "count" },
    content: "correlated",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.finish.reground": {
    level: "info",
    message: "finish re-grounding nudge",
    attributes: { "session.id": "correlate" },
    content: "correlated",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.introspection.interject": {
    level: "info",
    message: "introspection interjecting",
    attributes: { "session.id": "correlate" },
    content: "correlated",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.introspection.judge.failed": {
    level: "warn",
    message: "introspection judge failed",
    attributes: { "session.id": "correlate", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  /** Boot recovery: queued prompts a dead process left un-promoted, handed back to the executor. */
  "session.input.abandoned.resumed": {
    level: "info",
    message: "resumed queued input a previous process left behind",
    attributes: { "session.resumed": "count", "session.handedOff": "count" },
    content: "none",
    file: "packages/core/src/session/boot-recovery.ts",
  },
  /** Boot recovery: execution leases whose owner stopped heartbeating, reclassified for the UI. */
  "session.lease.stale.recovered": {
    level: "info",
    message: "reclassified execution leases abandoned by a dead host",
    attributes: { "session.recovered": "count" },
    content: "none",
    file: "packages/core/src/session/boot-recovery.ts",
  },
  "session.memory.extract.empty": {
    level: "warn",
    message: "memory extraction: model returned an empty completion",
    attributes: { "session.id": "correlate" },
    content: "correlated",
    file: "packages/core/src/session/runner/maintenance.ts",
  },
  "session.memory.extract.retry": {
    level: "debug",
    message: "memory extraction: empty completion on a `length` finish — re-asking with a larger budget",
    attributes: { "session.id": "correlate", "extract.cap": "count" },
    content: "correlated",
    file: "packages/core/src/session/runner/maintenance.ts",
  },
  // Ruling 2 — an empty extraction that was a BUDGET reading must be distinguishable from an honest
  // "nothing worth remembering". `….empty` says the completion was empty; this says the pass gave up
  // and why, so nobody raises a cap chasing a failure that was never about the cap.
  "session.memory.extract.giveup": {
    level: "warn",
    message: "memory extraction: gave up after the budget ladder",
    attributes: { "session.id": "correlate", "extract.cause": "id", "extract.cap": "count" },
    content: "correlated",
    file: "packages/core/src/session/runner/maintenance.ts",
  },
  "session.memory.extract.failed": {
    level: "warn",
    message: "memory extraction failed",
    attributes: { "session.id": "correlate", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/maintenance.ts",
  },
  "session.memory.invalidate.stale": {
    level: "info",
    message: "invalidated recalled file memories after a confirmed missing-path read",
    attributes: { "session.id": "correlate", "session.memory.invalidated": "count" },
    content: "correlated",
    file: "packages/core/src/session/runner/llm.ts",
  },
  /** A stored session message could not be decoded for an API response. */
  "session.message.decode.failed": {
    level: "error",
    message: "failed to decode session message",
    attributes: { "session.id": "correlate", "session.message": "correlate", "session.ref": "id" },
    content: "correlated",
    file: "packages/server/src/handlers/session.ts",
  },
  /**
   * ⚠️ **`session.provider.message` is `text`, not `fault`, and the distinction is the whole of 1h.**
   *
   * The `fault` class means *this value is a caught error, normalized once by `Log.fault`* — that is
   * what `log-attributes.test.ts`'s seam-1 ratchet enforces, and it is why the class exists at all
   * beside `text` (the two records are otherwise identical: `content: "user"`, `value: "string"`, so
   * this carries **no** egress consequence). What the two events below set is
   * `LLMErrorReason.message` — a `Schema.String` FIELD of the structured `LLMErrorReason` union,
   * whose discriminant is already on the same line as `session.provider.reason` — reached either
   * directly (`.broken`) or through `LLMError`'s `message` getter, which is `module.method:` plus
   * that same field (`.retry`). Reading a typed string field is not a normalization decision, and
   * `Log.fault` on a string is provably the identity branch — so wrapping it would turn the ratchet
   * green while normalizing nothing, which is the failure the ratchet exists to make visible.
   *
   * ⚠️ **These sites COULD have been converted instead — `transient` and `llmFailure` are caught
   * `LLMError`s in hand, so `Log.fault(transient)` is expressible.** It was rejected on what the
   * reader needs: both events are **handled and non-fatal** (a bounded retry, and a damaged SSE
   * epilogue after a semantically complete reply), an Effect stack through our own runner says
   * nothing about a refused connection, and `session.provider.attempt.retry` can fire three times a
   * turn against a restarting local vLLM. The file's name for a normalized caught error is
   * `session.cause`, used at fifteen sites — and these two events deliberately do not carry one.
   */
  "session.provider.attempt.retry": {
    level: "warn",
    message: "provider attempt failed — retrying",
    attributes: {
      "session.id": "correlate",
      attempt: "count",
      "session.attempts.max": "count",
      "session.provider.reason": "id",
      "session.provider.message": "text",
    },
    content: "user",
    file: "packages/core/src/session/runner/provider-dispatch.ts",
  },
  "session.provider.response.broken": {
    level: "warn",
    message: "provider response ended before its final frame",
    attributes: {
      "session.id": "correlate",
      "session.provider.reason": "id",
      "session.provider.message": "text",
    },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.provider.response.empty": {
    level: "warn",
    message: "provider returned an empty response",
    // No provider text to carry — an empty response has none, which is the whole event. So `none`,
    // unlike its `.broken` neighbour above, which logs the provider's own fault message.
    attributes: { "session.id": "correlate" },
    content: "correlated",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.quality.check.errored": {
    level: "warn",
    message: "quality check errored",
    attributes: { "session.id": "correlate", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.quality.check.failed": {
    level: "info",
    message: "quality check FAILED — steering",
    attributes: { "session.id": "correlate", "session.quality.label": "text" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.quality.check.passed": {
    level: "debug",
    message: "quality check passed",
    attributes: { "session.id": "correlate", "session.quality.label": "text" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  /** The session's permission posture refused the shell command the quality gate wanted to run. */
  "session.quality.check.refused": {
    level: "info",
    message: "quality check not run — the session's permission posture refused it",
    attributes: { "session.id": "correlate", "session.quality.label": "text" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  /** Clearing a staged session revert failed at the snapshot boundary. */
  "session.revert.clear.failed": {
    level: "error",
    message: "failed to clear session revert",
    attributes: {
      "session.id": "correlate",
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
      "session.id": "correlate",
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
    attributes: { "session.id": "correlate" },
    content: "correlated",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.strict.action.failed": {
    level: "warn",
    message: "strict action part failed",
    attributes: { "session.id": "correlate", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/strict-drain.ts",
  },
  "session.strict.attempt.failed": {
    level: "error",
    message: "strict attempt failed",
    attributes: { "session.id": "correlate", attempt: "count", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/strict-drain.ts",
  },
  "session.strict.finalize.failed": {
    level: "error",
    message: "strict finalize failed",
    attributes: { "session.id": "correlate", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/strict-drain.ts",
  },
  "session.strict.resume.failed": {
    level: "warn",
    message: "strict resume state unreadable",
    attributes: { "session.id": "correlate", "session.defect": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/strict-drain.ts",
  },
  "session.strict.retention.failed": {
    level: "warn",
    message: "strict retention purge failed",
    attributes: { "session.id": "correlate", "session.defect": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/strict-drain.ts",
  },
  "session.strict.summary.failed": {
    level: "warn",
    message: "strict summary failed",
    attributes: { "session.id": "correlate", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/strict-drain.ts",
  },
  "session.title.early.failed": {
    level: "warn",
    message: "early auto-title failed",
    attributes: { "session.id": "correlate", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/maintenance.ts",
  },
  "community.answer.failed": {
    level: "warn",
    message: "answering a peer failed before any answer existed",
    attributes: { "community.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/handlers/community.ts",
  },
  "session.title.generate.empty": {
    level: "warn",
    message: "auto-title: model returned an empty completion",
    attributes: { "session.id": "correlate" },
    content: "correlated",
    file: "packages/core/src/session/runner/maintenance.ts",
  },
  "session.title.generate.failed": {
    level: "warn",
    message: "auto-title failed",
    attributes: { "session.id": "correlate", "session.cause": "fault" },
    content: "user",
    file: "packages/core/src/session/runner/maintenance.ts",
  },
  "session.tool.textual.recovered": {
    level: "info",
    message: "textual tool-call recovery",
    attributes: { "session.id": "correlate", "session.tool.tell": "id", "session.tool.detail": "text" },
    content: "user",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.turn.empty.paused": {
    level: "warn",
    message:
      "The model produced two turns in a row with no reply and no tool call. This usually means the model server is dropping tool calls emitted on the reasoning channel — enable a reasoning parser (e.g. vLLM `--reasoning-parser`) or disable thinking for tool turns.",
    attributes: { "session.id": "correlate" },
    content: "correlated",
    file: "packages/core/src/session/runner/llm.ts",
  },
  "session.turn.empty.recovered": {
    level: "info",
    message: "empty-turn recovery",
    attributes: { "session.id": "correlate" },
    content: "correlated",
    file: "packages/core/src/session/runner/llm.ts",
  },
  /**
   * A harness stage of one turn ran past the point where the UI stops calling it normal.
   *
   * Filed for a specific unanswered question: a `snapshot-after` was observed at **10.6 s** on
   * 2026-08-11, and afterwards every primitive behind it measured 85–160 ms and nothing reproduced
   * it. The breakdown existed at the moment it happened — the recorder collects
   * `repository`/`status`/`persist`/`hash` sub-timings — and was thrown away, so the next occurrence
   * had to be waited for rather than read. This event keeps it.
   *
   * Both stage names are closed vocabularies we own (`TurnPhase`, `SnapshotPhase`), so this is
   * egress-safe by declaration and a crash signature can carry it. **PROVIDER phases are excluded at
   * the call site** — the model taking a while is not a defect, and logging it would bury the
   * harness stages this exists to catch.
   */
  "session.turn.stage.slow": {
    level: "warn",
    message: "a turn stage ran long",
    attributes: {
      "session.id": "correlate",
      "session.stage": "id",
      "session.stage.ms": "count",
      "session.stage.detail": "id",
      "session.stage.detail.ms": "count",
    },
    content: "correlated",
    file: "packages/core/src/session/runner/llm.ts",
  },
  /**
   * Post-drain housekeeping ran long enough to be a wait rather than background work.
   *
   * It runs INSIDE the drain — after the idle status, so no spinner shows, but before the lease is
   * released — so the next prompt queues behind it. Measured 2026-08-11 at 642 ms with a title
   * already set and 1285 ms on a session's first turn (two utility model calls back to back), so
   * this only fires on something going wrong: a stalled embedding, a contended device.
   */
  "session.maintenance.postrun.slow": {
    level: "warn",
    message: "post-run maintenance ran long",
    attributes: {
      "session.id": "correlate",
      "session.stage": "id",
      "session.stage.ms": "count",
      "session.maintenance.ms": "count",
    },
    content: "correlated",
    file: "packages/core/src/session/runner/maintenance.ts",
  },
  /** A wake arrived with no executor attached; queued input will not run until one is. */
  "session.wake.dropped": {
    level: "warn",
    message: "session wake dropped, no executor attached",
    attributes: { "session.id": "correlate" },
    content: "correlated",
    file: "packages/core/src/session/run-coordinator.ts",
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
  /** No snapshot was taken for this turn, so revert has no restore point for it. */
  "snapshot.capture.failed": {
    level: "warn",
    message: "failed to capture snapshot",
    attributes: { "snapshot.cause": "fault" },
    content: "user",
    file: "packages/core/src/snapshot.ts",
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
  /**
   * Snapshot-object garbage collection failed without disabling later attempts.
   *
   * ⚠️ **`snapshot.stderr` is `text`, and that is a RULING, not a downgrade** (`todo/logging.md` 1h,
   * 2026-08-08). It holds git's own words and nothing else. It was `fault` only because the `git`
   * helper used to write a caught spawn failure into the same field — so the column named git as the
   * author of our exception, which is ruling 2 broken. The helper now names itself under
   * {@link EVENTS "snapshot.git.spawn.failed"} and leaves this empty, which is why the class could
   * move. `text` and `fault` are both `content: "user"` and both speak for others, so nothing about
   * egress or untrusted framing changes; what changes is that the column's NAME is now true.
   */
  "snapshot.cleanup.run.failed": {
    level: "warn",
    message: "cleanup failed",
    attributes: { "snapshot.exit": "count", "snapshot.stderr": "text" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /**
   * 🔴 **git itself could not be started — no process ran, so no exit code and no stderr exist.**
   *
   * The subsystem that is unavailable names itself here (ruling 2), once, at the point the spawn
   * failure is caught and normalized by `Log.fault`. Every `snapshot.*` line that follows reports the
   * OPERATION's outcome with an empty `snapshot.stderr` and a sentinel `snapshot.exit=1`; this line
   * is what tells a reader those two columns describe a child that never existed.
   *
   * It also covers the ~10 `git()` calls that log nothing on failure (`init`, the `config` writes,
   * `drop`, `excludes`, `seed`, `show`) — a missing git binary used to make the whole snapshot store
   * silently no-op.
   */
  "snapshot.git.spawn.failed": {
    level: "error",
    message: "git could not be started",
    attributes: { "snapshot.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** A full textual diff could not be computed; its caller receives an empty diff. */
  "snapshot.diff.compute.failed": {
    level: "warn",
    message: "failed to get diff",
    attributes: { "snapshot.hash": "text", "snapshot.exit": "count", "snapshot.stderr": "text" },
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
  /**
   * Batched object loading RAN and exited non-zero; the diff falls back to individual git-show calls.
   *
   * ⚠️ This site was on the fault ledger and never needed to be: it reads a raw `appProcess.run`
   * result on a branch guarded by `batch.exitCode !== 0`, so a child provably ran and
   * `snapshot.stderr` provably holds that child's words. It was classed `fault` by association with
   * its seven siblings, which is the hazard a class table has — see `snapshot.cleanup.run.failed`.
   */
  "snapshot.diff.load.fallback": {
    level: "info",
    message: "git cat-file --batch failed during snapshot diff, falling back to per-file git show",
    attributes: { "snapshot.refs": "count", "snapshot.stderr": "text" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /**
   * 🔴 **Batched object loading could not be SPAWNED** — the other half of the fallback above, and it
   * used to be silent.
   *
   * The `load` helper's catch arm discarded the error and answered `undefined`, so a `cat-file
   * --batch` that never started degraded to the per-file path with nothing written anywhere. The
   * fallback is correct; being silent about why is the ruling-2 shape. Distinct from
   * `snapshot.diff.load.fallback` because there is no child and therefore no stderr — this carries
   * our own caught fault, which is why it is the `fault` class and its sibling is `text`.
   */
  "snapshot.diff.load.failed": {
    level: "warn",
    message: "snapshot diff batch load failed, falling back to per-file git show",
    attributes: { "snapshot.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /**
   * Batched object output was malformed and the diff falls back to individual git-show calls.
   *
   * ⚠️ **`snapshot.header` is `text`, not `fault`** — same reasoning as `session.provider.message`
   * above. It carries a line of git's `cat-file --batch` STDOUT (`<sha> blob <size>`), decoded and
   * handed straight to the log; it is never a caught error, so no `Log.fault` call could ever
   * produce it and the classification could only ever be satisfied by a no-op wrapper. `text` is
   * the class the table already defines for *free text from a foreign process*, the sibling
   * `snapshot.reason` carries the classification, and both classes are `content: "user"` — so the
   * event's derived content class is unchanged and nothing new may egress.
   *
   * ⚠️ **This is NOT a licence to reclassify the `snapshot.*.stderr` attributes the same way**, even
   * though they also carry git output. `GitResult.stderr` is a UNION: the `git` helper's catch arm
   * in `snapshot/index.ts` puts a caught spawn failure into the same field, so those columns really
   * can hold our own error text. Deciding whether a spawn failure belongs in a `stderr` field is the
   * open question that keeps eight sites on the ledger; it is not answered here.
   */
  "snapshot.diff.parse.fallback": {
    level: "info",
    message: "git cat-file --batch output was malformed during snapshot diff, falling back to per-file git show",
    attributes: { "snapshot.reason": "id", "snapshot.header": "text" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** Git could not enumerate the tracked and untracked snapshot candidates. */
  "snapshot.files.list.failed": {
    level: "warn",
    message: "failed to list snapshot files",
    attributes: {
      "snapshot.diff.exit": "count",
      "snapshot.diff.stderr": "text",
      "snapshot.other.exit": "count",
      "snapshot.other.stderr": "text",
    },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** Git could not stage a bounded set of paths into the private snapshot index. */
  "snapshot.files.stage.failed": {
    level: "warn",
    message: "failed to add snapshot files",
    attributes: { "snapshot.exit": "count", "snapshot.stderr": "text" },
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
    attributes: { "snapshot.hash": "text", "snapshot.exit": "count", "snapshot.stderr": "text" },
    content: "user",
    file: "packages/novaclaw/src/snapshot/index.ts",
  },
  /** Git could not load the requested snapshot tree into the private index. */
  "snapshot.restore.read.failed": {
    level: "error",
    message: "failed to restore snapshot",
    attributes: { "snapshot.hash": "text", "snapshot.exit": "count", "snapshot.stderr": "text" },
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
  /** One or more jh artifact bodies exceeded the cap. Refused whole, never silently truncated. */
  "storage.artifact.body.refused": {
    level: "warn",
    message: "jh artifact body over the size cap, refused rather than truncated",
    attributes: { "storage.plan": "id", "storage.cap": "count", "storage.refused": "count" },
    content: "none",
    file: "packages/core/src/jh/store.ts",
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
    attributes: { "session.id": "correlate" },
    content: "correlated",
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
    attributes: { "session.message": "correlate" },
    content: "correlated",
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
    attributes: { "storage.project": "correlate" },
    content: "correlated",
    file: "packages/novaclaw/src/storage/storage.ts",
  },
  /** The session adhoc-recipe store could not be read; the prompt lists only configured recipes. */
  "tool.adhoc.read.failed": {
    level: "warn",
    message: "adhoc session recipes unreadable",
    attributes: { "session.id": "correlate", "tool.cause": "fault" },
    content: "user",
    file: "packages/core/src/adhoc-tools/guidance.ts",
  },
  /** The persisted tool-catalogue index could not be replaced; guidance falls back to the live manifest. */
  "tool.catalogue.index.unavailable": {
    level: "warn",
    message: "tool catalogue index unavailable, continuing with the live manifest",
    attributes: { "tool.cause": "fault" },
    content: "user",
    file: "packages/core/src/tool-catalogue-guidance.ts",
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
  /** The bundled ripgrep was absent, so a release binary is being fetched. */
  "tool.ripgrep.download.start": {
    level: "info",
    message: "downloading ripgrep",
    attributes: { "tool.url": "id" },
    content: "none",
    file: "packages/core/src/ripgrep/binary.ts",
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
  /**
   * A new worktree could not populate its checkout.
   *
   * ⚠️ **`worktree.cause` is `text` HERE and `fault` on its siblings, and the split is deliberate**
   * (`todo/logging.md` 1h, 2026-08-08). This one carries `git reset --hard`'s own stderr/stdout — a
   * foreign process's words, so `Log.fault` on it would be the identity and the class was simply
   * wrong. It could not move until the `git` helper stopped writing OUR caught spawn failure into
   * the same field; that now goes to {@link EVENTS "worktree.git.spawn.failed"}. A class is a claim
   * about who authored the value, and one name may honestly carry two authors on two events.
   */
  "worktree.checkout.failed": {
    level: "error",
    message: "worktree checkout failed",
    attributes: { "worktree.directory": "path", "worktree.cause": "text" },
    content: "user",
    file: "packages/novaclaw/src/worktree/index.ts",
  },
  /**
   * 🔴 **git itself could not be started — no process ran, so no exit code and no stderr exist.**
   *
   * Ruling 2's *the unavailable subsystem names itself*, at the point the spawn failure is caught.
   * The `git` helper's `code: 1` is a sentinel and its `stderr` is empty; this line is what says why.
   * The caller-facing `CreateFailedError`/`ListFailedError`/… still carry the fault text, because a
   * person reading a dialog has no second line to read (`reason()` in `worktree/index.ts`).
   */
  "worktree.git.spawn.failed": {
    level: "error",
    message: "git could not be started",
    attributes: { "worktree.cause": "fault" },
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
  /**
   * An explicitly configured worktree start command RAN and exited non-zero.
   *
   * ⚠️ `worktree.cause` is the shell's own stderr — same ruling as `worktree.checkout.failed`. This
   * column has been wrong in both directions: first empty (the catch discarded the error), then
   * carrying our `Log.fault` under a name that promises the child's words. It now carries only what
   * the shell said, and a shell that never started is
   * {@link EVENTS "worktree.start.spawn.failed"}.
   */
  "worktree.start.command.failed": {
    level: "error",
    message: "worktree start command failed",
    attributes: { "worktree.start.kind": "id", "worktree.directory": "path", "worktree.cause": "text" },
    content: "user",
    file: "packages/novaclaw/src/worktree/index.ts",
  },
  /** 🔴 The start command's shell could not be started, so the command never ran at all. */
  "worktree.start.spawn.failed": {
    level: "error",
    message: "worktree start command could not be started",
    attributes: { "worktree.cause": "fault" },
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
  /**
   * ⚠️ **The cause is carried, and that is `todo/logging.md` 1h's third bullet.** The 1b migration
   * deliberately preserved the old call's information loss — it named the missing adapter and threw
   * the caught error away — so the line said *which* adapter was unavailable and never *why*. Naming
   * a missing thing is not a repairable fault (ruling 2): an operator asked to fix an adapter that
   * "is not available" has nothing to act on. The finished vocabulary carries both.
   */
  "workspace.adapter.remove.failed": {
    level: "error",
    message: "adapter not available when removing workspace",
    attributes: { "workspace.adapter": "text", "workspace.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/control-plane/workspace.ts",
  },
  /** A replayed remote event could not be emitted on the local global bus. */
  "workspace.event.emit.failed": {
    level: "warn",
    message: "failed to emit global event",
    attributes: { "workspace.id": "correlate", "workspace.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/control-plane/workspace.ts",
  },
  /** A serialized remote event could not be replayed into the local event store. */
  "workspace.event.replay.failed": {
    level: "warn",
    message: "failed to replay global event",
    attributes: { "workspace.id": "correlate", "workspace.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/control-plane/workspace.ts",
  },
  /** A workspace's long-lived synchronization listener stopped unexpectedly. */
  "workspace.listener.run.failed": {
    level: "warn",
    message: "workspace listener failed",
    attributes: { "workspace.id": "correlate", "workspace.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/control-plane/workspace.ts",
  },
  /** A session record was reassigned to the current remote workspace. */
  "workspace.session.steal": {
    level: "info",
    message: "sync session stolen",
    attributes: { "session.id": "correlate", "workspace.id": "correlate" },
    content: "correlated",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/handlers/sync.ts",
  },
  /** The fenced workspace reached the named sync state. */
  "workspace.sync.complete": {
    level: "info",
    message: "workspace state fully synced",
    attributes: { "workspace.id": "correlate", "workspace.state": "id" },
    content: "correlated",
    file: "packages/novaclaw/src/server/shared/fence.ts",
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
      "session.id": "correlate",
      "workspace.events": "count",
      "workspace.sequence.first": "count",
      "workspace.sequence.last": "count",
    },
    content: "correlated",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/handlers/sync.ts",
  },
  /** A peer requested replay of a non-empty sync-event history. */
  "workspace.sync.replay.start": {
    level: "info",
    message: "sync replay requested",
    attributes: {
      "session.id": "correlate",
      "workspace.events": "count",
      "workspace.sequence.first": "count",
      "workspace.sequence.last": "count",
      "workspace.directory": "path",
    },
    content: "user",
    file: "packages/novaclaw/src/server/routes/instance/httpapi/handlers/sync.ts",
  },
  /** A mutation is fenced until the workspace reaches the named sync state. */
  "workspace.sync.wait": {
    level: "info",
    message: "waiting for workspace state",
    attributes: { "workspace.id": "correlate", "workspace.state": "id" },
    content: "correlated",
    file: "packages/novaclaw/src/server/shared/fence.ts",
  },
  /** A successful remote workspace response did not decode as the expected representation. */
  "workspace.target.decode.failed": {
    level: "warn",
    message: "workspace target response decode failed",
    attributes: { "workspace.id": "correlate", "workspace.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/control-plane/workspace.ts",
  },
  /** A request could not reach the resolved remote workspace target. */
  "workspace.target.request.failed": {
    level: "warn",
    message: "workspace target request failed",
    attributes: { "workspace.id": "correlate", "workspace.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/control-plane/workspace.ts",
  },
  /** A remote workspace target responded, but rejected the request at the HTTP boundary. */
  "workspace.target.response.rejected": {
    level: "warn",
    message: "workspace target request failed",
    attributes: { "workspace.id": "correlate", "workspace.http.status": "count", "workspace.body": "text" },
    content: "user",
    file: "packages/novaclaw/src/control-plane/workspace.ts",
  },
  /** The workspace adapter could not resolve its local or remote execution target. */
  "workspace.target.resolve.failed": {
    level: "warn",
    message: "workspace target failed",
    attributes: { "workspace.id": "correlate", "workspace.cause": "fault" },
    content: "user",
    file: "packages/novaclaw/src/control-plane/workspace.ts",
  },
  /** The final source synchronization failed before a session moved between workspaces. */
  "workspace.warp.sync.failed": {
    level: "warn",
    message: "session warp final source sync failed",
    attributes: { "workspace.id": "correlate", "session.id": "correlate", "workspace.cause": "fault" },
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
 * The content class an event's ATTRIBUTES actually imply: the **maximum** over its fields' classes.
 * Compared against the declared `content` by the test, so intent and fact cannot diverge.
 *
 * ⚠️ Three-valued since 1e. `"correlated"` is a real rung between `"none"` and `"user"`: an event
 * that carries a session id carries no content, and must still never egress. Collapsing it into
 * `"user"` would be a lie in the other direction — it would tell Settings → Developer that a drain
 * exit quotes the user, which it does not.
 */
export function derivedContent(declaration: EventDeclaration): ContentClass {
  let worst: ContentClass = "none"
  for (const name of Object.values(declaration.attributes)) {
    const content = ATTRIBUTE_CLASSES[name].content
    if (CONTENT_ORDER[content] > CONTENT_ORDER[worst]) worst = content
  }
  return worst
}

/**
 * Whether this event may leave the machine at all — the precondition for `todo/logging.md` 1f's
 * filter and for anything the maintenance plane carries. `observability/telemetry.ts` gate 4 is its
 * consumer.
 *
 * ⚠️ `"correlated"` is a refusal, exactly like `"user"`. See {@link CORRELATION_ATTRIBUTES} for the
 * argument; the short version is that a stable join key defeats the two-plane separation without
 * ever carrying content, and the maintenance plane already groups by `run=`.
 */
export const mayEgress = (key: EventKey): boolean => EVENTS[key].content === "none"

export * as LogEvents from "./log-events"
