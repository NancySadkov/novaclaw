/**
 * `config-projection.ts` — the settings schema, projected into something an AGENT can read.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────────
 *
 * AGENTS.md's self-healing law says one working model must be able to restore the instance *by being
 * asked*. `tool/configure.ts` gave a model the ability to WRITE the config; this is the other half —
 * the ability to find out **what is settable, what a legal value looks like, what a write costs, and
 * what shape the write has to take**. Without it the law rests on the agent already knowing, and
 * AGENTS.md's own correction says what that produces: *"a repair path is only real if someone has
 * decoded it. A law illustrated by an example nobody exercised is how a knob ends up in the wrong
 * place while the doc says otherwise."*
 *
 * The item is v0.2.0 ruling 4.1, and the observation behind it is that our
 * schemas ALREADY carry the descriptions the settings UI renders. One description string, three
 * consumers — UI, agent, docs — and no second source to drift.
 *
 * ── THE PART THAT IS NOT DECORATION: THE WRITE SHAPE ───────────────────────────────────────────
 *
 * AGENTS.md records two repairs that a reasonable person would expect to work and that do not:
 * `providers.<id>.api.url` has **never** been expressible (a discriminant-less fragment matches no
 * branch of a tagged union), and adding `type: "native"` is not enough either (`settings` is
 * required, so it then fails `Missing key`). **A projection that says a field is settable when a
 * partial patch to it cannot decode is worse than no projection** — it is the same failure as the
 * law's flagship illustration naming a repair nobody had exercised.
 *
 * So every node carries a {@link Write}, and the classification is not a comment: `describe` derives
 * it from the AST, and `test/config-projection.test.ts` **decodes a probe fragment at every node it
 * reaches** through the same `Config.Info` decode the write path uses. A node this file calls
 * partially-patchable that refuses an empty fragment fails the gate, and so does the converse. The
 * claim is re-measured on every run rather than believed.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DESCRIBE ─────────────────────────────────────────────────────
 *
 *  · **Values.** `configure`'s `read` op already prints what each key HOLDS. This describes the
 *    SCHEMA. Keeping them apart is what lets this module stay pure and testable without a store.
 *  · **Defaults it cannot point at.** A default is reported only where {@link ConfigAnnotation.withDefault}
 *    names the compiled constant it was copied from, and the test pins each one against that
 *    constant. Everywhere else it emits no `default:` line at all and says once, per key, that an
 *    absent line means *not declared here* — which is honest, where a guessed default is a second
 *    copy that drifts in silence.
 *  · **`experimental`'s open leaves and every `Record(String, Unknown)` body.** Those are typed
 *    `unknown` on purpose; the projection says so instead of inventing a shape.
 */
export * as ConfigProjection from "./config-projection"

import { Schema, SchemaAST } from "effect"
import { Config } from "./config"
import { ConfigAnnotation } from "@novaclaw/schema/config-annotation"
import { ConfigStoreWrite } from "./config-store-write"
// ⚠️ The TIER TABLE, never `tool/configure` itself. This module and that tool need each other —
// the tool renders the projection for its `schema` op, the projection prices a key — and a direct
// edge between them is an ESM cycle safe in only ONE import order (measured; `tsgo` green either
// way, see `config-tier.ts`'s header). `config-tier.ts` is the leaf both sides read instead.
import { ConfigTier } from "./config-tier"

// ── the shapes ────────────────────────────────────────────────────────────────────────────────

/** One alternative of a union, with its keys split by whether a patch may omit them. */
export interface Variant {
  readonly tag: string
  readonly required: readonly string[]
  readonly optional: readonly string[]
}

/**
 * **How a patch to this node has to be shaped.** This is the half of the projection that makes it
 * worth having; see the header.
 *
 *  · `value` — a scalar. Send the value.
 *  · `merge` — an object whose every field is optional, so a fragment naming only what changes
 *    decodes and merges. This is the shape people ASSUME the whole config has.
 *  · `whole` — an object with required keys: a fragment fails `Missing key`, so the COMPLETE object
 *    must be sent (spread the one you read back, then change the field).
 *  · `variant` — a union tagged on a literal field. A fragment without the discriminant matches no
 *    branch at all, and each branch then has its own required keys.
 *  · `alternative` — an untagged union: send a value that is wholly one of the alternatives.
 *  · `replace` — an array. Arrays replace wholesale under the merge contract, so send the full list.
 */
export type Write =
  | { readonly kind: "value" }
  | { readonly kind: "merge" }
  | { readonly kind: "whole"; readonly required: readonly string[] }
  | { readonly kind: "variant"; readonly discriminant: string; readonly variants: readonly Variant[] }
  | { readonly kind: "alternative"; readonly variants: readonly string[] }
  | { readonly kind: "replace"; readonly of: string }

