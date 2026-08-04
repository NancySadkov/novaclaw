/**
 * `configure` — the agent-facing half of the self-healing law.
 *
 * AGENTS.md (*We promote self-healing: one working model can repair the system*): **"as long as at
 * least one working model remains, the system must be restorable to a working state by asking an
 * agent — never by hand-editing config files and never by rebuilding from source."** Every
 * operational fact an outage can hinge on already lives in a runtime-editable SQLite store behind
 * `ConfigStoreWrite`. Until this tool there was no path from a MODEL to that store: `PATCH /config`
 * is an HTTP surface, and nothing hands a session its own instance's URL or token
 * (`tool/bash.ts` injects `NOVACLAW_INSTANCE_<PEER>_*` for PEERS only). So the law was true of the
 * architecture and false of the product.
 *
 * ── WHY IN-PROCESS AND NOT OVER HTTP ───────────────────────────────────────────────────────────
 *
 * This calls `ConfigStoreWrite.apply` / `.overlay` directly. todo.md ruling 4 rules out the obvious
 * alternative by name — a self URL + token in the shell env — because it "converts a privileged
 * write into an uncontainable command string, and `egressEnv()` kills it in exactly the airgapped
 * case the law is written for". In-process also needs no port discovery and no listening server, so
 * it works in a headless CLI run and inside an airgap, which is where a repair is most likely needed.
 *
 * ── RULING 4: THE PRIVILEGE TIERS, AND WHAT ENFORCES THEM ──────────────────────────────────────
 *
 * *"Config writes are privilege-tiered — operational · consequential · privileged — enforced in the
 * permission evaluator's HARD arm behind an in-process `configure` tool, unclassified ⇒ privileged.
 * Tier-1 needs a fourth test beyond 'is it a value': no text that reaches a future session's prompt."*
 *
 * ⚠️ **The enforcement seam is the permission ACTION this tool spends, not the evaluator's hard arm,
 * and that is a correction to the ruling's wording rather than a shortcut.** The hard arm in
 * `permission.ts` is a pre-emptive DENY arm — checked before any allow is consulted, so nothing can
 * soften it. It can express one verdict. Tiering needs THREE (no card · a card · a card the user
 * cannot pre-grant with a single rule), and the machinery that already produces three verdicts from
 * an action name is the ordinary evaluator: the ambient-safe baseline, the agent ruleset, the mode
 * overlay and saved answers all key on `action`. Putting a table of config keys inside the evaluator
 * would also invert the layering — the permission kernel would have to import `Config.Info`.
 *
 * So the three tiers are three different asserts:
 *
 *  · **operational** — no assert at all. The key passes all three ambient-safe tests
 *    (`permission.ts` §AMBIENT-SAFE BASELINE: cannot mutate the host, cannot egress, cannot change
 *    what a later turn or session runs) AND ruling 4's fourth test (no text reaches a future
 *    session's prompt). A repair here costs the user nothing.
 *  · **consequential** — asserts `configure`. One card, `save` scoped to the KEY, so an "always"
 *    answer is a standing grant for that one key and for no other.
 *  · **privileged** — asserts `configure_privileged`. Same per-key `save`, but a SEPARATE action, so
 *    a user (or an agent config, or a saved "always") can grant every consequential write with one
 *    rule — `{action: "configure", resource: "*", effect: "allow"}` — while granting no privileged
 *    one. That is the whole mechanical difference between the two gated tiers, and it is the
 *    difference that matters: it is the only way to give an UNATTENDED run a repair capability
 *    without also giving it `plugins`, `mcp`, `shell` and `permissions`.
 *
 * Both actions are absent from `AMBIENT_SAFE_BASELINE`, so on a default install they fall through to
 * `evaluate`'s `ask`. Under an UNATTENDED chain that ask is converted to an immediate refusal by
 * `evaluateInput`'s last arm (`unattended-unanswerable`) — which is the correct answer and is
 * inherited for free: an unattended agent may make operational repairs, and needs a grant made in
 * advance for anything else.
 *
 * ⚠️ **`save: [key]`, never `save: ["*"]`.** `recipe.ts` argues this for a durable instance-global
 * write and the argument is stronger here: a wildcard "always" answered once for `tool_output` would
 * be a standing grant to rewrite `permissions` in every later session. Per-key is the honest price.
 *
 * ── UNCLASSIFIED ⇒ PRIVILEGED, STRUCTURALLY ────────────────────────────────────────────────────
 *
 * `KEY_TIERS` is typed `Readonly<Record<keyof Config.Info, Tier>>` — the `SESSION_CONFIG_FIELDS`
 * idiom (`session/config-resolve.ts`) — so a new `Config.Info` field is a COMPILE error here until
 * somebody classifies it. That is one of three layers, because ruling 1 wants the invariant to hold
 * even when the first layer is bypassed:
 *  1. the `Record` type — a missing key does not compile;
 *  2. `tierOf()` answers `"privileged"` for any key it does not know, so an incomplete table is
 *     SAFE at runtime rather than open;
 *  3. `test/tool-configure.test.ts` compares the table against `Config.Info.fields` in BOTH
 *     directions and pins the three tiers by name, so a reclassification is a deliberate edit that
 *     shows up in a diff rather than a quiet widening.
 *
 * ── HOW A KEY IS PRICED ────────────────────────────────────────────────────────────────────────
 *
 * **A key's tier is the highest privilege ANY value it can carry commands.** The table is per
 * TOP-LEVEL key (ruling 4's "scope it per-key"), so a key with one dangerous leaf is dangerous:
 * `providers` would look operational if you only read `api.url`, but `providers.<id>.models.<id>.
 * prePrompt` is *"prepended to the system context"* (`config/provider.ts`), so the key carries a
 * prompt-text channel and is priced at the top tier.
 *
 * Privileged means the write can, by itself: (a) execute something on the host, (b) send user data
 * to a destination the write chooses, (c) put text into a future session's prompt, (d) change who
 * may do what — permissions, credentials, account tokens, the airgap, a consent flag — or (e) change
 * which binaries this instance runs. Consequential means none of those, but the instance behaves
 * differently afterwards in a way the user should get to see. Operational means neither.
 *
 * ⚠️ **The operational tier is FIVE keys out of 44, and that is the measurement, not a failure of
 * nerve.** The config surface really is mostly execution surfaces, prompt text and endpoint URLs —
 * which is architectural review finding S2 (*"the config store is a code-execution surface every
 * dimension modelled as data"*) restated as a count. The self-healing law is unharmed by that: it
 * demands that a repair be reachable BY ASKING AN AGENT rather than by editing a file, and a consent
 * card naming the key is the agent doing the repair with the user in the loop. What the law forbids
 * — "restart, hand-edit `novaclaw.jsonc`, rebuild" — is gone either way.
 *
 * ⚠️ **The endpoint keys were priced deliberately, not reflexively.** A hostile `baseURL` is not "a
 * setting"; every later turn POSTs the whole prompt — the user's code, files and recalled memories —
 * to the attacker's host, with the provider Authorization header attached. That is total data-plane
 * exfiltration against AGENTS.md's *"your data never egresses"*, so `providers`/`models`/`memory`/
 * `web_search` are privileged. `provider_presets` is NOT, and the distinction is real rather than
 * cosmetic: a preset changes no live provider — it "only shape[s] FUTURE imports"
 * (`config/provider-preset.ts`), and an import is a user-driven flow that shows the URL and asks for
 * a key. It is also the exact repair AGENTS.md names as its worked example.
 *
 * ── WHAT THIS TOOL DELIBERATELY DOES NOT DO ────────────────────────────────────────────────────
 *
 * ⚠️ **It cannot DELETE a key.** `ConfigStoreWrite` is patch-MERGE with no null-deletion
 * (`merge-patch.ts`), so there is no value that means "unset this". Saying so in the description is
 * ruling 2 — a model that believes it removed a setting and did not would report a repair it never
 * made. Clearing a value is a Settings-UI job today.
 *
 * ⚠️ **`read` redacts credentials and cannot un-redact them.** `overlay` returns everything the
 * settings store holds, including `server.password` (this instance's own incoming API token) and
 * every `instances[].token` (documented as granting a peer FULL API access, and ruling 5 calls the
 * peer token *account-equivalent*). Handing those to a model puts them in a transcript, a compaction
 * summary and possibly a messenger reply. `read` is ungated precisely BECAUSE it is redacted; if the
 * redaction is ever removed, the read op has to be gated in the same edit.
 *
 * ⚠️ **It is not the tier enforcement for `PATCH /config`.** That surface has its own caller (a user
 * in Settings, or Import) and its own guard (`rejectUnknownConfigKeys`). This table would make that
 * work cheaper — it is per-key and it is exported — but wiring it there is a different unit.
 */
