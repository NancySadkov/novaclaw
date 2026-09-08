import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "path"

import { schemaTypeNames } from "../script/emitter"

// The SDK's two committed artifacts are GENERATED, and until 2026-07-28 nothing asserted they still
// matched their source. They silently went five days stale: `packages/sdk/openapi.json` was last
// regenerated 2026-07-23, and by the time an optional `sourceUri` was added to
// `packages/schema/src/prompt.ts` the committed spec was already missing 9 routes (calendar, recipe,
// session pending/export-markdown), 10 schemas and 3 harness-feature enum members. Ruling 1: an
// invariant whose violation compiles green ships with a mechanical check, or it does not exist.
//
// The chain has two hops and they are checked differently, because they cost differently:
//
//   packages/protocol  --(bun dev generate)-->  packages/sdk/openapi.json     hop 1 — 3.5 s, byte-exact
//   packages/sdk/openapi.json  --(owned emitter)-->  src/v2/gen/**              hop 2 — structural here
//
// Hop 1 is re-run for real on every gate run: `bun dev generate` is a pure in-process read of
// `Server.openapi()` (no network, no database write), it is deterministic, and it is redirected to a
// TEMP file so a test run never mutates the working tree.
//
// Hop 2's emitter itself is unit-tested with synthetic contracts and deterministic twin outputs.
// This file keeps the production contract check structural so the ordinary test tier never rewrites
// tracked artifacts. `bun run --cwd packages/sdk/js check:generated` is the byte-exact release check.
// Every route the spec declares must be reachable from the typed client, and the typed client must
// expose no route the spec does not declare.
//
// Whoever fixes a failure here: `bun run --cwd packages/sdk/js regen` and
// `bun script/generate.ts` now reach the same root-aware pipeline. It refreshes the committed spec
// BEFORE generating the client, then formats only the generated contract artifacts.

const root = path.resolve(import.meta.dir, "../../../..")
const specPath = path.join(root, "packages/sdk/openapi.json")
const genDir = path.join(root, "packages/sdk/js/src/v2/gen")

const REGEN = "bun run --cwd packages/sdk/js regen"

type Document = {
  paths: Record<string, Record<string, { operationId?: string } | undefined>>
  components: { schemas: Record<string, unknown> }
}

const METHODS = ["get", "post", "put", "delete", "patch"] as const

/**
 * ⚠️ **What the two hops above CANNOT see, and why the checks below exist.**
 *
 * Hop 1 re-runs the same transform on both sides of its comparison. Anything the transform does wrong
 * it does wrong identically to the committed file and to the fresh one, so a **defect in the transform
 * reads as "no drift"** — the check is a staleness detector, never a correctness one. That blind spot
 * shipped a real bug: `stripOptionalNull` deleted the `null` from 49 positions that genuinely have one,
 * including the three per-session override endpoints whose contract is *"null clears the override back
 * to inherit"*, and hop 1 was green throughout. The `null`-preservation invariant itself is asserted
 * where the transform lives (`packages/novaclaw/test/v2/openapi-nullability.test.ts`, which has the raw
 * projection to compare against); what is asserted **here** is the other end of the chain — that the
 * artifacts actually committed still carry it.
 *
 * Hop 2 compares ROUTES, so it is blind to **schema** drift. Measured 2026-07-31: the committed
 * `openapi.json` declared `ResourcePressure`, `MessengerSourceAccess` and `MessengerSourceLabel` while
 * the committed `types.gen.ts` had never heard of them — three schemas stale, both hops green. The
 * third check below closes that.
 */

type Schema = {
  anyOf?: Schema[]
  oneOf?: Schema[]
  properties?: Record<string, Schema>
  required?: string[]
  type?: string
}

/** The same file as `Document`, read for its request-body schemas rather than its route names. */
type SchemaDocument = {
  paths: Record<
    string,
    Partial<Record<(typeof METHODS)[number], { requestBody?: { content?: Record<string, { schema?: Schema }> } }>>
  >
  components: { schemas: Record<string, unknown> }
}