/** One node of the schema, addressed the way the REMOVE verb addresses it: as path SEGMENTS. */
export interface Field {
  /** Segments, never a dotted string — config ids contain dots (`holo3.1`) and slashes. */
  readonly path: readonly string[]
  readonly type: string
  readonly description?: string
  /** The closed set of legal values, when the type has one. */
  readonly values?: readonly string[]
  /** Range / format constraints, rendered from the schema's own checks. */
  readonly constraints?: readonly string[]
  /** Present only where the schema DECLARES one — absent means *not declared*, never *none*. */
  readonly default?: ConfigAnnotation.DeclaredDefault
  readonly depends?: readonly ConfigAnnotation.Dependency[]
  readonly secret: boolean
  /** Named entries of this OPEN record that are credentials — the rest of the record reads back. */
  readonly secretEntries?: readonly string[]
  /** `false` = the key must be present once its parent object is sent at all. */
  readonly optional: boolean
  /** Set only when the parent is a union and this field belongs to some alternatives, not all. */
  readonly inVariants?: readonly string[]
  readonly write: Write
  /** One level down. `describe` a child's path to go deeper. */
  readonly children: readonly Field[]
}

/** A top-level `Config.Info` key: a {@link Field} plus the three facts that only apply to a key. */
export interface Key extends Field {
  /** From `config-tier.ts`'s `KEY_TIERS` — the price of the write, not a second table. */
  readonly tier: ConfigTier.Tier
  /** `discarded` = the router accepts it and stores nothing (`NOT_ROUTED_KEYS`). */
  readonly stored: { readonly kind: "stored" } | { readonly kind: "discarded"; readonly reason: string }
  /** Whether `POST /api/config/remove` accepts a path under this key (`REMOVE_REFUSED_KEYS`). */
  readonly removable: { readonly kind: "yes" } | { readonly kind: "no"; readonly reason: string }
  /** Whether the write is live immediately (`RESTART_REQUIRED_KEYS`). */
  readonly live: { readonly kind: "immediate" } | { readonly kind: "restart"; readonly reason: string }
}

// ── AST helpers ───────────────────────────────────────────────────────────────────────────────

/** A `Schema.Class` is a `Declaration` wrapping its struct; everything else is already itself. */
const unwrapClass = (ast: SchemaAST.AST): SchemaAST.AST => {
  if (ast._tag !== "Declaration") return ast
  const parameters = ast.typeParameters
  const first = parameters[0]
  return parameters.length === 1 && first !== undefined && SchemaAST.isObjects(first) ? first : ast
}

const isAbsent = (ast: SchemaAST.AST): boolean => ast._tag === "Undefined"

/**
 * Strip the `Undefined` member an optional field's AST carries, so the rest of this module reasons
 * about the VALUE type. Returns `optional` separately because "may be omitted" is a fact the
 * projection must report — it is the difference between `merge` and `whole` one level up.
 */
const valueOf = (ast: SchemaAST.AST): { readonly ast: SchemaAST.AST; readonly optional: boolean } => {
  const optional = ast.context?.isOptional === true
  if (!SchemaAST.isUnion(ast)) return { ast: unwrapClass(ast), optional }
  const present = ast.types.filter((member) => !isAbsent(member))
  const nullable = ast.types.length !== present.length
  if (present.length === 1) {
    const only = present[0]!
    // A single surviving member is the optional wrapper and nothing else: descend, but keep the
    // annotations of the WRAPPER, which is where `description`/`secret` were authored.
    return { ast: unwrapClass(only), optional: optional || nullable }
  }
  return {
    ast: present.length === ast.types.length ? ast : new SchemaAST.Union(present, ast.mode, ast.annotations),
    optional: optional || nullable,
  }
}

/** Property signatures of an object-ish node, or `undefined` when it is not one. */
const propertiesOf = (ast: SchemaAST.AST): SchemaAST.Objects | undefined => {
  const inner = unwrapClass(ast)
  return SchemaAST.isObjects(inner) ? inner : undefined
}

/** The literal a `Literal` node carries, rendered; `undefined` for every other node. */
const literalOf = (ast: SchemaAST.AST): string | undefined =>
  ast._tag === "Literal" ? JSON.stringify(ast.literal) : undefined

/** The `identifier` a `Schema.Class` / named struct declares, looked up on the node the class name is
 *  actually attached to. See the ⚠️ on {@link renderType}. */
