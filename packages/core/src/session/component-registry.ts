export * as SessionComponentRegistry from "./component-registry"

import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionSchema } from "./schema"
import { SessionComponentTable } from "./sql"

export const LIFETIMES = ["entity", "attempt", "bounded"] as const
export type Lifetime = (typeof LIFETIMES)[number]
export const CARDINALITIES = ["singleton", "set"] as const
export type Cardinality = (typeof CARDINALITIES)[number]

/**
 * The compiled namespace. A new kernel kind is a code change by definition (ruling 10), so dynamic
 * registration can never claim one of these names. Names may precede their storage adapter; only
 * definitions actually supplied to `layerWith` are advertised by `definitions()`.
 */
export const KERNEL_KIND_NAMES = [
  "title",
  "tuning",
  "permission_mode",
  "working_folder",
  "system_prompt_override",
  "device",
  "priority",
  "goal",
  "plan",
  "control_binding",
  "observation",
] as const
export type KernelKind = (typeof KERNEL_KIND_NAMES)[number]

const TOOL_KIND_PATTERN = /^tool\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/
export const ToolKind = Schema.String.check(Schema.isPattern(TOOL_KIND_PATTERN)).pipe(
  Schema.brand("SessionComponent.ToolKind"),
)
export type ToolKind = typeof ToolKind.Type

export const ComponentID = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._:-]{0,127}$/)).pipe(
  Schema.brand("SessionComponent.ID"),
)
export type ComponentID = typeof ComponentID.Type

export interface AttemptFence {
  readonly attemptID: string
  readonly generation: number
}

export interface Definition<A = unknown> {
  readonly kind: KernelKind | ToolKind
  readonly owner: "kernel" | `tool/${string}`
  readonly description: string
  readonly cardinality: Cardinality
  readonly lifetime: Lifetime
  readonly version: number
  readonly codec: Schema.Codec<A, Schema.Json, never, never>
  /** Decode an older stored version into the current typed value. Absence makes drift explicit. */
  readonly migrate?: (input: { readonly version: number; readonly value: Schema.Json }) => Effect.Effect<A>
}

export interface DefinitionInfo {
  readonly kind: string
  readonly owner: string
  readonly description: string
  readonly cardinality: Cardinality
  readonly lifetime: Lifetime
  readonly version: number
  readonly schema: unknown
}

export interface Entry {
  readonly sessionID: SessionSchema.ID
  readonly kind: string
  readonly id?: ComponentID
  readonly value: Schema.Json
  readonly version: number
  readonly lifetime: Lifetime
  readonly attempt?: AttemptFence
  readonly expiresAt?: number
  readonly stale: boolean
  readonly staleReason?: "attempt-missing" | "attempt-mismatch" | "expired"
}

export class RegistryError extends Schema.TaggedErrorClass<RegistryError>()("SessionComponent.RegistryError", {
  message: Schema.String,
}) {}

export class UnknownKindError extends Schema.TaggedErrorClass<UnknownKindError>()("SessionComponent.UnknownKind", {
  kind: Schema.String,
}) {
  override get message() {
    return `Unknown session component kind: ${this.kind}`
  }
}

export class InvalidValueError extends Schema.TaggedErrorClass<InvalidValueError>()("SessionComponent.InvalidValue", {
  kind: Schema.String,
  message: Schema.String,
}) {}

export class StoredValueError extends Schema.TaggedErrorClass<StoredValueError>()("SessionComponent.StoredValueError", {
  kind: Schema.String,
  id: Schema.optional(Schema.String),
  version: Schema.Int,
  message: Schema.String,
}) {}

type ComponentError = RegistryError | UnknownKindError | InvalidValueError | StoredValueError

export interface PutInput {
  readonly sessionID: SessionSchema.ID
  readonly kind: string
  readonly id?: string
  readonly value: unknown
  readonly attempt?: AttemptFence
  readonly expiresAt?: number
}

export interface ReadInput {
  readonly sessionID: SessionSchema.ID
  readonly kind: string
  readonly id?: string
  readonly attempt?: AttemptFence
  readonly now?: number
}