/**
 * Every request-body field the wire contract lets a caller send as `null`, by name.
 *
 * All four are the point of the ledger. `PATCH /api/session/{sessionID}`'s `archived` and
 * the three `POST /api/session/{sessionID}/…` overrides are `Schema.NullOr`, and `null` is the value
 * that CLEARS the override so the session inherits from its parent chain — architecture.md's keystone,
 * reachable over HTTP. Until 2026-07-31 the original fields were typed non-nullable in the generated client and a
 * typed caller simply could not express *inherit*.
 *
 * ⚠️ **A shrinking list is the alarm.** An entry disappears legitimately only when the protocol stops
 * declaring the field nullable — in which case say which one and why in the same commit. An entry
 * disappearing on its own means the transform has started eating nulls again.
 */
const NULLABLE_REQUEST_FIELDS = [
  "PATCH /api/session/{sessionID} archived (optional)",
  "PATCH /api/session/{sessionID} device (optional)",
  "POST /api/session/{sessionID}/strict strict",
  "POST /api/session/{sessionID}/feature enabled",
  "POST /api/session/{sessionID}/prompt-override override",
] as const

/**
 * A floor, not a pin, over the WHOLE document — request bodies, responses and components alike.
 *
 * 38 required-and-nullable properties remain after the legacy workspace routes were deleted. The
 * ledger above names the four that carry semantics a human can check; this number catches the case
 * the ledger cannot — a regression that eats nulls everywhere EXCEPT the four pinned by name.
 */
const NULLABLE_REQUIRED_FLOOR = 38

/** The arms of a union with nested unions flattened, matching how the transform reasons about them. */
function unionOptions(schema: Schema | undefined): Schema[] | undefined {
  return (schema?.anyOf ?? schema?.oneOf)?.flatMap((item) => unionOptions(item) ?? [item])
}

function isNullable(schema: Schema | undefined): boolean {
  return !!unionOptions(schema)?.some((item) => item.type === "null")
}

/** The body of `export type <name> = …`, up to the next top-level `export`. */
function exportedType(source: string, name: string): string | undefined {
  const start = source.indexOf(`export type ${name} = `)
  if (start < 0) return undefined
  const end = source.indexOf("\nexport ", start + 1)
  return source.slice(start, end < 0 ? undefined : end)
}

/**
 * A HANG backstop for the one test that spawns a process, not a budget.
 *
 * `bun dev generate` measured 3.5 s warm on 2026-07-28, but the suite-wide 15 s per-test default is
 * thin for a cold module graph on a loaded box, and a wall-clock kill is indistinguishable from a
 * real failure in the summary. The sdk-js unit's own wall-clock kill in `script/test.ts` still bounds
 * this file, so raising it here weakens nothing.
 */
const GENERATE_TIMEOUT_MS = 60_000

