import { Config as ConfigV2 } from "@novaclaw/core/config"
import { Effect } from "effect"
import type { HttpServerRequest } from "effect/unstable/http"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"
import { Log } from "@novaclaw/schema/log"

const root = "/config"

/**
 * ─── the wire REFUSES a top-level key `Config.Info` does not declare ────────────────────────────
 *
 * ⚠️ **This guard cannot live in the payload schema, which is exactly why the bug survived.**
 * `HttpApiEndpoint.patch(…, { payload: ConfigV2.Info })` decodes with Effect Schema's default
 * `onExcessProperty: "ignore"`, so an unknown key is erased BEFORE any handler or store sees it.
 * Measured 2026-07-29: `decodeUnknownSync(Config.Info)({ shell: "bash", provider_preset: {…} })`
 * yields `{ shell }` — i.e. a caller who typed `provider_preset` for `provider_presets` got **200
 * and no write**. That is todo.md ruling 2 (*a failed mutation never reports success*) broken on the
 * one surface AGENTS.md's self-healing law depends on: an agent that PATCHes, gets a 200, re-reads
 * and finds nothing cannot tell "I typed the wrong key" from "this instance is broken", so it loops.
 *
 * So the check reads the RAW body — which is safe to re-read, `HttpServerRequest.text` is
 * `Effect.cached` in both server implementations and the payload decoder has already forced it, so
 * this is a replay, not a second read of a consumed stream.
 *
 * **It is strictly upstream of `ConfigStoreWrite.applyToStores`' guard, and the two are one design
 * with two different subjects — keep the vocabulary distinct:**
 *  · HERE: a key `Config.Info` never declared. That is CALLER input, so it is a **400 that names the
 *    key** and nothing is attempted.
 *  · THERE (`packages/core/src/config-store-write.ts`, `unroutedKeys`/`NOT_ROUTED_KEYS`): a key the
 *    schema DOES declare but no router arm consumes. That can only happen if a field was added to
 *    `config.ts` without a router arm — a programming defect, not user input — so it *dies* inside
 *    the transaction ("nothing routes …") and rolls back. A key rejected here never reaches it.
 * Neither can substitute for the other: an unknown key never survives decode, and a declared-but-
 * unrouted key is always well-formed on the wire.
 *
 * ⚠️ **The file-import path deliberately DISAGREES with this, and that is intended.**
 * `packages/core/src/settings-config-seed.ts` (`decodeText`) keeps `onExcessProperty: "ignore"` for
 * `novaclaw.jsonc`: a file is hand-authored, may have been written for any version, and is applied
 * at BOOT where there is no caller to answer. A PATCH is a deliberate mutation with a live caller
 * who deserves to know it did nothing. Both sites carry this note; do not "fix" the inconsistency by
 * making the wire lenient again — that restores the exact 200-for-a-vanished-write this closes.
 *
 * **Forward compatibility is a real, accepted cost.** A NEWER UI driving an OLDER instance (the P2P
 * case: the UI is a thin client reaching any instance by URL) now 400s on a key the older instance
 * has never heard of, where before it silently half-applied the patch. The answer is legibility, not
 * negotiation: the error names EVERY offending key and tags itself `kind: "unknown-config-key"`, so
 * a client can drop exactly those keys and retry in one deterministic step — no capability endpoint,
 * no version header, no `?ignoreUnknown` escape hatch (which would just be the silent drop wearing a
 * query parameter). And because `kind` discriminates, an unknown key is distinguishable from a
 * malformed KNOWN one: a bad value for a real key is rejected by the payload decoder and surfaces
 * through `ExperimentalSchemaErrorMiddleware` as `kind: "Payload"`. "Remove these keys" and "fix this
 * value" are therefore two different answers a client can act on without parsing prose.
 */
export const UNKNOWN_CONFIG_KEY_KIND = "unknown-config-key"

/** `kind` for a write the store REFUSES to hold — today, one naming the governing agent, whose
 *  profile is fixed in code (AGENTS.md — the structural metaphor). Discriminated like the two guards
 *  above so a client can tell "you may not write this" from "this key does not exist". */
export const CONFIG_WRITE_REFUSED_KIND = "config-write-refused"

