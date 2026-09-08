/**
 * **The per-key privilege tier table** — todo.md ruling 4's pricing of every `Config.Info` key, and
 * the one redaction sentence the read paths share.
 *
 * ── WHY THIS IS ITS OWN MODULE, AND WHY IT IMPORTS NOTHING AT RUNTIME ──────────────────────────
 *
 * The table was born in `tool/configure.ts` and had exactly two consumers: that tool, and
 * `config-projection.ts` (which joins a key's tier onto its schema description, and reuses the same
 * {@link REDACTED} sentence so the two surfaces cannot drift into two vocabularies). Then the tool
 * needed the projection for its `schema` op — and the two files closed an **ESM cycle that was safe
 * in only one import order**.
 *
 * ⚠️ **Measured 2026-08-07, not argued.** With a static `import { ConfigProjection }` in
 * `tool/configure.ts`, a module importing **`tool/configure` first** died with *"ReferenceError:
 * Cannot access 'REDACTED' before initialization"* at `config-projection.ts:580`, while one importing
 * the projection first ran clean — and **`tsgo --noEmit` was green either way**, so the defect was
 * invisible to the typechecker and to whichever tests happened to import in the lucky order. The
 * workaround was a dynamic `Effect.promise(() => import("../config-projection"))` inside the tool's
 * layer; this module is the fix that let the static import come back.
 *
 * The rule that keeps it fixed: **this file must never import a module that can reach either of
 * them.** Its only import is `type`-only, so it has **no runtime edge at all** — nothing can be
 * evaluated before it, which is what makes it safe in every import order rather than in one.
 *
 * ⚠️ **The `type`-only import is also what keeps the ratchet legal.** `config.ts` sits in an import
 * cycle with the settings seed, and its ⚠️ requires every `Config.Info` DERIVATION to stay inside a
 * function body ({@link ../config-projection}'s `nodeAt`, `tool/configure.ts`'s `configKeys`).
 * `keyof Config.Info` is a type, not a derivation: it costs nothing at runtime and reads no field.
 * Do not add a module-scope `Object.keys(Config.Info.fields)` here — that would re-create, one file
 * over, the bug this module removes.
 *
 * ── UNCLASSIFIED ⇒ PRIVILEGED, STRUCTURALLY ────────────────────────────────────────────────────
 *
 * {@link KEY_TIERS} is typed `Readonly<Record<keyof Config.Info, Tier>>` — the `SESSION_CONFIG_FIELDS`
 * idiom (`session/config-resolve.ts`) — so a new `Config.Info` field is a COMPILE error here until
 * somebody classifies it. That is one of three layers, because ruling 1 wants the invariant to hold
 * even when the first layer is bypassed:
 *  1. the `Record` type — a missing key does not compile;
 *  2. {@link tierOf} answers `"privileged"` for any key it does not know, so an incomplete table is
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
 * ⚠️ **The operational tier is the SHORT list, and that is the measurement, not a failure of nerve.**
 * *No count is written in this sentence on purpose* — one was, it read "FIVE keys out of 44", it was
 * true the day it was authored (`b5332b92f`, 2026-07-31) and false by 2026-08-07, and prose does not
 * recompute. {@link KEY_TIERS} below is the source; `test/tool-configure.test.ts` pins all three
 * tiers BY NAME, so a re-pricing is a decision visible in a diff and a recount is a `filter` rather
 * than an edit. What the partition says is that the config surface really is mostly execution
 * surfaces, prompt text and endpoint URLs — architectural review finding S2 (*"the config store is a
 * code-execution surface every dimension modelled as data"*) restated as a partition. The
 * self-healing law is unharmed by that: it demands that a repair be reachable BY ASKING AN AGENT
 * rather than by editing a file, and a consent card naming the key is the agent doing the repair with
 * the user in the loop. What the law forbids — "restart, hand-edit `novaclaw.jsonc`, rebuild" — is
 * gone either way.
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
 * ⚠️ **This is not the tier enforcement for `PATCH /config`.** That surface has its own caller (a
 * user in Settings, or Import) and its own guard (`rejectUnknownConfigKeys`). This table would make
 * that work cheaper — it is per-key and it is exported — but wiring it there is a different unit.
 *
 * What each tier COSTS a caller, and which action it spends, is `tool/configure.ts`'s header: the
 * tiers are three different `permission.assert` calls, and that is the tool's business, not the
 * table's.
 */