// This pins the COMPLETE source-name -> TypeScript-name table, including the non-identifier names,
// acronym normalization and collision suffixes that the structural schema test below deliberately
// cannot predict. A protocol schema addition changes it legitimately; update the fingerprint only
// after reviewing the readable mapping diff printed by the failure.
// Updated 2026-08-13, reviewed against the printed mapping each time. Additions only, every one
// mapping to itself — no rename, no collision suffix, no acronym normalisation moved:
//   `ProjectState`                                (GET /api/project)
//   `SessionReceiptInfo` / `Check` / `PlanItem`   (GET /api/session/:id/receipt)
// Updated 2026-08-18, mapping diff reviewed — three additions, each mapping to itself:
//   `ProjectWriteInput` / `ProjectWriteResult`    (POST /api/project — the project-file write path)
//   `ProjectTune`                                 (`Project.Tune`, the dot collapsed as usual)
// Updated 2026-08-18, mapping diff reviewed — three additions, each mapping to itself, nothing removed:
//   `RecipeVerifyCheck` / `RecipeVerifyResult`    (POST /api/recipe/:slug/verify — the deterministic
//                                                  success artifact for a cook)
//   `UnknownReason`                               (`@novaclaw/schema`'s shared "why is this blank"
//                                                  vocabulary, first reaching the wire through it)
// Updated 2026-08-18, mapping diff reviewed — ONE addition, mapping to itself, nothing removed:
//   `ProjectSection`                              (`Project.Section`, the dot collapsed as usual —
//                                                  the sections a `POST /api/project` may replace or
//                                                  CLEAR; the `clear` list is what reaches the wire)
// Three existing schemas also changed SHAPE, which this fingerprint does not cover and the spec
// check below does: `ProjectState` gained the permission rules and the `.gitignore` proposal,
// `ProjectWriteInput` gained `clear`, `ProjectWriteResult` gained `cleared` + `refusedPermissions`.
// ── 2026-08-19: presence + the recipes surface, NINE additions and no removals ──────────────────
//   `SessionPresenceSnapshot` / `SessionPresenceViewer` / `SessionPresenceHandoff` /
//   `SessionPresenceUpdated` / `EventSessionPresenceUpdated`  (per-session presence: who is
//                                                  attached, who is driving, and the handoff notice)
//   `RecipeSource` / `RecipeNeedCheck`              (a recipe's own bytes, and its `needs:` facts
//                                                  probed against THIS machine)
//   `RecipeUpdateInput` / `RecipeImportInput`       (the partial update verb, and import)
// ⚠️ The criterion for updating this line is that the diff is ADDITIVE: `git diff openapi.json` shows
// nine added top-level schema names and ZERO removed, so nothing was renamed and nothing collided
// into a suffix. A removal beside an addition is a rename and must be read before re-pinning.
// ── 2026-08-19: policy interventions reach the wire — THREE additions, ZERO removals ────────────
//   `SessionReceiptPolicyDecision`                 (`SessionReceipt.PolicyDecision` — one tool call
//                                                  a pre-action policy intervened on. The receipt
//                                                  composer has read these rows since the kernel
//                                                  landed and the success schema dropped every one
//                                                  of them on the way out, so an intervention was
//                                                  durable and invisible.)
//   `ProjectSkills` / `ProjectSkillChoice`         (`ProjectFile.Skills` — the project-scoped skill
//                                                  section, from the concurrently-running skill
//                                                  invocation work in the same tree)
// Measured rather than eyeballed, by generating the spec twice — once with `session-receipt.ts` at
// HEAD and once with the change — so the receipt half's own contribution is isolated: ONE added name
// (`SessionReceiptPolicyDecision`), ZERO removed, plus `SessionReceiptInfo` changed SHAPE (which this
// fingerprint does not cover and the spec check below does). Every one of the three added names maps
// to itself in the printed table: no rename, no collision suffix, no acronym normalisation moved.
// ── 2026-08-19: the policy surface and Project-scoped skills, FIVE additions and no removals ──────
//   `InstalledPolicy` / `PolicyState`            (which pre-action policies are installed, and what
//                                                each one does — the management surface)
//   `SessionReceiptPolicyDecision`               (an intervention on the wire; it was durable but
//                                                INVISIBLE, which is a receipt that does not receipt)
//   `ProjectSkills` / `ProjectSkillChoice`       (a folder's skill-invocation choices)
// ⚠️ Additive: `git diff openapi.json` shows five added top-level schema names and ZERO removed, so
// nothing was renamed and nothing collided into a suffix. A removal beside an addition is a rename and
// must be read before re-pinning — that is the whole reason this fingerprint is not auto-updated.
// ── 2026-08-19: ruling 5 / step 17 — ONE REMOVAL and ZERO additions ─────────────────────────────
//   − `ConfigV2PluginEntry`                      (`ConfigV2.Plugin.Entry`, the `{package, options}`
//                                                half of a `plugins[]` array item)
// ⚠️ **This is the one case the "additive" rule above does NOT cover, and it is deliberate.** Every
// earlier update reasoned "additions only, nothing removed, therefore no rename"; here the diff is a
// pure REMOVAL, so the rename check has to be made the other way round: a removal is a rename only
// if some name ARRIVED to take its place, and `git diff packages/sdk/openapi.json` shows zero added
// top-level schema names. The removal is the point of the change, not a side effect of one — the
// `plugins[]` config key and the `npm.add` arm it fed are deleted (`config.ts` now carries a ⚠️
// where the key was), so `ConfigInfo` loses the `plugins` property and the entry schema loses its
// only referent. `PluginAdded` / `EventPluginAdded` are UNTOUCHED and must stay: they are the plugin
// HOST's events, nothing to do with the config key.
// Reviewed and re-pinned 2026-08-21 against `packages/sdk/openapi.json` as it stands.
//
// ⚠️ It had been STALE for a long run of commits, and this is what that costs: the table it pins had
// accumulated 33 additions and 1 removal (`ConfigV2PluginEntry`) since the constant was last set, so
// the review this ledger exists to force could not happen key-by-key any more. The one delta from the
// roster slice was checked against the immediately preceding tree and is a single deliberate addition
// — `AgentUsageMinute`, the per-minute spend row the roster reads. Everything before it is accepted
// here as history rather than re-derived, and that acceptance is the point of writing this down.
// -- 2026-08-23: ZERO name changes -- WALK ORDER only --------------------------------------------
// WARNING: the one shape of update this ledger's own instructions do not describe, so it is written
// down. Every previous entry reasoned about names ADDED or REMOVED. Here the table is identical as a
// SET: measured 536 pairs before and 536 after, `same set: true`, and not one `source -> emitted`
// pair added, removed or repointed. What changed is the ORDER the emitter walks them in -- the
// fingerprint hashes `mapping.join()`, so a reordering moves it exactly as a rename would.
//
// Cause: the session schema stopped importing `PermissionRuleset` (the write-only `permission`
// ruleset was deleted -- written by create/`setPermission`, read by nobody, and typed in a legacy
// shape the evaluator does not take). `PermissionAction` is therefore reached later in the walk;
// first divergence at index 10, `PermissionAction` -> `Prompt`, with `PermissionAction` still
// present further down.
//
// So this re-pin asserts something WEAKER than the usual one, and deliberately: not "the additions
// were reviewed" but "there was nothing to review -- the public naming table is identical as a set".
// A future reader must not read this entry as precedent for re-pinning past a real rename.
//
// 2026-08-24 — the SAME weaker class again, and measured the same way before re-pinning.
// `session.switchAgent` gained a second declared error (`ConflictError`, 409: one chat per colleague),
// which moved the fingerprint. Measured against the previous commit: **536 schemas before, 536 after,
// nothing ADDED and nothing REMOVED** — `ConflictError` was already public, reached through other
// endpoints — and exactly ONE path changed shape, `/api/session/{sessionID}/agent`, which is the
// endpoint that was edited. So again: the naming table is identical as a set, and only the ORDER the
// emitter walks it in moved, because `switchAgent` now reaches `ConflictError` earlier.
//
// ⚠️ The same warning still stands, and applies to this entry too: set-identity is what makes the
// re-pin safe. A fingerprint change that ADDS, REMOVES or REPOINTS a `source -> emitted` pair is a
// public API change and must be reviewed as one, not re-pinned by copying the received hash.
// ── 2026-09-02: the event narrowing finally reaches the artifacts — TWENTY removals, ONE addition ──
//   − the 20 `Event.*` component names in `EventManifest.Latest \ ServerDefinitions`
//     (`session.status`, `question.replied`, `question.rejected`, `permission.asked`,
//     `permission.replied`, `mcp.*`, `workspace.*`, `worktree.*`, `installation.*`, `session.error`,
//     `session.compacted`, `global.disposed`, `vcs.branch.updated`, `question.asked`, …) — the arms
//     `handlers/event.ts` narrows away and a conforming client would have waited for forever.
//   + `V2EventServerConnected` — the same `server.connected` arm, now emitted from the synthetic
//     `V2Event.server.connected` identifier rather than the manifest's. A removal beside an addition
//     is a rename and this one is it; measured, not eyeballed, against the two manifest sets.
// ── 2026-09-02: the download ticket — ONE ADDITION, ONE REMOVAL, and they are the SAME NAME ────────
//   − `PtyTicketConnectToken`                    (`PtyTicket.ConnectToken`, `{ticket, expires_in}`)
//   + `TicketAccessToken`                        (`Ticket.AccessToken`, byte-identical shape)
// ⚠️ **A removal beside an addition is a RENAME, and this one is** — so it is reviewed as a public
// API change rather than re-pinned as "additive". Measured, not eyeballed: 507 pairs before and 507
// after; the ONLY pair gone is `PtyTicketConnectToken -> PtyTicketConnectToken` and the only pair
// arrived is `TicketAccessToken -> TicketAccessToken`. Each maps to itself — no collision suffix, no
// acronym normalisation moved — and the two component schemas are identical field for field
// (`git diff packages/sdk/openapi.json` shows zero `~ schema … changed shape`).
//
// Why the name moved: a WebSocket upgrade was the only request on this surface a browser issues
// itself, so a single-use ticket could be called a PTY connect token. A `<a download>` is the
// second — it is fetched by the browser, carries no `Authorization`, and saved the 401 body under
// the file's own name on any instance with a server password. `POST /api/fs/read-token` mints the
// same ticket for `fs.read`, and a filesystem route whose response schema is called `PtyTicket…`
// is a public contract that lies about itself. One mechanism (`@novaclaw/core/ticket`), one wire
// type, one name.
//
// Also in this regen, and NOT covered by this fingerprint (the spec check below covers it):
//   + path  `POST /api/fs/read-token`
//   ~ path  `GET /api/fs/read/*`               (gained the `ticket` query parameter and a 403)
//   ~ path  `POST /api/pty/{ptyID}/connect-token` (its 200 now `$ref`s the renamed schema)
// 45 further pairs moved in WALK ORDER only, with no pair added, removed or repointed among them:
// `fs.read` now declares `ForbiddenError`, so the emitter reaches that already-public schema earlier
// (first divergence at index 78). The fingerprint hashes `mapping.join()`, so a reordering moves it
// exactly as a rename would — which is why the set comparison above is what makes this re-pin safe.
// 2026-09-03: every wire number became `Schema.Finite` (RF-24-7), so the NaN/Infinity arms left the
// spec and the one duplicate shape they had minted — `MessengerAccountStatus1` — is no longer emitted.
// That single removal is the whole difference from the previous fingerprint.
// 2026-09-03, later: the legacy question surface left (three `/question*` paths, the
// `question.asked` family and its schema module), taking the ten `Question*`/`EventQuestion*` names
// with it. Nothing was added.
// 2026-09-03, later still: the served event set became the bus minus the two server-lifecycle
// types (RF-24-2's join rows), so the `/api/event` union gained thirteen arms — `SessionStatusEvent`
// (the arm carries its own wire name; its type's PascalCase collided with the status object),
// `SessionError`, `SessionCompacted`, `Installation*`, `Mcp*`, `VcsBranchUpdated`, `Workspace*`,
// `Worktree*` — and lost the two `EventPermission*` arms whose family nobody publishes.
// 2026-09-03, last: the legacy `/event` left with its `EventSubscribeResponses`; `server.instance.disposed`
// became a served bus event (`ServerInstanceDisposed`) so the CLI reads it on `/api/event`.
// 2026-09-03, and the row's last move: `server.connected` and `global.disposed` left the bus
// inventory for the streams that synthesize them, so `GlobalEvent` names the disposal itself.
// 2026-09-03, the row closed: the five `/vcs*` legacy paths became `/api/vcs*`. Exactly ONE name
// moved - `VcsApplyError` LEFT, and nothing arrived. The bespoke 400 the legacy route carried is
// now the contract's own `InvalidRequestError`, with the reason in its `kind`; the six VCS wire
// shapes kept their names because they moved package without changing shape. 506 -> 505 entries,
// reviewed with a HEAD-versus-working-tree diff of the table rather than by re-running the pin.
// 2026-09-03, last: Settings -> Quality gained "Detect from this project", so `GET
// /api/quality/detect` joined the contract and brought exactly two names with it -
// `QualityCommands` (the five slots, which were a TypeScript interface in core and a hand-written
// Schema.Struct in the tool, held equal by nothing) and `QualityDetection` (those plus the
// evidence). Nothing left. 505 -> 507 entries, reviewed with a HEAD-versus-working-tree diff.
// 2026-09-04: the current emitter normalizes the five MCP status names to `Mcp...`.
// 2026-09-05: retired the remaining 13 QuestionV2/QuestionNotFound/EventQuestionV2 names.
// The existing MCP idle-state change also adds MCPStatusIdle; no other names changed.
// 2026-09-07: reviewed +1 generated sync schema. Tool.Labelled became durable so its already-public
// event schema now also has the expected `SyncEventSessionNextToolLabelled` replay envelope.
// 2026-09-08: the user-facing Nudge config adds exactly one public schema, `ConfigV2Nudge`, and
// removes none. Its name maps without a collision suffix; the ConfigInfo shape gains the list.
const SCHEMA_NAME_FINGERPRINT = "dc257d861e7705552629903efefedc8df8aec8b7b8c10a77a66d1506ce51c4b0"