const declaredIdentifier = (ast: SchemaAST.AST): string | undefined => {
  const candidates = SchemaAST.isUnion(ast) ? ast.types.filter((member) => !isAbsent(member)) : [ast]
  if (candidates.length !== 1) return undefined
  const only = candidates[0]!
  if (only._tag !== "Declaration" && !SchemaAST.isObjects(only)) return undefined
  const identifier = SchemaAST.resolve(only)?.["identifier"]
  return typeof identifier === "string" ? identifier : undefined
}

// ── type rendering ────────────────────────────────────────────────────────────────────────────

/** A compact, model-readable rendering of a node's type. Deliberately shallow — the children carry
 *  the detail, and a fully expanded `providers` type would be several kilobytes of one line.
 *
 *  ⚠️ The identifier is read from the node BEFORE `unwrapClass`, because a `Schema.Class`'s identifier
 *  (`ConfigV2.Server`, `Provider.Native`) lives on the `Declaration` and the struct inside it has
 *  none. Reading it after the unwrap is how `server` and `references` rendered as bare `object`. */
const renderType = (ast: SchemaAST.AST): string => {
  const { ast: inner } = valueOf(ast)
  const declared = declaredIdentifier(ast)
  if (declared !== undefined) return declared
  const identifier = SchemaAST.resolve(inner)?.["identifier"]
  switch (inner._tag) {
    case "String":
      return "string"
    case "Number":
      return (inner.checks ?? []).some((check) => metaOf(check)?.["_tag"] === "isInt") ? "integer" : "number"
    case "Boolean":
      return "boolean"
    case "Unknown":
    case "Any":
      return "unknown"
    case "Literal":
      return literalOf(inner) ?? "literal"
    case "Arrays": {
      const rest = inner.rest[0]
      return `array<${rest === undefined ? "unknown" : renderType(rest)}>`
    }
    case "Union":
      return inner.types.map(renderType).join(" | ")
    case "Objects": {
      const objects = inner as SchemaAST.Objects
      if (objects.propertySignatures.length === 0 && objects.indexSignatures.length > 0)
        return `record<string, ${renderType(objects.indexSignatures[0]!.type)}>`
      return typeof identifier === "string" ? identifier : "object"
    }
    default:
      return typeof identifier === "string" ? identifier : inner._tag.toLowerCase()
  }
}

const metaOf = (check: unknown): Record<string, unknown> | undefined => {
  const annotations = (check as { annotations?: Record<string, unknown> }).annotations
  const meta = annotations?.["meta"]
  return meta !== null && typeof meta === "object" ? (meta as Record<string, unknown>) : undefined
}

/** Range and format constraints, read off the schema's own checks rather than off its prose. */
const constraintsOf = (ast: SchemaAST.AST): readonly string[] | undefined => {
  const { ast: inner } = valueOf(ast)
  const out: string[] = []
  for (const check of inner.checks ?? []) {
    const meta = metaOf(check)
    const tag = meta?.["_tag"]
    if (tag === "isInt") out.push("integer")
    else if (tag === "isFinite") out.push("finite")
    else if (tag === "isBetween") out.push(`between ${String(meta!["minimum"])} and ${String(meta!["maximum"])}`)
    else if (tag === "isGreaterThan") out.push(`greater than ${String(meta!["exclusiveMinimum"])}`)
    else if (tag === "isGreaterThanOrEqualTo") out.push(`at least ${String(meta!["minimum"])}`)
    else if (tag === "isLessThanOrEqualTo") out.push(`at most ${String(meta!["maximum"])}`)
    else if (tag === "isPattern")
      out.push(
        `matching ${String((check as { annotations?: { expected?: string } }).annotations?.expected ?? "a pattern")}`,
      )
  }
  return out.length > 0 ? out : undefined
}

/** The closed set of values a node accepts, when it has one. `undefined` = the type is open. */
const valuesOf = (ast: SchemaAST.AST): readonly string[] | undefined => {
  const { ast: inner } = valueOf(ast)
  if (inner._tag === "Boolean") return ["true", "false"]
  const literal = literalOf(inner)
  if (literal !== undefined) return [literal]
  if (!SchemaAST.isUnion(inner)) return undefined
  const members = inner.types.map((member) => valuesOf(member))
  return members.every((member) => member !== undefined) ? (members.flat() as readonly string[]) : undefined
}

// ── the write shape ───────────────────────────────────────────────────────────────────────────

const keysOf = (objects: SchemaAST.Objects) => ({
  required: objects.propertySignatures
    .filter((ps) => ps.type.context?.isOptional !== true)
    .map((ps) => String(ps.name)),
  optional: objects.propertySignatures
    .filter((ps) => ps.type.context?.isOptional === true)
    .map((ps) => String(ps.name)),
})