export * as ConfigureTool from "./configure"

import { ToolFailure } from "@novaclaw/llm"
import { Cause, Effect, Exit, Layer, Schema, SchemaIssue } from "effect"
import { AgentConfigStore } from "../agent-config-store"
import { CatalogStore } from "../catalog-store"
import { CommandConfigStore } from "../command-config-store"
import { Config } from "../config"
import { ConfigStoreWrite } from "../config-store-write"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { PluginConfigStore } from "../plugin-config-store"
import { ReferenceConfigStore } from "../reference-config-store"
import { SettingsConfigStore } from "../settings-config-store"
import { SkillConfigStore } from "../skill-config-store"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "configure"

// ── the tiers ─────────────────────────────────────────────────────────────────────────────────

export const TIERS = ["operational", "consequential", "privileged"] as const
export type Tier = (typeof TIERS)[number]

/** The permission action each GATED tier spends. `operational` is absent because it asserts nothing —
 *  that absence is the tier, and a reader looking for a third entry should find this sentence. */
export const TIER_ACTION = {
  consequential: name,
  privileged: `${name}_privileged`,
} as const satisfies Record<Exclude<Tier, "operational">, string>

/**
 * **Every `Config.Info` key, priced.** See the header for the rule (a key's tier is the highest
 * privilege any value it can carry commands) and for what each tier costs.
 *
 * ⚠️ The `Record<keyof Config.Info, Tier>` annotation is the ratchet: a new config key does not
 * compile until it is classified here. Do not widen the type.
 */