/** A compact, readable account of HOW two spec documents differ — a 2000-line diff helps nobody. */
function describeDrift(committed: Document, fresh: Document): string {
  const lines: string[] = []
  const report = (label: string, before: string[], after: string[]) => {
    const added = after.filter((name) => !before.includes(name))
    const removed = before.filter((name) => !after.includes(name))
    for (const name of added) lines.push(`  + ${label} ${name} (in the protocol, missing from the committed spec)`)
    for (const name of removed) lines.push(`  - ${label} ${name} (in the committed spec, gone from the protocol)`)
  }
  report("path", Object.keys(committed.paths), Object.keys(fresh.paths))
  report("schema", Object.keys(committed.components.schemas), Object.keys(fresh.components.schemas))
  for (const name of Object.keys(fresh.components.schemas)) {
    if (!(name in committed.components.schemas)) continue
    const before = JSON.stringify(committed.components.schemas[name])
    const after = JSON.stringify(fresh.components.schemas[name])
    if (before !== after) lines.push(`  ~ schema ${name} changed shape`)
  }
  for (const name of Object.keys(fresh.paths)) {
    if (!(name in committed.paths)) continue
    if (JSON.stringify(committed.paths[name]) !== JSON.stringify(fresh.paths[name]))
      lines.push(`  ~ path ${name} changed shape`)
  }
  return lines.length > 0 ? lines.join("\n") : "  (no structural difference — formatting or key order only)"
}