/**
 * The literal-valued key every member of a union declares and none may omit — i.e. the discriminant.
 * Detected STRUCTURALLY rather than from the `~sentinels` annotation, because `Provider.Api` loses
 * that annotation to a later `.annotate({identifier})` while `ConfigMCP.Server` keeps it. A property
 * that is a literal in every branch is the discriminant whichever way the union was built.
 */
const discriminantOf = (members: readonly SchemaAST.AST[]): string | undefined => {
  const first = propertiesOf(members[0]!)
  if (first === undefined) return undefined
  for (const candidate of first.propertySignatures) {
    const name = String(candidate.name)
    const literalInEvery = members.every((member) => {
      const properties = propertiesOf(member)
      const match = properties?.propertySignatures.find((ps) => String(ps.name) === name)
      return match !== undefined && match.type.context?.isOptional !== true && literalOf(match.type) !== undefined
    })
    if (literalInEvery) return name
  }
  return undefined
}

const writeOf = (ast: SchemaAST.AST): Write => {
  const { ast: inner } = valueOf(ast)
  if (inner._tag === "Arrays") {
    const rest = inner.rest[0]
    return { kind: "replace", of: rest === undefined ? "unknown" : renderType(rest) }
  }
  if (SchemaAST.isUnion(inner)) {
    const members = inner.types
    // A union of literals is a closed value set, not a shape decision.
    if (members.every((member) => literalOf(member) !== undefined)) return { kind: "value" }
    const discriminant = discriminantOf(members)
    if (discriminant !== undefined)
      return {
        kind: "variant",
        discriminant,
        variants: members.map((member) => {
          const properties = propertiesOf(member)!
          const tag = properties.propertySignatures.find((ps) => String(ps.name) === discriminant)!
          const { required, optional } = keysOf(properties)
          return {
            tag: literalOf(tag.type) ?? "?",
            required: required.filter((name) => name !== discriminant),
            optional,
          }
        }),
      }
    return { kind: "alternative", variants: members.map(renderType) }
  }
  const objects = propertiesOf(inner)
  if (objects === undefined) return { kind: "value" }
  const { required } = keysOf(objects)
  return required.length === 0 ? { kind: "merge" } : { kind: "whole", required }
}

// ── walking ───────────────────────────────────────────────────────────────────────────────────

/** The label a record's open key gets in a child path. Angle brackets so it cannot be mistaken for
 *  a literal segment a caller should copy. */
const OPEN_KEY = "<key>"

/** The segment standing for "one element of this array". Not an index — there is no per-element
 *  remove path, and printing `0` would invite a caller to try one. */
const ELEMENT = "[]"

interface Child {
  readonly name: string
  readonly ast: SchemaAST.AST
  /** Set only when the parent is a union and this field is not in every alternative. */
  readonly inVariants?: readonly string[]
  /** Overrides the node's own optionality — a union child is omittable if ANY branch omits it. */
  readonly optional?: boolean
}

/**
 * A union's fields, gathered across branches.
 *
 * ⚠️ **Deduplicating by name and keeping the FIRST branch's node is a lie**, and it was the first
 * thing this file got wrong: `providers.<id>.api.type` rendered as `"aisdk"` with legal values
 * `["aisdk"]`, because `Provider.AISDK` happens to come first. An agent reading that would send a
 * value the other branch rejects. So a name carried by several branches becomes a UNION of what
 * those branches declare, and a name carried by only some says which.
 */
const unionChildren = (members: readonly SchemaAST.AST[]): readonly Child[] => {
  const discriminant = discriminantOf(members)
  const tagOf = (member: SchemaAST.AST) => {
    const properties = propertiesOf(member)
    const tag = properties?.propertySignatures.find((ps) => String(ps.name) === discriminant)
    return tag === undefined ? renderType(member) : (literalOf(tag.type) ?? renderType(member))
  }
  const order: string[] = []
  const branches = new Map<string, { tag: string; ast: SchemaAST.AST; optional: boolean }[]>()
  for (const member of members)
    for (const ps of propertiesOf(member)?.propertySignatures ?? []) {
      const name = String(ps.name)
      if (!branches.has(name)) {
        branches.set(name, [])
        order.push(name)
      }
      branches.get(name)!.push({ tag: tagOf(member), ast: ps.type, optional: ps.type.context?.isOptional === true })
    }
  const named: Child[] = order.map((name) => {
    const carried = branches.get(name)!
    const distinct = [...new Map(carried.map((entry) => [renderType(entry.ast), entry.ast])).values()]
    return {
      name,
      ast: distinct.length === 1 ? distinct[0]! : new SchemaAST.Union(distinct, "anyOf"),
      // Omittable if any branch omits it outright, or declares it optional.
      optional: carried.length < members.length || carried.some((entry) => entry.optional),
      ...(carried.length < members.length ? { inVariants: carried.map((entry) => entry.tag) } : {}),
    }
  })
  // A branch that is a RECORD contributes an open key, not a field. `formatter` is
  // `boolean | record<string, Entry>`, and without this its entries were unreachable — the marker on
  // `formatter.<key>.environment` existed and nothing could walk to it.
  const open = members.flatMap((member) => propertiesOf(member)?.indexSignatures ?? [])
  return open.length === 0 ? named : [...named, { name: OPEN_KEY, ast: open[0]!.type, optional: true } satisfies Child]
}