export const KEY_TIERS: Readonly<Record<keyof Config.Info, Tier>> = {
  // ── operational: no card ────────────────────────────────────────────────────────────────────
  // Inert by construction: on `ConfigStoreWrite.NOT_ROUTED_KEYS`, so it is accepted and discarded,
  // and no runtime reader consults it. It exists so the product's own export→import round trip works.
  $schema: "operational",
  // Image resize thresholds. Numbers and a boolean; no command, no endpoint, no text.
  attachments: "operational",
  // The session's own context-reclaim policy. `prune` MARKS rows already out of the model's context
  // (`session/compaction-prune.ts`); it destroys no stored message, so "a read never destroys" holds.
  compaction: "operational",
  // Closed percentages governing what the agent sends to its own model; no text, endpoint,
  // execution, egress, or destructive store action. Like compaction, this is self-repairable policy.
  context: "operational",
  // A bounded numeric liveness limit for the agent's own provider connection. It changes no
  // endpoint, prompt, permission or host state, and is the self-healing escape hatch for a slow
  // local model whose first event legitimately takes longer than the compiled default.
  provider_connection: "operational",
  // Pins in the directory picker's rail. Grepped 2026-07-31: the only consumers are
  // `dialog-select-directory-v2.tsx` and `pages/files.tsx` — presentation, granting no access, and
  // `config.ts` already documents the key as agent-editable for self-healing.
  folder_bookmarks: "operational",
  // The agent's own truncation budget. Raising it spends the agent's own context and nothing else.
  tool_output: "operational",

  // ── consequential: one card, savable per key ────────────────────────────────────────────────
  // Sampling numbers plus an enable flag. The nudge TEXT is compiled, not configured.
  affective: "consequential",
  // Both provider filters can leave the instance with NO working model — and "at least one working
  // model remains" is the self-healing law's own precondition, i.e. the one outage this tool could
  // create that this tool could not then repair. Not privileged: no execution, no egress, no text.
  disabled_providers: "consequential",
  enabled_providers: "consequential",
  // A closed enum of three. It selects a COMPILED prompt hint (`harness-config.ts` maps "normal" to
  // `EXPERTISE_HINT`) and the UI's disclosure tier, so it changes a future prompt without being able
  // to carry a single byte of attacker text — which is why it clears the fourth test and stops here.
  expertise: "consequential",
  // Selects which ALREADY-INSTALLED model every later turn runs on: it redirects the conversation to
  // a different endpoint the user set up, and a bad value leaves nothing that answers.
  model: "consequential",
  // Changes no live provider — presets "only shape FUTURE imports", and an import is a user-driven
  // flow that shows the URL and asks for a key. This is AGENTS.md's own worked repair example.
  provider_presets: "consequential",
  // ⚠️ Ruling 4's own annotation, already in `config.ts`: "CONSEQUENTIAL, never operational — an
  // agent that can lower its own floor has exempted itself from the guard."
  resource_pressure: "consequential",
  // Turning snapshots off removes the user's undo/revert safety net. Same shape as lowering the
  // resource floor: nothing runs, nothing leaves, but a guard the user relies on is gone.
  snapshots: "consequential",
  // Harness booleans and budgets (jh.md). No prompt text, no command, no endpoint.
  strict: "consequential",
  // Ordered booleans over ALREADY-REGISTERED tools. The table can change a model's working set or
  // strand its repair tool, but registry permissions remain the final ceiling and cannot be widened.
  tool_routing: "consequential",
  // Real filesystem vs an app-private root — it decides what the product will browse at all.
  virtualFs: "consequential",
  // The FS watcher's ignore globs: it decides which file changes the product NOTICES, so a write
  // here can make the agent's own edits invisible in the user's live view.
  watcher: "consequential",

  // ── privileged: one card each, never pre-grantable with a single `configure` rule ────────────
  // Manuals the model pulls into its context on demand — ruling 4 names this key by itself.
  adhoc_tools: "privileged",
  // Markdown that BECOMES a system prompt, plus each agent's own permission ruleset and tool list.
  agents: "privileged",
  // Governs whether this instance downloads and runs new binaries; AGENTS.md gates the switch behind
  // Developer mode.
  autoupdate: "privileged",
  // Markdown that becomes a prompt (slash commands).
  commands: "privileged",
  // Selection is authorship here: the default agent decides the system prompt AND the permission
  // ruleset every future session opens with.
  default_agent: "privileged",
  // `experimental.policies` are provider allow/deny rules — a policy surface, evaluated in `catalog.ts`.
  experimental: "privileged",
  // `command: string[]`, executed over the user's files. An execution surface.
  formatter: "privileged",
  // Paths or URLs whose contents become ambient instructions in the prompt.
  instructions: "privileged",
  // A peer URL plus its token. Ruling 5: the peer token is ACCOUNT-EQUIVALENT, and `config.ts`
  // documents the entry as granting full API access — sessions, registry, config.
  instances: "privileged",
  // `prompt` and `interjection` are text steered into a running session; `model` picks the judge.
  introspection: "privileged",
  // Chooses the URL and expected digest of binaries/models Nova downloads and executes.
  local_model_catalog: "privileged",
  // `mcp.servers` spawns a child process — ruling 4 names it as an execution surface.
  mcp: "privileged",
  // `memory.embedding.url` is the endpoint the user's own memories are POSTed to for embedding.
  memory: "privileged",
  // The flat models-primary map: every entry carries its own endpoint `url` AND a `prePrompt` that is
  // prepended to the system context. Both halves are top-tier on their own.
  models: "privileged",
  // The airgap itself. Turning it off RELEASES the egress guard, which is the one switch that makes
  // every other egress possible.
  offline: "privileged",
  // The gate itself. Nothing else on this list is worth much if an agent can rewrite this one.
  permissions: "privileged",
  // Prepended to EVERY agent's system prompt. Ruling 4 names it.
  persona: "privileged",
  // `npm.add` + `import()` — outside code in our process. Ruling 5 is retiring this arm entirely.
  plugins: "privileged",
  // Endpoint URLs (egress of every prompt and the Authorization header) plus per-model `prePrompt`,
  // which `config/provider.ts` describes as "prepended to the system context".
  providers: "privileged",
  // `quality.commands` are command lines the runner executes. An execution surface (S2 names it).
  quality: "privileged",
  // Named local directories or GIT REPOSITORIES: a remote entry fetches, writes to disk, and its
  // content becomes context.
  references: "privileged",
  // `password` is this instance's own incoming API token; `hostname` and `cors` decide who can reach
  // it at all.
  server: "privileged",
  // The shell every terminal and `bash` call runs through. Ruling 4 names it.
  shell: "privileged",
  // Paths or URLs skills are discovered from — a skill is instructions the model reads, and a URL
  // entry fetches them from a third party.
  skills: "privileged",
  // A consent flag for outbound reporting. Flipping a user's consent on their behalf is theirs to do.
  telemetry: "privileged",
  // Free text the `profile` tool hands to the model on demand (`tool/profile.ts`).
  user_profile: "privileged",
  // Not cosmetic: `tool/profile.ts` falls back to `username` as the profile name it delivers to the
  // model, so this key is free text that reaches a future session's context.
  username: "privileged",
  // `searxngUrl` REPLACES the built-in engines, so every later search query goes to that host and
  // whatever it returns becomes context.
  web_search: "privileged",
}