export interface Interface {
  readonly registerTool: <A>(definition: Definition<A>) => Effect.Effect<void, RegistryError>
  readonly definitions: () => ReadonlyArray<DefinitionInfo>
  readonly get: (input: ReadInput) => Effect.Effect<Entry | undefined, ComponentError>
  readonly list: (input: Omit<ReadInput, "id">) => Effect.Effect<ReadonlyArray<Entry>, ComponentError>
  readonly put: (input: PutInput) => Effect.Effect<Entry, ComponentError>
  readonly remove: (input: Omit<ReadInput, "attempt" | "now">) => Effect.Effect<boolean, ComponentError>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionComponentRegistry") {}

const SINGLETON_ID = ""
const kernelNames = new Set<string>(KERNEL_KIND_NAMES)

export const toolKind = (owner: string, name: string): ToolKind =>
  Schema.decodeUnknownSync(ToolKind)(`tool/${owner}/${name}`)

export const kernelDefinition = <A>(input: Omit<Definition<A>, "owner"> & { readonly kind: KernelKind }) =>
  ({ ...input, owner: "kernel" }) satisfies Definition<A>

export const toolDefinition = <A>(
  owner: string,
  input: Omit<Definition<A>, "kind" | "owner"> & { readonly name: string },
) => {
  const { name, ...definition } = input
  return { ...definition, kind: toolKind(owner, name), owner: `tool/${owner}` } satisfies Definition<A>
}

const infoOf = (definition: Definition): DefinitionInfo => ({
  kind: definition.kind,
  owner: definition.owner,
  description: definition.description,
  cardinality: definition.cardinality,
  lifetime: definition.lifetime,
  version: definition.version,
  schema: Schema.toJsonSchemaDocument(definition.codec),
})

const storedID = (definition: Definition, id: string | undefined): Effect.Effect<string, RegistryError> => {
  if (definition.cardinality === "singleton") {
    return id === undefined
      ? Effect.succeed(SINGLETON_ID)
      : Effect.fail(new RegistryError({ message: `${definition.kind} is a singleton and does not take an id` }))
  }
  if (id === undefined)
    return Effect.fail(new RegistryError({ message: `${definition.kind} is a set and requires an id` }))
  return Schema.decodeUnknownEffect(ComponentID)(id).pipe(
    Effect.map(String),
    Effect.mapError(() => new RegistryError({ message: `Invalid component id for ${definition.kind}: ${id}` })),
  )
}

const assertLifetime = (definition: Definition, input: PutInput): Effect.Effect<void, RegistryError> => {
  if (definition.lifetime === "entity") {
    return input.attempt === undefined && input.expiresAt === undefined
      ? Effect.void
      : Effect.fail(new RegistryError({ message: `${definition.kind} has entity lifetime; attempt/expiry is invalid` }))
  }
  if (definition.lifetime === "attempt") {
    return input.attempt !== undefined &&
      input.attempt.attemptID.length > 0 &&
      Number.isInteger(input.attempt.generation) &&
      input.attempt.generation >= 0 &&
      input.expiresAt === undefined
      ? Effect.void
      : Effect.fail(
          new RegistryError({
            message: `${definition.kind} requires a non-empty attempt id, generation, and no expiry`,
          }),
        )
  }
  return input.expiresAt !== undefined && Number.isSafeInteger(input.expiresAt) && input.attempt === undefined
    ? Effect.void
    : Effect.fail(
        new RegistryError({ message: `${definition.kind} requires an integer expiresAt and no attempt fence` }),
      )
}

const definitionProblem = (definition: Definition, expectedOwner: "kernel" | "tool"): string | undefined => {
  if (expectedOwner === "kernel") {
    if (definition.owner !== "kernel" || !kernelNames.has(definition.kind))
      return `Invalid compiled session component definition: ${definition.kind} (${definition.owner})`
  } else {
    if (
      !TOOL_KIND_PATTERN.test(String(definition.kind)) ||
      definition.owner !== `tool/${String(definition.kind).split("/")[1]}`
    )
      return `Dynamic component kinds must own a tool/<owner>/<kind> namespace`
    if (kernelNames.has(definition.kind)) return `Kernel component kind cannot be registered: ${definition.kind}`
  }
  if (!(CARDINALITIES as ReadonlyArray<string>).includes(definition.cardinality))
    return `Invalid cardinality for ${definition.kind}`
  if (!(LIFETIMES as ReadonlyArray<string>).includes(definition.lifetime))
    return `Invalid lifetime for ${definition.kind}`
  if (!Number.isInteger(definition.version) || definition.version < 1)
    return `Component schema version must be a positive integer`
  if (definition.description.trim().length === 0) return `Component description must not be empty`
  try {
    Schema.toJsonSchemaDocument(definition.codec)
  } catch (cause) {
    return `Component schema cannot be rendered for introspection: ${String(cause)}`
  }
}

export const layerWith = (kernelDefinitions: ReadonlyArray<Definition> = []) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const definitions = new Map<string, Definition>()