const childrenOf = (ast: SchemaAST.AST, path: readonly string[]): readonly Child[] => {
  const { ast: inner } = valueOf(ast)
  // An array REPLACES wholesale, so its element shape is what a caller has to build in order to send
  // the list at all. The segment is `[]` rather than an index: there is no per-element remove path,
  // and printing `0` would invite one.
  if (inner._tag === "Arrays") {
    const rest = inner.rest[0]
    return rest === undefined ? [] : [{ name: ELEMENT, ast: rest, optional: true }]
  }
  if (SchemaAST.isUnion(inner)) return unionChildren(inner.types)
  const objects = propertiesOf(inner)
  if (objects === undefined) return []
  const named = objects.propertySignatures.map((ps) => ({ name: String(ps.name), ast: ps.type }))
  const open = objects.indexSignatures.map((is) => ({ name: OPEN_KEY, ast: is.type }))
  return path.length === 0 ? named : [...named, ...open]
}

/**
 * `secret` is sticky UPWARD through the optional wrapper: an author who writes
 * `secret(X).pipe(Schema.optional)` instead of `secret(X.pipe(Schema.optional))` gets the same
 * answer. The trap is real — annotations do not resolve from a union member to the union — and a
 * marker that silently does nothing is exactly the failure mode this file exists to remove.
 */
const secretAt = (ast: SchemaAST.AST): boolean => {
  if (ConfigAnnotation.isSecret(ast)) return true
  if (!SchemaAST.isUnion(ast)) return false
  return ast.types.some((member) => !isAbsent(member) && ConfigAnnotation.isSecret(member))
}

/** `secretEntries` resolves through the optional wrapper for the same reason {@link secretAt} does. */
const secretEntriesAt = (ast: SchemaAST.AST): readonly string[] | undefined =>
  ConfigAnnotation.secretEntriesOf(ast) ?? ConfigAnnotation.secretEntriesOf(valueOf(ast).ast)

const fieldAt = (ast: SchemaAST.AST, path: readonly string[], depth: number, override?: Child): Field => {
  const { optional: declaredOptional } = valueOf(ast)
  // The open key of a record is not "required": it stands for whichever ids this instance holds.
  const optional = override?.optional ?? (path[path.length - 1] === OPEN_KEY ? true : declaredOptional)
  const description = SchemaAST.resolve(ast)?.description
  return {
    path,
    type: renderType(ast),
    ...(override?.inVariants !== undefined ? { inVariants: override.inVariants } : {}),
    ...(typeof description === "string" ? { description } : {}),
    ...(valuesOf(ast) !== undefined ? { values: valuesOf(ast)! } : {}),
    ...(constraintsOf(ast) !== undefined ? { constraints: constraintsOf(ast)! } : {}),
    ...(ConfigAnnotation.defaultOf(ast) !== undefined ? { default: ConfigAnnotation.defaultOf(ast)! } : {}),
    ...(ConfigAnnotation.dependenciesOf(ast) !== undefined ? { depends: ConfigAnnotation.dependenciesOf(ast)! } : {}),
    secret: secretAt(ast),
    ...(secretEntriesAt(ast) !== undefined ? { secretEntries: secretEntriesAt(ast)! } : {}),
    optional,
    write: writeOf(ast),
    children:
      depth <= 0
        ? []
        : childrenOf(ast, path).map((child) => fieldAt(child.ast, [...path, child.name], depth - 1, child)),
  }
}

/**
 * Resolve a path to its AST node. `undefined` = the path names nothing.
 *
 * ⚠️ Derived inside a function body, never at module scope: `config.ts` sits in an import cycle with
 * the settings seed, and that file's ⚠️ requires every `Config.Info` derivation to stay lazy. The
 * same rule is why `tool/configure.ts`'s `configKeys` is a function.
 */