/**
 * The tier a key is written at. **Unknown ⇒ privileged**, so an incomplete table is safe rather than
 * open — layer 2 of the three the header describes.
 */
export const tierOf = (key: string): Tier => (KEY_TIERS as Record<string, Tier | undefined>)[key] ?? "privileged"

/** Every key `Config.Info` declares, read off the schema rather than re-typed.
 *  A function, not a module-level constant: `config.ts` sits in an import cycle with the settings
 *  seed, and that file's own ⚠️ says every `Config.Info` derivation stays inside a function body. */
export const configKeys = (): string[] => Object.keys(Config.Info.fields)

// ── rendering (pure; unit-tested) ─────────────────────────────────────────────────────────────

export const REDACTED = "(redacted — configure can WRITE this value, it will not read one back)"

/** Scalar fields whose value is a credential wherever it appears in a config document. */
const SECRET_FIELDS = new Set(["password", "token", "apikey", "api_key", "secret"])

/**
 * Replace credential-shaped values with `REDACTED`, recursively.
 *
 * Only STRING values are replaced, which is what keeps this from over-firing on a record KEY that
 * happens to be spelled like a secret: `providers.token` names a provider and holds an object, so it
 * recurses. The one residual over-fire is a provider (or model, or agent) literally named `headers`,
 * whose string fields would read back redacted — an over-redaction, never an under-redaction, and it
 * cannot affect a write, which never passes through here.
 */