      for (const definition of kernelDefinitions) {
        const problem = definitionProblem(definition, "kernel")
        if (problem) return yield* Effect.die(new Error(problem))
        if (definitions.has(definition.kind))
          return yield* Effect.die(new Error(`Duplicate compiled session component kind: ${definition.kind}`))
        definitions.set(definition.kind, definition)
      }

      const definitionOf = (kind: string): Effect.Effect<Definition, UnknownKindError> => {
        const definition = definitions.get(kind)
        return definition ? Effect.succeed(definition) : Effect.fail(new UnknownKindError({ kind }))
      }

      const decodeStored = Effect.fn("SessionComponent.decodeStored")(function* (
        definition: Definition,
        row: typeof SessionComponentTable.$inferSelect,
      ) {
        const decodeCurrent = (value: unknown) =>
          Schema.decodeUnknownEffect(definition.codec)(value).pipe(
            Effect.mapError(
              (cause) =>
                new StoredValueError({
                  kind: row.kind,
                  ...(row.component_id === SINGLETON_ID ? {} : { id: row.component_id }),
                  version: row.schema_version,
                  message: String(cause),
                }),
            ),
          )
        const decoded =
          row.schema_version === definition.version
            ? yield* decodeCurrent(row.value)
            : definition.migrate
              ? yield* definition.migrate({ version: row.schema_version, value: row.value }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new StoredValueError({
                        kind: row.kind,
                        ...(row.component_id === SINGLETON_ID ? {} : { id: row.component_id }),
                        version: row.schema_version,
                        message: String(cause),
                      }),
                  ),
                )
              : yield* new StoredValueError({
                  kind: row.kind,
                  ...(row.component_id === SINGLETON_ID ? {} : { id: row.component_id }),
                  version: row.schema_version,
                  message: `No migration from schema version ${row.schema_version} to ${definition.version}`,
                })
        return yield* Schema.encodeEffect(definition.codec)(decoded).pipe(
          Effect.mapError(
            (cause) =>
              new StoredValueError({
                kind: row.kind,
                ...(row.component_id === SINGLETON_ID ? {} : { id: row.component_id }),
                version: row.schema_version,
                message: String(cause),
              }),
          ),
        )
      })

      const entryOf = Effect.fn("SessionComponent.entryOf")(function* (
        definition: Definition,
        row: typeof SessionComponentTable.$inferSelect,
        attempt: AttemptFence | undefined,
        now: number,
      ) {
        const value = yield* decodeStored(definition, row)
        const staleReason =
          row.lifetime === "attempt"
            ? attempt === undefined
              ? "attempt-missing"
              : row.attempt_id !== attempt.attemptID || row.generation !== attempt.generation
                ? "attempt-mismatch"
                : undefined
            : row.lifetime === "bounded" && row.expires_at !== null && row.expires_at <= now
              ? "expired"
              : undefined
        return {
          sessionID: row.session_id,
          kind: row.kind,
          ...(row.component_id === SINGLETON_ID ? {} : { id: ComponentID.make(row.component_id) }),
          value,
          version: row.schema_version,
          lifetime: row.lifetime,
          ...(row.attempt_id === null || row.generation === null
            ? {}
            : { attempt: { attemptID: row.attempt_id, generation: row.generation } }),
          ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
          stale: staleReason !== undefined,
          ...(staleReason === undefined ? {} : { staleReason }),
        } satisfies Entry
      })

      const get = Effect.fn("SessionComponent.get")(function* (input: ReadInput) {
        const definition = yield* definitionOf(input.kind)
        const componentID = yield* storedID(definition, input.id)
        const row = yield* db
          .select()
          .from(SessionComponentTable)
          .where(
            and(
              eq(SessionComponentTable.session_id, input.sessionID),
              eq(SessionComponentTable.kind, definition.kind),
              eq(SessionComponentTable.component_id, componentID),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        return row ? yield* entryOf(definition, row, input.attempt, input.now ?? Date.now()) : undefined
      })

      const list = Effect.fn("SessionComponent.list")(function* (input: Omit<ReadInput, "id">) {
        const definition = yield* definitionOf(input.kind)
        const rows = yield* db
          .select()
          .from(SessionComponentTable)
          .where(
            and(eq(SessionComponentTable.session_id, input.sessionID), eq(SessionComponentTable.kind, definition.kind)),
          )
          .orderBy(asc(SessionComponentTable.component_id))
          .all()
          .pipe(Effect.orDie)
        return yield* Effect.forEach(rows, (row) => entryOf(definition, row, input.attempt, input.now ?? Date.now()))
      })

      const put = Effect.fn("SessionComponent.put")(function* (input: PutInput) {
        const definition = yield* definitionOf(input.kind)
        const componentID = yield* storedID(definition, input.id)
        yield* assertLifetime(definition, input)
        const decoded = yield* Schema.decodeUnknownEffect(definition.codec)(input.value).pipe(
          Effect.mapError((cause) => new InvalidValueError({ kind: definition.kind, message: String(cause) })),
        )
        const value = yield* Schema.encodeEffect(definition.codec)(decoded).pipe(
          Effect.mapError((cause) => new InvalidValueError({ kind: definition.kind, message: String(cause) })),
        )
        const now = Date.now()
        yield* db
          .insert(SessionComponentTable)
          .values({
            session_id: input.sessionID,
            kind: definition.kind,
            component_id: componentID,
            schema_version: definition.version,
            lifetime: definition.lifetime,
            attempt_id: input.attempt?.attemptID,
            generation: input.attempt?.generation,
            expires_at: input.expiresAt,
            value,
            time_created: now,
            time_updated: now,
          })
          .onConflictDoUpdate({
            target: [SessionComponentTable.session_id, SessionComponentTable.kind, SessionComponentTable.component_id],
            set: {
              schema_version: definition.version,
              lifetime: definition.lifetime,
              attempt_id: input.attempt?.attemptID ?? null,
              generation: input.attempt?.generation ?? null,
              expires_at: input.expiresAt ?? null,
              value,
              time_updated: now,
            },
          })
          .run()
          .pipe(Effect.orDie)
        return (yield* get({
          sessionID: input.sessionID,
          kind: definition.kind,
          ...(input.id === undefined ? {} : { id: input.id }),
          ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
          now,
        }))!
      })

      const remove = Effect.fn("SessionComponent.remove")(function* (input: Omit<ReadInput, "attempt" | "now">) {
        const definition = yield* definitionOf(input.kind)
        const componentID = yield* storedID(definition, input.id)
        const removed = yield* db
          .delete(SessionComponentTable)
          .where(
            and(
              eq(SessionComponentTable.session_id, input.sessionID),
              eq(SessionComponentTable.kind, definition.kind),
              eq(SessionComponentTable.component_id, componentID),
            ),
          )
          .returning({ componentID: SessionComponentTable.component_id })
          .all()
          .pipe(Effect.orDie)
        return removed.length > 0
      })

      return Service.of({
        registerTool: (definition) => {
          const problem = definitionProblem(definition, "tool")
          if (problem) return Effect.fail(new RegistryError({ message: problem }))
          if (definitions.has(definition.kind))
            return Effect.fail(new RegistryError({ message: `Duplicate session component kind: ${definition.kind}` }))
          definitions.set(definition.kind, definition)
          return Effect.void
        },
        definitions: () => Array.from(definitions.values(), infoOf).sort((a, b) => a.kind.localeCompare(b.kind)),
        get,
        list,
        put,
        remove,
      })
    }),
  )

export const layer = layerWith()
export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