const nodeAt = (path: readonly string[]): SchemaAST.AST | undefined => {
  const fields = Config.Info.fields as Record<string, Schema.Top | undefined>
  const head = path[0]
  if (head === undefined) return undefined
  let node: SchemaAST.AST | undefined = fields[head]?.ast
  for (const segment of path.slice(1)) {
    if (node === undefined) return undefined
    const { ast: inner } = valueOf(node)
    if (inner._tag === "Arrays") {
      node = segment === ELEMENT ? inner.rest[0] : undefined
      continue
    }
    const candidates = SchemaAST.isUnion(inner) ? inner.types : [inner]
    let next: SchemaAST.AST | undefined
    for (const candidate of candidates) {
      const objects = propertiesOf(candidate)
      if (objects === undefined) continue
      const named = objects.propertySignatures.find((ps) => String(ps.name) === segment)
      if (named !== undefined) {
        next = named.type
        break
      }
      const open = objects.indexSignatures[0]
      // A record accepts any key, so ANY segment resolves to the value type — which is what makes
      // `providers.spark-holo.models.holo3.1` describable without knowing the ids on this machine.
      if (open !== undefined) {
        next = open.type
        break
      }
    }
    node = next
  }
  return node
}

// ── the public surface ────────────────────────────────────────────────────────────────────────

/** Every top-level `Config.Info` key, read off the schema rather than re-typed. */
export const keys = (): readonly string[] => Object.keys(Config.Info.fields)

/**
 * One node of the schema, with `depth` levels of children (default 1 — the survey depth the docs
 * economy asks for: names in the reply, detail on request).
 */
export const describe = (path: readonly string[], depth = 1): Field | undefined => {
  const node = nodeAt(path)
  return node === undefined ? undefined : fieldAt(node, path, depth)
}

/** A top-level key, with its price and its storage/removal/liveness facts joined on. */
export const key = (name: string, depth = 1): Key | undefined => {
  const field = describe([name], depth)
  if (field === undefined) return undefined
  const discarded = ConfigStoreWrite.NOT_ROUTED_KEYS.get(name)
  const refused = ConfigStoreWrite.REMOVE_REFUSED_KEYS.get(name)
  const restart = ConfigStoreWrite.RESTART_REQUIRED_KEYS.get(name)
  return {
    ...field,
    tier: ConfigTier.tierOf(name),
    stored: discarded === undefined ? { kind: "stored" } : { kind: "discarded", reason: discarded },
    removable: refused === undefined ? { kind: "yes" } : { kind: "no", reason: refused },
    live: restart === undefined ? { kind: "immediate" } : { kind: "restart", reason: restart },
  }
}

/** Every top-level key at survey depth. */
export const overview = (): readonly Key[] => keys().map((name) => key(name, 0)!)

/**
 * **Every path in `Config.Info` that holds a credential**, exhaustively — the answer to
 * the operator question *what can this agent reach?*, and the ledger
 * `test/config-projection.test.ts` pins so that adding or dropping a marker is a visible decision.
 *
 * Walks the whole tree rather than the `describe` children, because a marker under an array element
 * or under a union's record branch is still a credential — and both were reachable by the schema and
 * invisible to a survey-depth walk when this was first written.
 */
export const secretPaths = (): readonly string[] => {
  const found = new Set<string>()
  const visit = (ast: SchemaAST.AST, path: readonly string[], depth: number) => {
    if (depth <= 0) return
    if (secretAt(ast)) {
      found.add(path.join("."))
      // A marked subtree is secret whole; enumerating its leaves would list the same fact N times.
      return
    }
    for (const entry of secretEntriesAt(ast) ?? []) found.add([...path, entry].join("."))
    for (const child of childrenOf(ast, path)) visit(child.ast, [...path, child.name], depth - 1)
  }
  const fields = Config.Info.fields as Record<string, Schema.Top>
  for (const [name, schema] of Object.entries(fields)) visit(schema.ast, [name], 8)
  return [...found].sort()
}

/**
 * Names that are a credential in one branch of a union and an ordinary setting in another.
 *
 * **Must stay empty for `Config.Info`**, and the test says so — it is the precondition that makes
 * {@link redact}'s first-branch-wins walk correct.
 *
 * ⚠️ `fields` is a parameter for one reason: *"the answer is `[]`"* is what a BROKEN detector also
 * says, so asserting it over `Config.Info` alone is self-referential and passes for any
 * implementation including one that returns a constant. The test drives a synthetic schema that DOES
 * have the ambiguity through the same function, which is the positive control the empty answer needs.
 */