export const redactSecrets = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (value === null || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase()
    if (typeof entry === "string" && SECRET_FIELDS.has(lower)) {
      out[key] = REDACTED
      continue
    }
    // Request headers are the other place a user can park a bearer token by hand.
    if (lower === "headers" && entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      out[key] = Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(([header, headerValue]) => [
          header,
          typeof headerValue === "string" ? REDACTED : redactSecrets(headerValue),
        ]),
      )
      continue
    }
    out[key] = redactSecrets(entry)
  }
  return out
}

/** Per-key value budget in the unfiltered read. A whole `providers` tree can be tens of kilobytes,
 *  and a repair loop that blows its own context on the survey never reaches the write. */
const SURVEY_LIMIT = 400
const DETAIL_LIMIT = 8_000

const render = (value: unknown, limit: number): string => {
  if (value === undefined) return "(not set)"
  const text = JSON.stringify(value) ?? String(value)
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}… (truncated — ask for this key on its own: {"op":"read","keys":["…"]})`
}

/** One line per key: what it is worth, and what it currently holds. */
export const formatRead = (input: {
  readonly keys: readonly string[]
  readonly values: Record<string, unknown>
  readonly filtered: boolean
}): string => {
  const limit = input.filtered ? DETAIL_LIMIT : SURVEY_LIMIT
  const lines = input.keys.map((key) => `${key} [${tierOf(key)}] = ${render(input.values[key], limit)}`)
  return [
    input.filtered
      ? "Requested configuration keys:"
      : `This instance's configuration — all ${input.keys.length} keys, with the privilege each write costs:`,
    ...lines,
    "",
    "operational = written without asking · consequential = one approval, per key · privileged = one approval, per key, and it cannot be pre-granted by a rule that covers consequential writes.",
    'Write with {"op":"set","config":{"<key>":<value>}}. Values MERGE (objects merge, arrays replace); nothing here can delete a key.',
  ].join("\n")
}

/** What actually landed. Ruling 2 — a key the router accepted and discarded is NOT reported as stored. */
export const formatWrite = (input: {
  readonly requested: readonly string[]
  readonly consumed: ReadonlySet<string>
}): string => {
  const stored = input.requested.filter((key) => input.consumed.has(key))
  const discarded = input.requested.filter((key) => !input.consumed.has(key))
  return [
    stored.length > 0
      ? `Saved to this instance's configuration: ${stored.join(", ")}. It is live now — no restart.`
      : "Nothing was stored.",
    discarded.length > 0
      ? `Accepted and DISCARDED (this instance stores no value for ${discarded.join(", ")}, so nothing changed there).`
      : "",
    'Read it back with {"op":"read","keys":["' + (stored[0] ?? input.requested[0] ?? "shell") + '"]}.',
  ]
    .filter(Boolean)
    .join("\n")
}

