/**
 * The config schema's own annotation vocabulary — the three facts a projection needs that a plain
 * Effect schema does not carry: **is this value a credential**, **what else has to be set for it to
 * matter**, and **what does the code do when it is absent**.
 *
 * ── WHY A MARKER AND NOT A NAME HEURISTIC ──────────────────────────────────────────────────────
 *
 * v0.2.0 item 4.1 refuses the shape the reference implementation uses (OpenLumara, assessed
 * 2026-08-06): it hides secrets by substring-matching key names against
 * `["token","key","secret","password","auth","credential"]`. That guess **fails in both directions,
 * and ours fails in both directions too** — measured against `tool/configure.ts`'s `SECRET_FIELDS`
 * on 2026-08-07 and pinned in `test/config-projection.test.ts`:
 *
 *  · **under-redacts** — `mcp.servers.<n>.oauth.client_secret` is not the string `"secret"`, and
 *    `mcp.servers.<n>.environment.SERVICE_TOKEN` is not the string `"token"`, so a real credential
 *    reads back verbatim into the model's transcript;
 *  · **over-redacts** — the name is a USER-CHOSEN record key in half the config surface, so an MCP
 *    server (or provider, or agent) a user happens to call `headers` reads back with its `type` and
 *    `url` replaced, and the repair the agent was asked to make becomes unmakeable.
 *
 * We have typed schemas, so the field itself can say what it is. {@link secret} is the marker and
 * `config-projection.ts` is its only reader — one source of truth, and the only form in which
 * the operator view (*what can this agent reach?*) can be honest.
 *
 * ⚠️ **The marker is set through these functions and never by writing the annotation key.** The keys
 * below are module-private on purpose: a mistyped string annotation is not a compile error and would
 * silently produce a field that reads back in the clear, which is the exact failure class the
 * heuristic has. A mistyped function name does not compile.
 */
export * as ConfigAnnotation from "./config-annotation"

import { Schema, SchemaAST } from "effect"

/** Annotation keys. Private — see the ⚠️ in the header. */
const SECRET = "novaclaw/config/secret"
const SECRET_ENTRIES = "novaclaw/config/secretEntries"
const DEPENDS = "novaclaw/config/depends"
const DEFAULT = "novaclaw/config/default"

/**
 * What a field needs from elsewhere in the config before it does anything.
 *
 * ⚠️ **Authored, never inferred.** Nothing in an Effect schema knows that `disabledEngines` is dead
 * code once `searxngUrl` is set — that lives in `websearch/service.ts`'s `resolveEngines`. So each
 * entry carries the file that decides it, and `config-projection.test.ts` fails if `path` does not
 * resolve to a real node, which is the drift mode a rename would otherwise open.
 */
export interface Dependency {
  /** The config path this field depends on, as segments. */
  readonly path: readonly string[]
  /** `"set"` — the dependency must have a value. `"unset"` — this field is inert while it does. */
  readonly when: "set" | "unset"
  /** What happens to THIS field when the condition does not hold. One sentence, no blame. */
  readonly effect: string
  /** `file:line` that decides it, so the claim can be re-derived rather than believed. */
  readonly source: string
}

/**
 * The value the code uses when the field is absent.
 *
 * ⚠️ **Only ever attached where the compiled constant can be POINTED AT**, because a default written
 * out by hand is a second copy that drifts silently — and a projection whose defaults have drifted is
 * worse than one that admits it does not know. `config-projection.test.ts` pins every declaration
 * against the constant it names. A field with no declaration renders *"no default declared here"*,
 * which is honest; it never renders a guess.
 */
export interface DeclaredDefault {
  readonly value: unknown
  /** The exported constant or call site this value is copied from. */
  readonly source: string
}

/**
 * Mark a field as holding a credential.
 *
 * Apply it OUTERMOST — after `Schema.optional` and after `.annotate({description})` — because an
 * optional field's AST is `Union([T, Undefined])` and annotations do not resolve from a union member
 * up to the union. `config-projection.test.ts` proves that both ways round.
 *
 * Marking a container (a record of headers, an environment map) marks everything under it: the
 * projection's redactor replaces every primitive leaf at or below the marked node and leaves the
 * KEYS in place, so *"which variables are set"* survives while their values do not.
 */
export const secret = <S extends Schema.Top>(schema: S): S["Rebuild"] => schema.annotate({ [SECRET]: true })

/**
 * Mark NAMED ENTRIES of an OPEN record as credentials, leaving the rest of the record readable.
 *
 * ⚠️ **This is a name list and it is not the heuristic — the difference is the scope, and it is the
 * whole difference.** The refused shape tests every key in the document against a global word list,
 * so it fires on a provider a user called `headers` and misses one called `client_secret`. This
 * declares, at ONE schema node, which entries of THAT record are credentials — beside the code that
 * reads them. It cannot fire anywhere else, and adding a key elsewhere cannot make it fire.
 *
 * It exists because two live credential slots are single well-known keys inside a `Record(String,
 * Unknown)` whose OTHER entries are the repair target: `session/runner/model.ts:202` reads
 * `model.request.body.apiKey ?? model.api.settings?.apiKey`, while `request.body` is exactly where
 * AGENTS.md's decoded repair writes `chat_template_kwargs`. Blanking the whole record to hide one key
 * would destroy the one repair the self-healing law cites as proof it works.
 */
export const secretEntries = <S extends Schema.Top>(schema: S, names: readonly string[]): S["Rebuild"] =>
  schema.annotate({ [SECRET_ENTRIES]: names })

/** Attach {@link Dependency} facts. Outermost, same reason as {@link secret}. */
export const depends = <S extends Schema.Top>(schema: S, entries: readonly Dependency[]): S["Rebuild"] =>
  schema.annotate({ [DEPENDS]: entries })

/** Attach a {@link DeclaredDefault}. Outermost, same reason as {@link secret}. */
export const withDefault = <S extends Schema.Top>(schema: S, declared: DeclaredDefault): S["Rebuild"] =>
  schema.annotate({ [DEFAULT]: declared })

/** `true` when this exact AST node was marked by {@link secret}. Does not look at descendants — the
 *  projection walks, so inheritance is the walker's job and not this predicate's. */
export const isSecret = (ast: SchemaAST.AST): boolean => SchemaAST.resolve(ast)?.[SECRET] === true

/** The entry names {@link secretEntries} marked on this exact node, or `undefined`. */
export const secretEntriesOf = (ast: SchemaAST.AST): readonly string[] | undefined => {
  const value = SchemaAST.resolve(ast)?.[SECRET_ENTRIES]
  return Array.isArray(value) ? (value as readonly string[]) : undefined
}

/** The {@link Dependency} entries on this node, or `undefined`. */
export const dependenciesOf = (ast: SchemaAST.AST): readonly Dependency[] | undefined => {
  const value = SchemaAST.resolve(ast)?.[DEPENDS]
  return Array.isArray(value) ? (value as readonly Dependency[]) : undefined
}

/** The {@link DeclaredDefault} on this node, or `undefined` — which means *not declared*, never *none*. */
export const defaultOf = (ast: SchemaAST.AST): DeclaredDefault | undefined => {
  const value = SchemaAST.resolve(ast)?.[DEFAULT]
  return value !== null && typeof value === "object" && "value" in value ? (value as DeclaredDefault) : undefined
}