/**
 * ─── the wire REFUSES a `null` VALUE, for the same reason and by the same mechanism ─────────────
 *
 * 🔴 Measured live 2026-08-12 against a real instance: `PATCH /global/config` with
 * `{"memory":{"embedding":null}}` answers **200 and changes nothing**. RFC-7396 spends `null` to mean
 * *delete this key*, so a caller following the standard is told success and gets a no-op — ruling 2
 * broken again, on the same surface, one value-shape over.
 *
 * ⚠️ **`merge-patch.ts`'s ruling is right and its stated PREMISE is wrong**, which is worth recording
 * because the premise is what a reader would rely on. That file argues null-as-tombstone is
 * unnecessary here because *"a PATCH body is decoded through `Config.Info` before any merge runs"* and
 * `null` "cannot decode" against an optional field. On the TYPE side that is true —
 * `decodeUnknownEffect(Config.Info)({memory:{enabled:null}})` fails with *"Expected boolean |
 * undefined, got null"*. On the WIRE it is false: the encoded schema an `HttpApiEndpoint` payload
 * decodes is `boolean | null`, as the endpoint's own 400 for a bad value says out loud (*"Expected
 * boolean | null"*). So `null` decodes to ABSENT, the merge sees no key, and nothing happens. A
 * ruling defended by a decode is only as strong as the decode's direction.
 *
 * The conclusion still stands — `null` stays a value, deletion stays the separate verb — so this is
 * the reporting half: refuse it by name and point at `POST /api/config/remove`. A caller then gets
 * two distinguishable answers instead of one lie, exactly as with an unknown key.
 */
export const NULL_CONFIG_VALUE_KIND = "null-config-value"

/** How many offending keys the error names, and how long each may be. */
const MAX_NAMED_KEYS = 10
const MAX_KEY_CHARS = 80

/**
 * Derived on first use, not at module load: `Config.Info` schema derivations are documented as
 * import-cycle-sensitive inside `packages/core` (`settings-config-seed.ts:13`), and a set built once
 * per process on the first PATCH costs nothing at boot.
 */
let declared: ReadonlySet<string> | undefined
const declaredConfigKeys = (): ReadonlySet<string> => (declared ??= new Set(Object.keys(ConfigV2.Info.fields)))

/**
 * The top-level keys of a decoded PATCH body that `Config.Info` does not declare.
 *
 * Non-objects yield `[]` on purpose: an array or a scalar body is the payload decoder's rejection to
 * make (it produces a precise schema message), and answering "unknown key" for it would be a false
 * description of the fault — ruling 2's fourth clause.
 */
export const unknownConfigKeys = (body: unknown): string[] => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return []
  const known = declaredConfigKeys()
  return Object.keys(body).filter((key) => !known.has(key))
}

/** Quote one key for the message, truncated — the key is caller-supplied and may be arbitrarily long. */
const showKey = (key: string) => JSON.stringify(key.length <= MAX_KEY_CHARS ? key : `${key.slice(0, MAX_KEY_CHARS)}…`)

/**
 * Fail the request with a 400 naming every unknown top-level key, or succeed silently.
 *
 * `InvalidRequestError` needs NO new wire variant and NO OpenAPI/SDK regen: it is already in the
 * declared 400 union of both config PATCH routes (`ExperimentalSchemaErrorMiddleware` is applied to
 * `RootHttpApi` and `InstanceHttpApi` alike, and `HttpApiEndpoint.getErrorSchemas` folds middleware
 * errors into the endpoint's error schema) — `sdk/openapi.json` already documents both PATCH 400s as
 * `anyOf[effect_HttpApiError_BadRequest, InvalidRequestError]`. Its `message` is also what the
 * SDK's `wrapClientError` lifts into `Error.message`, so the Settings → Import toast shows the
 * offending key verbatim rather than a generic failure.
 */