describe("the SDK's generated artifacts", () => {
  test("the public schema naming table changes only deliberately", async () => {
    const document = (await Bun.file(specPath).json()) as Document
    const mapping = [...schemaTypeNames(document as any)].map(([source, emitted]) => `${source} -> ${emitted}`)
    const fingerprint = createHash("sha256").update(mapping.join("\n")).digest("hex")
    expect(
      fingerprint,
      [
        "The owned emitter's public schema naming table changed.",
        "Review this mapping before updating SCHEMA_NAME_FINGERPRINT:",
        ...mapping.map((line) => `  ${line}`),
      ].join("\n"),
    ).toBe(SCHEMA_NAME_FINGERPRINT)
  })

  test(
    "openapi.json is what packages/protocol generates today",
    async () => {
      const child = Bun.spawn([process.execPath, "run", "dev", "generate"], {
        cwd: path.join(root, "packages/novaclaw"),
        stdout: "pipe",
        stderr: "pipe",
        // 🔴 The child INHERITS `NODE_ENV=test` from this test process, and generation is an
        // in-process read of the HttpApi that has no business touching the developer's instance
        // store. Pinning the database says so explicitly — without it the child resolves the real
        // path, which `db-path.ts` now refuses under `NODE_ENV=test` (added 2026-08-07 after fixture
        // rows were found in the owner's store). ⚠️ Generation reading real user state would also make
        // the "byte-exact" claim above depend on whose machine ran it.
        env: { ...process.env, NOVACLAW_DB: ":memory:" },
      })
      const [fresh, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(exitCode, `\`bun dev generate\` failed:\n${stderr}`).toBe(0)
      expect(fresh.length, `\`bun dev generate\` produced no document:\n${stderr}`).toBeGreaterThan(1000)

      const committed = await Bun.file(specPath).text()
      if (fresh === committed) return

      // Not `expect(fresh).toBe(committed)` — that prints a 1.1 MB pair of strings.
      const summary = describeDrift(JSON.parse(committed) as Document, JSON.parse(fresh) as Document)
      throw new Error(
        [
          "packages/sdk/openapi.json is STALE — the HttpApi in packages/protocol no longer projects to it.",
          "",
          summary,
          "",
          `Fix:  ${REGEN}`,
        ].join("\n"),
      )
    },
    GENERATE_TIMEOUT_MS,
  )

  test("the typed client exposes exactly the routes the spec declares", async () => {
    const document = (await Bun.file(specPath).json()) as Document
    const sdk = await Bun.file(path.join(genDir, "sdk.gen.ts")).text()

    // The owned emitter writes every operation as `.<method><generics>({ url: "<path>", ... })`, with the path
    // VERBATIM — no name transformation, which is what makes this assertion sound. Operation *ids*
    // are not usable for this: all 212 are rewritten into container/method names.
    const emitted = new Set<string>()
    // ⚠️ `\(\s*\{`, not `\(\{`: prettier breaks the call across lines whenever the generic list is
    // long (`switchType`, `credentialRemove`, …), and a tighter regex silently under-reports.
    for (const match of sdk.matchAll(
      /\.(get|post|put|delete|patch)<[\s\S]{0,400}?>\(\s*\{[\s\S]{0,400}?url: "([^"]+)"/g,
    ))
      emitted.add(`${match[1]!.toUpperCase()} ${match[2]!}`)

    const declared = new Set<string>()
    for (const [route, item] of Object.entries(document.paths))
      for (const method of METHODS) if (item[method]) declared.add(`${method.toUpperCase()} ${route}`)

    const missing = [...declared].filter((operation) => !emitted.has(operation)).sort()
    const extra = [...emitted].filter((operation) => !declared.has(operation)).sort()

    expect(
      { missing, extra },
      [
        "src/v2/gen/sdk.gen.ts does not match packages/sdk/openapi.json.",
        `  missing from the client: ${missing.join(", ") || "none"}`,
        `  present only in the client: ${extra.join(", ") || "none"}`,
        `Fix:  ${REGEN}`,
      ].join("\n"),
    ).toEqual({ missing: [], extra: [] })
    // Guards the guard: a regex that silently stopped matching would make `missing` empty too.
    expect(declared.size).toBeGreaterThan(200)
    expect(emitted.size).toBe(declared.size)
  })

  test("the committed spec still lets callers send the nulls the contract defines", async () => {
    const document = (await Bun.file(specPath).json()) as SchemaDocument

    const nullable: string[] = []
    let requiredAndNullable = 0
    for (const [route, item] of Object.entries(document.paths)) {
      for (const method of METHODS) {
        const schema = item[method]?.requestBody?.content?.["application/json"]?.schema
        if (!schema?.properties) continue
        const required = new Set(schema.required ?? [])
        for (const [field, property] of Object.entries(schema.properties))
          if (isNullable(property))
            nullable.push(`${method.toUpperCase()} ${route} ${field}${required.has(field) ? "" : " (optional)"}`)
      }
    }

    // The whole-document sweep, components included — see NULLABLE_REQUIRED_FLOOR.
    const walked = new WeakSet<object>()
    const count = (node: unknown): void => {
      if (!node || typeof node !== "object") return
      if (Array.isArray(node)) return node.forEach(count)
      if (walked.has(node)) return
      walked.add(node)
      const schema = node as Schema
      if (schema.properties) {
        const required = new Set(schema.required ?? [])
        for (const [field, property] of Object.entries(schema.properties))
          if (required.has(field) && isNullable(property)) requiredAndNullable++
      }
      for (const value of Object.values(node)) count(value)
    }
    count(document.paths)
    count(document.components.schemas)

    expect(
      nullable.sort(),
      [
        "packages/sdk/openapi.json no longer offers `null` on every request-body field the protocol",
        "declares as `Schema.NullOr`. On the per-session override routes `null` is what CLEARS the",
        "override so the session inherits from its parent chain — dropping it makes `inherit` unsendable.",
        `Fix:  ${REGEN}  (after fixing \`stripOptionalNull\` in packages/novaclaw/…/httpapi/public.ts)`,
      ].join("\n"),
    ).toEqual([...NULLABLE_REQUEST_FIELDS].sort())

    expect(
      requiredAndNullable,
      `only ${requiredAndNullable} required-and-nullable properties remain in the committed spec (floor ${NULLABLE_REQUIRED_FLOOR}) — the transform is eating nulls again.`,
    ).toBeGreaterThanOrEqual(NULLABLE_REQUIRED_FLOOR)
  })

  test("the typed client carries those nulls into TypeScript", async () => {
    // The end of the chain, and the only thing an application actually compiles against. A spec that
    // says `null` and a `types.gen.ts` that does not means the regen never ran.
    const types = await Bun.file(path.join(genDir, "types.gen.ts")).text()
    const expected = [
      ["V2SessionSwitchStrictData", "strict: SessionStrictOverride | null"],
      ["V2SessionSwitchFeatureData", "enabled: boolean | null"],
      ["V2SessionSwitchPromptOverrideData", "override: string | null"],
      ["V2SessionUpdateData", "archived?: number | null"],
    ] as const

    for (const [name, member] of expected) {
      const body = exportedType(types, name)
      expect(body, `src/v2/gen/types.gen.ts no longer exports ${name}`).toBeDefined()
      expect(
        body,
        `${name} lost \`${member}\` — a typed caller can no longer clear this override.\nFix:  ${REGEN}`,
      ).toContain(member)
    }
  })

  test("every schema the spec declares reaches the typed client", async () => {
    // Hop 2's route check is blind to schemas: on 2026-07-31 the committed spec carried three schemas
    // the committed client had never been regenerated for, and both existing checks were green.
    //
    // The emitter rewrites non-identifier schema names — dots, dashes and underscores are collapsed
    // (`session.status`, `Models-devRefreshed`, `effect_HttpApiError_BadRequest`) in ways this test
    // would have to reimplement to predict. It does not try: it checks only the 434 names that are
    // already plain identifiers, and compares case-insensitively because acronym case IS normalized
    // (`MCPStatus` → `McpStatus`, `ProviderAISDK` → `ProviderAisdk`). That covers 97% of the surface
    // with zero knowledge of the naming table.
    const document = (await Bun.file(specPath).json()) as Document
    const types = await Bun.file(path.join(genDir, "types.gen.ts")).text()

    const emitted = new Set([...types.matchAll(/^export type ([A-Za-z0-9_]+)/gm)].map((m) => m[1]!.toLowerCase()))
    const plain = Object.keys(document.components.schemas).filter((name) => /^[A-Za-z][A-Za-z0-9]*$/.test(name))
    const missing = plain.filter((name) => !emitted.has(name.toLowerCase())).sort()

    expect(
      missing,
      [
        "packages/sdk/openapi.json declares schemas that src/v2/gen/types.gen.ts does not emit — the",
        "typed client is stale against the spec (the route check above cannot see this).",
        `Fix:  ${REGEN}`,
      ].join("\n"),
    ).toEqual([])
    // Guards the guard: an over-strict identifier filter would empty `plain` and pass vacuously.
    expect(plain.length).toBeGreaterThan(400)
  })
})