export const ambiguousSecretNames = (
  fields: Record<string, Schema.Top> = Config.Info.fields as Record<string, Schema.Top>,
): readonly string[] => {
  const found = new Set<string>()
  const visit = (ast: SchemaAST.AST, depth: number) => {
    if (depth <= 0) return
    const { ast: inner } = valueOf(ast)
    if (SchemaAST.isUnion(inner)) {
      const branches = inner.types
      const names = new Set(branches.flatMap((branch) => childrenOf(branch, ["x"]).map((child) => child.name)))
      for (const name of names) {
        const nodes = branches.flatMap((branch) => childAst(branch, name))
        if (nodes.some(secretAt) && nodes.some((node) => !secretAt(node))) found.add(name)
      }
    }
    for (const child of childrenOf(ast, ["x"])) visit(child.ast, depth - 1)
  }
  for (const schema of Object.values(fields)) visit(schema.ast, 8)
  return [...found].sort()
}

// ── redaction ─────────────────────────────────────────────────────────────────────────────────

/** The same sentence `configure`'s read op already uses, so the two cannot drift into two vocabularies.
 *  Both read it from `config-tier.ts`; neither owns it, which is what makes "the same sentence" true
 *  by construction rather than by convention. */
export const REDACTED = ConfigTier.REDACTED

/**
 * Replace every primitive under a {@link ConfigAnnotation.secret} node, walking the VALUE against the
 * SCHEMA rather than against its key names.
 *
 * ⚠️ **This is the whole point of item 4.1** and the reason it does not take a `SECRET_FIELDS` set.
 * A name test cannot tell `mcp.servers.headers` (a server a user called "headers") from
 * `mcp.servers.weather.headers` (a bearer token), because half of this surface is user-chosen record
 * keys. The schema knows which is which; a string does not.
 *
 * KEYS survive — only the leaves are replaced — so *"which environment variables are set"* is still
 * answerable while their values are not. An unknown key is walked but never redacted: it is not in
 * the schema, so nothing here claims to know what it is.
 */
export const redact = (value: unknown): unknown => {
  const fields = Config.Info.fields as Record<string, Schema.Top | undefined>
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, entry]) => [
      name,
      // An undeclared top-level key is passed through untouched: it is not in the schema, so nothing
      // here knows what it is, and inventing a verdict about it is the guess this module refuses.
      fields[name] === undefined ? entry : redactNode(entry, fields[name]!.ast),
    ]),
  )
}

/**
 * The walk. Value and schema descend together, which is what lets a user-chosen record KEY be told
 * apart from a schema-declared FIELD of the same spelling.
 */
const redactNode = (value: unknown, ast: SchemaAST.AST): unknown => {
  if (secretAt(ast)) return blank(value)
  const { ast: inner } = valueOf(ast)
  if (Array.isArray(value)) {
    const rest = inner._tag === "Arrays" ? inner.rest[0] : undefined
    return rest === undefined ? value : value.map((entry) => redactNode(entry, rest))
  }
  if (value === null || typeof value !== "object") return value
  const entries = ConfigAnnotation.secretEntriesOf(inner) ?? ConfigAnnotation.secretEntriesOf(ast)
  // A union's branches are searched in order and the FIRST branch declaring the name wins.
  //
  // ⚠️ That is only correct while no name is a credential in one branch and a setting in another,
  // and it is not a defensive guess — `config-projection.test.ts` ratchets exactly that invariant
  // over every union in `Config.Info`. A conservative "secret in any branch ⇒ blank" arm was written
  // first and DELETED: the schema has no such name today, so the arm was a branch nothing exercised,
  // which is the shape this repo calls cruft. If the ratchet ever fails, that arm is the fix.
  const branches = SchemaAST.isUnion(inner) ? inner.types : [inner]
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, entry]) => {
      if (entries?.includes(name) === true) return [name, blank(entry)]
      const candidate = branches.flatMap((branch) => childAst(branch, name))[0]
      return candidate === undefined ? [name, entry] : [name, redactNode(entry, candidate)]
    }),
  )
}

/** The schema node for one key of one object-ish branch: a declared field, else the record's value type. */
const childAst = (branch: SchemaAST.AST, name: string): SchemaAST.AST[] => {
  const objects = propertiesOf(branch)
  if (objects === undefined) return []
  const named = objects.propertySignatures.find((ps) => String(ps.name) === name)
  if (named !== undefined) return [named.type]
  const open = objects.indexSignatures[0]
  return open === undefined ? [] : [open.type]
}

/** Every primitive leaf becomes {@link REDACTED}; structure and keys stay. */
const blank = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(blank)
  if (value === null || typeof value !== "object") return REDACTED
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, entry]) => [name, blank(entry)]),
  )
}

// ── rendering for a model ─────────────────────────────────────────────────────────────────────

const showPath = (path: readonly string[]) => JSON.stringify(path)