export const rejectUnknownConfigKeys = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    // orDie, matching the payload decoder's own `Effect.orDie(httpRequest.text)`: the body was
    // already read successfully to build `ctx.payload`, so a failure here is not reachable input.
    const text = yield* Effect.orDie(request.text)
    let body: unknown
    try {
      body = JSON.parse(text === "" ? "{}" : text)
    } catch {
      // Unparseable JSON cannot have reached a handler (the decoder would have 400'd first). Leave
      // the description of that fault to whoever owns it rather than inventing a second one.
      return
    }
    const unknown = unknownConfigKeys(body)
    if (unknown.length === 0) return

    const named = unknown.slice(0, MAX_NAMED_KEYS)
    const hidden = unknown.length - named.length
    const list = named.map(showKey).join(", ") + (hidden > 0 ? `, …and ${hidden} more` : "")
    const plural = unknown.length === 1 ? "it" : "them"
    // Capped for the same reason `middleware/schema-error.ts` caps its reason: a 4xx must never
    // mirror an unbounded request back into the response body and the log file.
    // ⚠️ `String(named)` and `String(hidden)` were an array and a NUMBER flattened into two `text`
    // columns: the count could not be compared and the key list could not be
    // read back. A list is a list and a count is a count.
    yield* Log.event("config.patch.key.unknown", { "config.keys": named, "config.hidden": hidden })
    yield* Effect.fail(
      new InvalidRequestError({
        kind: UNKNOWN_CONFIG_KEY_KIND,
        // `field` is singular by this file's own convention (workspace-routing sets one name); the
        // near-universal case is one typo. Every key is named in `message`, which is the channel a
        // client retries from.
        field: named[0],
        message:
          `unknown config key: ${list}. Nothing was written — the whole patch was refused rather ` +
          `than answer 200 for a key that would vanish. Re-send the patch without ${plural}, or ` +
          `GET ${root} for the keys this instance accepts.`,
      }),
    )
  })

/**
 * Every path in a PATCH body whose value is `null`, deepest-first order irrelevant — the message
 * names them all.
 *
 * ⚠️ **Does not descend into ARRAYS**, matching `MergePatch.removeAt`'s refusal and for the same
 * reason: arrays replace wholesale, so a `null` inside one is an element the payload decoder judges
 * against that array's element schema. Claiming "you tried to delete `skills[2]`" would be a false
 * description of a fault that belongs to the decoder — this file's own rule for non-object bodies.
 */
export const nullConfigPaths = (body: unknown, prefix: ReadonlyArray<string> = []): string[][] => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return []
  const found: string[][] = []
  for (const [key, value] of Object.entries(body)) {
    if (value === null) found.push([...prefix, key])
    else found.push(...nullConfigPaths(value, [...prefix, key]))
  }
  return found
}

/**
 * Fail the request with a 400 naming every `null`-valued path, or succeed silently.
 *
 * Runs alongside `rejectUnknownConfigKeys` and after it, so a body with both faults is answered for
 * the unknown key first: a key this instance never heard of is the more fundamental thing to say, and
 * a `null` under a misspelt key would send the caller to the remove endpoint with a path that does
 * not exist there either.
 */
export const rejectNullConfigValues = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const text = yield* Effect.orDie(request.text)
    let body: unknown
    try {
      body = JSON.parse(text === "" ? "{}" : text)
    } catch {
      return
    }
    const nulls = nullConfigPaths(body)
    if (nulls.length === 0) return

    const named = nulls.slice(0, MAX_NAMED_KEYS)
    const hidden = nulls.length - named.length
    const list = named.map((path) => showKey(path.join("."))).join(", ") + (hidden > 0 ? `, …and ${hidden} more` : "")
    yield* Log.event("config.patch.value.null", { "config.keys": named.map((path) => path.join(".")), "config.hidden": hidden })
    yield* Effect.fail(
      new InvalidRequestError({
        kind: NULL_CONFIG_VALUE_KIND,
        field: named[0]?.join("."),
        message:
          `null config value at: ${list}. Nothing was written. \`null\` is not a deletion here — on ` +
          `the wire it decodes as "key absent", so this patch would have answered 200 and changed ` +
          `nothing. To DELETE, POST /api/config/remove with segment arrays, e.g. ` +
          `{"paths":[${JSON.stringify(named[0] ?? [])}]}. To SET a value, send the value.`,
      }),
    )
  })

export const ConfigApi = HttpApi.make("config")
  .add(
    HttpApiGroup.make("config")
      .add(
        HttpApiEndpoint.get("get", root, {
          query: WorkspaceRoutingQuery,
          success: described(ConfigV2.Info, "Get config info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.get",
            summary: "Get configuration",
            description: "Retrieve the current NovaClaw configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.patch("update", root, {
          query: WorkspaceRoutingQuery,
          payload: ConfigV2.Info,
          success: described(ConfigV2.Info, "Successfully updated config"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.update",
            summary: "Update configuration",
            description: "Update NovaClaw configuration settings and preferences.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "config",
          description: "Experimental HttpApi config routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "novaclaw experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