/** The refusal for a key `Config.Info` does not declare. The in-process twin of the wire's
 *  `rejectUnknownConfigKeys` 400, which names every offender rather than dropping them — because an
 *  agent that PATCHes a typo, is told nothing, re-reads and finds nothing cannot tell a typo from a
 *  broken instance, so it loops. */
export const unknownKeyMessage = (unknown: readonly string[], known: readonly string[]): string =>
  `Nothing was written. ${unknown.length === 1 ? "This is not a configuration key" : "These are not configuration keys"}: ` +
  `${unknown.map((key) => `"${key}"`).join(", ")}. ` +
  `The keys this instance has are: ${[...known].sort().join(", ")}. ` +
  `Call {"op":"read"} to see them with their current values.`

// ── the tool ──────────────────────────────────────────────────────────────────────────────────

const ReadOp = Schema.Struct({
  op: Schema.Literal("read"),
  keys: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description:
      'Configuration keys to show in full, e.g. ["providers","model"]. Omit to survey every key (values abbreviated).',
  }),
})

const SetOp = Schema.Struct({
  op: Schema.Literal("set"),
  config: Schema.Record(Schema.String, Schema.Unknown).annotate({
    description:
      "A configuration patch: top-level configuration keys mapped to their new values, exactly the shape " +
      '`read` shows. Example: {"models":{"qwen":{"url":"http://192.168.1.5:8000/v1"}}}. ' +
      "Objects merge into what is stored; arrays replace wholesale. A key or a field this instance does " +
      "not have is refused and named, so read the key first if you are unsure of its shape.",
  }),
})

export const Input = Schema.Union([ReadOp, SetOp])

export const Output = Schema.Struct({
  op: Schema.Literals(["read", "set"]),
  message: Schema.String,
})
export type Output = typeof Output.Type

export const description =
  "Repair or change THIS instance's own configuration — provider endpoints, models, presets, and every " +
  "instance setting — without editing files or restarting. Ops: " +
  '{"op":"read"} — every configuration key, what it holds, and what changing it costs · ' +
  '{"op":"read","keys":["providers"]} — one key in full · ' +
  '{"op":"set","config":{"models":{"qwen":{"url":"http://192.168.1.5:8000/v1"}}}} — write. ' +
  "READ A KEY BEFORE YOU WRITE IT and follow the shape you get back: a field name this instance does " +
  "not have is refused by name rather than quietly dropped. " +
  "Values MERGE into what is stored (objects merge, arrays replace wholesale); this tool cannot " +
  "DELETE a key. Most writes ask the user first and say so before anything is stored; a write that " +
  "is refused changes nothing at all. Credentials read back redacted."

const failure = (message: string) => new ToolFailure({ message })

/**
 * ⚠️ `onExcessProperty: "error"`, which is a DELIBERATE divergence from every other decode of
 * `Config.Info` in the tree, and the reason is ruling 2.
 *
 * The unknown-key guard above only sees TOP-LEVEL keys — so does the wire's `rejectUnknownConfigKeys`
 * — which leaves a nested typo decoding to an EMPTY object, committing nothing, and answering
 * SUCCESS. Measured 2026-07-31 under the tree's usual lenient options: `{tool_output:{max_linez:5}}`
 * and `{mcp:{servers:{fs:{type:"local",command:["x"],enabled:true}}}}` (the field is `disabled`) both
 * report a saved write and store nothing that was asked for. That is the same silent-drop shape the
 * wire guard was written to close, one level down, and it is the shape a MODEL produces — it guesses
 * a field name far more often than it invents a top-level key.
 *
 * The two other decoders keep `"ignore"` for reasons that do not apply to a tool call: the SEED reads
 * a hand-authored file that may have been written for any version of NovaClaw and is applied at boot
 * with nobody to answer, and `settings-config-seed.ts` already argues that ignoring is the
 * recoverable behaviour THERE. A tool call is a deliberate mutation with a live caller who can act on
 * "that field does not exist" and cannot act on silence.
 *
 * ⚠️ Being stricter than `PATCH /config` is only defensible while the shapes the self-healing law
 * depends on still decode, so that was MEASURED before this was adopted rather than assumed: over 29
 * realistic patches, `"error"` and `"ignore"` differed on exactly three — and all three were invented
 * field names (`agents.*.temperature`, `mcp.*.enabled`, `resource_pressure.memory.*`), i.e. three for
 * three in the honest direction. The accepted shapes are pinned in `test/tool-configure.test.ts`
 * ("the endpoint repairs the self-healing law depends on are accepted verbatim"), so if this ever
 * refuses a real repair, THAT test fails and this option is what is wrong.
 */