const writeSentence = (write: Write): string => {
  switch (write.kind) {
    case "value":
      return "Send the value."
    case "merge":
      return "Send only the fields you are changing — every field is optional and objects merge."
    case "whole":
      return (
        `Send the COMPLETE object: ${write.required.join(", ")} ${write.required.length === 1 ? "is" : "are"} ` +
        "REQUIRED, so a fragment fails with `Missing key`. Read the value first and spread it."
      )
    case "variant":
      return (
        `Send one COMPLETE alternative including its \`${write.discriminant}\` — a fragment without the ` +
        `\`${write.discriminant}\` matches no branch and cannot decode at all. Alternatives: ` +
        write.variants
          .map(
            (variant) =>
              `${write.discriminant}=${variant.tag} needs {${[`${write.discriminant}`, ...variant.required].join(", ")}}` +
              (variant.optional.length > 0 ? ` (optional: ${variant.optional.join(", ")})` : ""),
          )
          .join(" · ")
      )
    case "alternative":
      return `Send a value that is wholly one of: ${write.variants.join(" | ")}.`
    case "replace":
      return "An array — arrays REPLACE wholesale, so send the full list including the entries you are keeping."
  }
}

const renderField = (field: Field, indent: string): string[] => {
  const last = field.path[field.path.length - 1]
  const line = [
    `${indent}${showPath(field.path)}: ${field.type}${field.optional ? "" : " (required)"}`,
    last === OPEN_KEY ? " — one entry; the segment is whichever id this instance holds" : "",
    field.inVariants === undefined ? "" : ` — only in ${field.inVariants.join(", ")}`,
    field.secret ? " [secret — writable, never read back]" : "",
    field.secretEntries === undefined
      ? ""
      : ` [the ${field.secretEntries.join(", ")} entr${field.secretEntries.length === 1 ? "y is" : "ies are"} secret — writable, never read back]`,
  ].join("")
  const out = [line]
  if (field.description !== undefined) out.push(`${indent}  ${field.description}`)
  if (field.values !== undefined) out.push(`${indent}  legal values: ${field.values.join(" | ")}`)
  if (field.constraints !== undefined) out.push(`${indent}  constraints: ${field.constraints.join(", ")}`)
  // Printed only where DECLARED. A "default: none" line on every field would be 48 repetitions of a
  // fact the header states once, and — worse — it reads like a measurement of the code rather than
  // of the schema. See the header's *what it deliberately does not describe*.
  if (field.default !== undefined)
    out.push(`${indent}  default: ${JSON.stringify(field.default.value)} (from ${field.default.source})`)
  for (const dependency of field.depends ?? [])
    out.push(
      `${indent}  depends: ${showPath(dependency.path)} must be ${dependency.when} — ` +
        `${dependency.effect} (${dependency.source})`,
    )
  out.push(`${indent}  write: ${writeSentence(field.write)}`)
  for (const child of field.children) out.push(...renderField(child, `${indent}  `))
  return out
}

/** One key, in full — the reply to *"what is `providers` and how do I write it?"*. */
export const renderKey = (name: string, depth = 1): string => {
  const projected = key(name, depth)
  if (projected === undefined)
    return `"${name}" is not a configuration key. The keys this instance has are: ${[...keys()].sort().join(", ")}.`
  return [
    ...renderField(projected, ""),
    "  — a field with no `default:` line declares none in this schema; its compiled fallback lives in code.",
    `  price: ${projected.tier}${projected.tier === "operational" ? " (written without asking)" : " (one approval, scoped to this key)"}`,
    projected.stored.kind === "stored"
      ? ""
      : `  ⚠️ accepted and DISCARDED — this instance stores no value for it: ${projected.stored.reason}`,
    projected.removable.kind === "yes"
      ? `  remove: POST /api/config/remove with segment arrays, e.g. {"paths":[${showPath([name])}]}`
      : `  remove: refused — ${projected.removable.reason}`,
    projected.live.kind === "immediate" ? "" : `  ⚠️ NOT live until restart: ${projected.live.reason}`,
  ]
    .filter(Boolean)
    .join("\n")
}

/** The survey: every key, one line, cheap enough to sit in a reply. */
export const renderOverview = (): string =>
  [
    `This instance's configuration schema — ${keys().length} keys. Ask for one by name to see its fields, legal values and write shape.`,
    ...overview().map(
      (projected) =>
        `${projected.path[0]} [${projected.tier}] ${projected.type}` +
        (projected.secret ? " [secret]" : "") +
        (projected.removable.kind === "yes" ? "" : " [not removable]") +
        (projected.description === undefined ? "" : ` — ${projected.description.split(". ")[0]}`),
    ),
    "",
    "Paths are SEGMENT ARRAYS, never dotted strings — a config id can contain dots and slashes.",
  ].join("\n")