export * as ConfigTier from "./config-tier"

import type { Config } from "./config"

export const TIERS = ["operational", "consequential", "privileged"] as const
export type Tier = (typeof TIERS)[number]

/** The permission action each GATED tier spends. `operational` is absent because it asserts nothing —
 *  that absence is the tier, and a reader looking for a third entry should find this sentence.
 *
 *  ⚠️ The consequential action IS `tool/configure.ts`'s registered tool `name`, and these two literals
 *  live in two files now that the table is a leaf — so `test/tool-configure.test.ts` pins the
 *  relationship — `name === TIER_ACTION.consequential`, and privileged is that name plus the
 *  `_privileged` suffix — rather than leaving it to whoever renames one of them. */
export const TIER_ACTION = {
  consequential: "configure",
  privileged: "configure_privileged",
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
  // Visibility and bounded retention for NovaClaw's own derived diagnostic data. It cannot disable
  // logging, name an endpoint, carry text, or touch user-authored data.
  log: "operational",
  // Shortening this window removes the user's recovery margin; lengthening it spends disk. The
  // Normal-level Storage control makes that trade visible before the one-card write.
  trash: "consequential",
  // The agent's own truncation budget. Raising it spends the agent's own context and nothing else.
  tool_output: "operational",
  // The DEVICE registry: endpoint origins grouped into one backend, for the scheduler's admission
  // gate. It passes all four tests — an endpoint listed here is COMPARED against a model's own
  // `api.url` and never called, nothing here is executed, nothing egresses, and no string reaches a
  // prompt. A hostile entry can only over-group backends, which serializes turns (a throughput
  // loss) rather than oversubscribing hardware, and is undone by deleting the entry.
  devices: "operational",
  // The measured tool channel per model. CONSEQUENTIAL rather than operational: it decides how the
  // agent is offered tools for every later turn, and a wrong value is a chat where the agent
  // silently cannot act. Not privileged — it grants no capability the model did not already have,
  // and the self-healing law wants a still-working model able to repair a stale verdict.
  provider_capability: "consequential",
  // The measured per-request image cap. OPERATIONAL, not consequential: a wrong value costs images
  // in one request and is undone by deleting the entry, where a wrong tool channel costs an agent
  // that silently cannot act.
  provider_media_limit: "operational",
  // Bounded measurements that make prompt packing conservative for one exact model/server route.
  // A wrong row can only spend extra context or be deleted to restore defaults; it grants nothing.
  provider_route_profile: "operational",

  // ── consequential: one card, savable per key ────────────────────────────────────────────────
  // Sampling numbers plus an enable flag. The nudge TEXT is compiled, not configured.
  affective: "consequential",
  // The provider filter can leave the instance with NO working model — and "at least one working
  // model remains" is the self-healing law's own precondition, i.e. the one outage this tool could
  // create that this tool could not then repair. Not privileged: no execution, no egress, no text.
  // (`enabled_providers`, its allow-list twin, was retired 2026-09-03: no product writer, and its one
  // reader filtered the models.dev picker of a CLI credential prompt — the wrong price for that.)
  disabled_providers: "consequential",
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
  // The automatic continuations applied to a turn that thinks it is finished, plus the crash-resume
  // switch. Five booleans and nothing else: no command, no endpoint, no prompt TEXT — the steer
  // wording is fixed in source and the key only decides whether it is used, which is what separates
  // this from `introspection` (privileged because it carries `prompt`/`interjection` text) and puts
  // it beside `affective`, `strict` and `tool_routing`.
  //
  // ⚠️ Consequential rather than operational because turning one OFF is exactly the kind of change a
  // user must get to see: work stops being resumed after a crash, a confident finish stops being
  // re-grounded, a fan-out's forgotten child stops being reported. It grants nothing — it removes a
  // check — and a removed check is still a different instance afterwards.
  harness_drives: "consequential",
  // Real filesystem vs an app-private root — it decides what the product will browse at all.
  virtualFs: "consequential",
  // The FS watcher's ignore globs: it decides which file changes the product NOTICES, so a write
  // here can make the agent's own edits invisible in the user's live view.
  watcher: "consequential",

  // ── privileged: one card each, never pre-grantable with a single `configure` rule ────────────
  // HTTP declarations choose a destination for user data; stdio declarations choose executable bytes.
  capability_services: "privileged",
  // Manuals the model pulls into its context on demand — ruling 4 names this key by itself.
  adhoc_tools: "privileged",
  // Markdown that BECOMES a system prompt, plus each agent's own permission ruleset and tool list.
  agents: "privileged",
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
  // Free-form text is steered into future sessions. The closed hook vocabulary executes no user
  // code, but the instruction itself is authorship and therefore shares introspection's tier.
  nudges: "privileged",
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
  /**
   * 🔴 PRIVILEGED, beside `offline` and `telemetry` and for the same reason: it is a consent
   * decision with consequences outside this machine. Turning the community on exposes this box's IP
   * address to anyone it talks to — there is no central server to hide behind — and subscribes the
   * user to content nobody moderates.
   *
   * ⚠️ This is what an AGENT must spend `configure_privileged` to change. An agent may read and use
   * the community once its owner has enabled it; deciding to JOIN is not a thing a model does on
   * somebody's behalf because it read a message asking it to.
   */
  community: "privileged",
  offline: "privileged",
  // The gate itself. Nothing else on this list is worth much if an agent can rewrite this one.
  permissions: "privileged",
  // Prepended to EVERY agent's system prompt. Ruling 4 names it.
  persona: "privileged",
  // ⚠️ There is no `plugins` row, and there must never be one again. It used to read "`npm.add` +
  // `import()` — outside code in our process", i.e. the single most dangerous thing an agent could
  // write. Ruling 5 / step 17 removed the target instead of classifying it: the key is gone from
  // `Config.Info`, so this table — typed `Record<keyof Config.Info, Tier>` — cannot name it and the
  // completeness test cannot ask for it. Third-party code reaches NovaClaw out-of-process (`mcp`,
  // privileged above) or as a file the user drops in their own config dir, which no config write and
  // therefore no tier can reach.
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
  // Which SCREEN the `computer` tool drives. An execution surface in ruling 4's sense, and the
  // sharpest one we have: moving it from a sandbox display to `:0` promotes the agent from clicking
  // inside a disposable container to clicking on the operator's real desktop -- which is P6, and the
  // build order's sequence law puts P6 behind the P4 guardrails. A value, but not an inert one.
  computer: "privileged",
  // Paths or URLs skills are discovered from — a skill is instructions the model reads, and a URL
  // entry fetches them from a third party.
  skills: "privileged",
  // Which skills appear in the USER'S OWN slash list.
  //
  // Deliberately NOT privileged, and the contrast with `skills` above is the whole point: that one
  // adds a source the model reads from, this one only decides what the human sees in their own menu.
  // It grants the agent nothing — whether the agent may CHOOSE a skill is the `skill` permission
  // action, which is gated under `permissions` and stays gated there.
  //
  // ⚠️ It is CONSEQUENTIAL rather than operational, and the line is the one this table's header
  // draws: operational is "neither", consequential is "the instance behaves differently afterwards
  // in a way the user should get to see". An agent that writes this makes a skill vanish from its
  // OWNER'S menu with no card — structurally the same thing `watcher` does ("a write here can make
  // the agent's own edits invisible in the user's live view") and `snapshots` does ("nothing runs,
  // nothing leaves, but a guard the user relies on is gone"), both of which are priced here. One
  // savable `configure` card is the whole cost.
  skill_invocation: "consequential",
  // Which installed pre-action policies actually run.
  //
  // ⛔ PRIVILEGED, and the contrast with `skill_invocation` directly above is the line this table
  // draws. That one decides what the HUMAN sees in their own menu and grants the agent nothing.
  // This one decides whether the guard that refuses `rm -rf /` is consulted at all — a write here
  // REMOVES a gate from the agent's own path, which is the definition of a capability grant, and
  // `tool-policy-gate.ts` promises in the refusal itself that "no permission change made from
  // inside this session can widen it". An agent that could flip this without a card would make that
  // sentence false. Turning a policy off is the operator's to do, at the keyboard.
  tool_policy: "privileged",
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

/**
 * The sentence that stands in for a credential the caller may WRITE but will never READ back.
 *
 * It lives here, beside the tiers, for the reason the header gives: `tool/configure.ts`'s `read` op
 * and `config-projection.ts`'s `redact` must print the SAME string — a user reading one and a model
 * reading the other are looking at one instance — and neither file may import the other.
 */
export const REDACTED = "(redacted — configure can WRITE this value, it will not read one back)"