const DECODE_OPTIONS = { errors: "all", onExcessProperty: "error", propertyOrder: "original" } as const

/**
 * A decode failure, as a sentence that names the FIELD.
 *
 * ⚠️ The path is the load-bearing half and it is not in `issue.message` — `settings-config-seed.ts`'s
 * `decodeFailureReason` joins the messages alone, which is right there (it already knows the key,
 * because it probes one key at a time and reports the key beside the reason) and useless here:
 * measured 2026-07-31, a `tool_output.max_linez` typo formats as *"Unexpected key with value 5"*,
 * which tells a repairing agent nothing it can act on. Rendering `path` turns it into
 * *"tool_output.max_linez: Unexpected key with value 5"*, which is the next tool call.
 */
const decodeReason = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  if (Schema.isSchemaError(error)) {
    const issues = SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map((issue) => {
      const path = (issue.path ?? []).map((segment) => String(segment)).join(".")
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message
    })
    if (issues.length > 0) return issues.join("; ")
  }
  return String(error)
}

/**
 * Decode the model's object into a `Config.Info` patch, naming the OFFENDING KEY on failure.
 *
 * Whole-document first (the common case, and the only one that costs nothing), then a per-key probe
 * to attribute the failure — every `Config.Info` field is optional, so a single-key object is a valid
 * probe. That is `settings-config-seed.ts`'s salvage trick used for a different purpose: not to keep
 * the good keys, but so the message says WHICH key was wrong instead of dumping a union mismatch.
 */
export const decodePatch = (values: Record<string, unknown>): Effect.Effect<Config.Info, ToolFailure> =>
  Effect.suspend(() => {
    const whole = Schema.decodeUnknownExit(Config.Info)(values, DECODE_OPTIONS)
    if (Exit.isSuccess(whole)) return Effect.succeed(whole.value)
    const offenders: string[] = []
    for (const [key, value] of Object.entries(values)) {
      const one = Schema.decodeUnknownExit(Config.Info)({ [key]: value }, DECODE_OPTIONS)
      if (Exit.isFailure(one)) offenders.push(`"${key}" — ${decodeReason(one.cause)}`)
    }
    return Effect.fail(
      failure(
        `Nothing was written: the value does not fit the configuration schema. ${
          offenders.length > 0 ? offenders.join(" · ") : decodeReason(whole.cause)
        }. Call {"op":"read","keys":[…]} to see the shape this instance stores today.`,
      ),
    )
  })

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    // The stores `ConfigStoreWrite.apply`/`overlay` resolve at call time. Captured once here rather
    // than threaded per call, because `Tool.make`'s `execute` must have `R = never` — the same
    // capture `filesystem/watcher.ts` and `pty.ts` use for their callbacks. Listing the union
    // explicitly is what makes the node's `deps` below a checkable claim rather than a guess.
    const stores = yield* Effect.context<
      | Database.Service
      | SettingsConfigStore.Service
      | CatalogStore.Service
      | AgentConfigStore.Service
      | CommandConfigStore.Service
      | ReferenceConfigStore.Service
      | SkillConfigStore.Service
      | PluginConfigStore.Service
    >()

    yield* tools
      .register({
        [name]: Tool.withDeferred(
          Tool.make({
            description,
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const known = configKeys()

                if (input.op === "read") {
                  // An empty (or all-blank) `keys` array means "no filter" rather than "show nothing":
                  // rendering zero lines under a "Requested configuration keys:" header would be a
                  // report that describes itself falsely.
                  const trimmed = input.keys?.map((key) => key.trim()).filter((key) => key.length > 0)
                  const requested = trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
                  if (requested !== undefined) {
                    const unknown = requested.filter((key) => !known.includes(key))
                    if (unknown.length > 0) return yield* failure(unknownKeyMessage(unknown, known))
                  }
                  const stored = yield* ConfigStoreWrite.overlay({}).pipe(Effect.provide(stores))
                  // Redact BEFORE anything can be rendered: `overlay` returns `server.password` and
                  // every peer token verbatim, and a model that has seen one has put it in a
                  // transcript. See the ⚠️ in this file's header.
                  const values = redactSecrets(stored) as Record<string, unknown>
                  return {
                    op: "read" as const,
                    message: formatRead({
                      keys: requested ?? known,
                      values,
                      filtered: requested !== undefined,
                    }),
                  }
                }

                const requested = Object.keys(input.config).filter((key) => input.config[key] !== undefined)
                if (requested.length === 0)
                  return yield* failure(
                    'Nothing was written: `config` was empty. Name at least one key, e.g. {"op":"set","config":{"shell":"bash"}}.',
                  )
                // Refuse an undeclared key BY NAME before anything else runs. The schema decode below
                // would silently drop it (`onExcessProperty: "ignore"`), which is precisely the ruling-2
                // violation the wire path closed with `rejectUnknownConfigKeys`.
                const unknown = requested.filter((key) => !known.includes(key))
                if (unknown.length > 0) return yield* failure(unknownKeyMessage(unknown, known))

                const patch = yield* decodePatch(input.config)

                // One assert per GATED tier, carrying only that tier's keys — so the card names what it
                // is really about, and a saved "always" is scoped to those keys and that tier's action.
                //
                // ⚠️ BOTH cards are answered BEFORE anything is written, which is the only arrangement
                // that matches `apply`'s all-or-nothing transaction: approving the consequential card
                // and refusing the privileged one writes NEITHER, rather than half the patch. A refused
                // second card leaves the store exactly as it was.
                //
                // ⚠️ And a `configure_privileged -> deny` rule does NOT withdraw the tool: the horizon
                // filter (`registry.ts` `whollyDisabled`) resolves the REGISTERED name, so it keys on
                // `configure`. That is the behaviour we want — denying privileged writes must leave
                // `read` and the operational tier working, since that is the half a locked-down
                // instance still needs. Denying `configure` itself withdraws the whole tool.
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                for (const tier of ["consequential", "privileged"] as const) {
                  const keys = requested.filter((key) => tierOf(key) === tier)
                  if (keys.length === 0) continue
                  yield* permission.assert({
                    action: TIER_ACTION[tier],
                    resources: keys,
                    save: keys,
                    // The values are not in `resources` on purpose: `resources` doubles as the saved
                    // rule pattern, so a value there would make every "always" answer a dead rule that
                    // matches one exact string. They ride `metadata`, the channel the attachment
                    // protection already uses for "why is this being asked".
                    metadata: { tier, values: Object.fromEntries(keys.map((key) => [key, input.config[key]])) },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                }

                const exit = yield* ConfigStoreWrite.apply(patch).pipe(Effect.provide(stores), Effect.exit)
                if (Exit.isFailure(exit)) {
                  // ⚠️ Ruling 2 IN BOTH DIRECTIONS, which is why this does not paraphrase. `apply` can
                  // fault two ways and they have opposite outcomes: an unrouted key rolls the whole
                  // write back, while a domain that could not re-materialise leaves the write COMMITTED
                  // and merely not live. Both messages are written for exactly this reader and both say
                  // which case they are, so the tool passes them through under a prefix that claims
                  // neither. Calling the second one "failed" would send the model to re-send a write
                  // that already landed.
                  return yield* failure(
                    `The configure write did not finish cleanly. The kernel reported: ${decodeReason(exit.cause)}`,
                  )
                }
                return { op: "set" as const, message: formatWrite({ requested, consumed: exit.value }) }
              }).pipe(
                Effect.mapError((error) => {
                  if (error instanceof ToolFailure) return error
                  // A denial keeps its identity — including the unattended deny-fast wording, which is
                  // the one an unattended repair run actually needs to read.
                  const denial = PermissionV2.denialMessage(error)
                  if (denial) return failure(`Nothing was written. ${denial}`)
                  return failure(`configure failed: ${error instanceof Error ? error.message : String(error)}`)
                }),
              ),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/configure",
  layer,
  deps: [
    ToolRegistry.node,
    PermissionV2.node,
    Database.node,
    SettingsConfigStore.node,
    CatalogStore.node,
    AgentConfigStore.node,
    CommandConfigStore.node,
    ReferenceConfigStore.node,
    SkillConfigStore.node,
    PluginConfigStore.node,
  ],
})
