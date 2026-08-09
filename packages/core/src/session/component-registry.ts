export * as SessionComponentRegistry from "./component-registry"

import { and, asc, eq } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { ProjectV2 } from "../project"
import { AbsolutePath, NonNegativeInt, PositiveInt, RelativePath } from "../schema"
import path from "node:path"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionComponentTable, SessionTable } from "./sql"
import { SessionLocationRecovery } from "./location-recovery"

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
  "missing_working_folder",
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

export const Observation = Schema.Struct({
  handle: Schema.NonEmptyString,
  capturedAt: NonNegativeInt,
  digest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  region: Schema.NullOr(
    Schema.Struct({
      x: NonNegativeInt,
      y: NonNegativeInt,
      width: PositiveInt,
      height: PositiveInt,
    }),
  ),
}).annotate({ identifier: "SessionComponent.Observation" })
export type Observation = typeof Observation.Type

export const Goal = Schema.Struct({
  text: Schema.NonEmptyString,
}).annotate({ identifier: "SessionComponent.Goal" })
export type Goal = typeof Goal.Type

export const PlanVerdict = Schema.Struct({
  check: Schema.NonEmptyString,
  passedAt: NonNegativeInt,
  evidence: Schema.NonEmptyString,
}).annotate({ identifier: "SessionComponent.PlanVerdict" })
export type PlanVerdict = typeof PlanVerdict.Type

export const PlanStep = Schema.Struct({
  position: NonNegativeInt,
  text: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
  priority: Schema.optional(Schema.NonEmptyString),
  verdict: Schema.NullOr(PlanVerdict),
}).annotate({ identifier: "SessionComponent.PlanStep" })
export type PlanStep = typeof PlanStep.Type

export const planComponentID = (position: number) => `step-${String(position).padStart(8, "0")}`

/** Adapter for a component whose canonical bytes already live in a kernel-owned store. */
export interface Projection<A> {
  readonly validate?: (sessionID: SessionSchema.ID, value: A) => Effect.Effect<void, unknown>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<A | undefined, unknown>
  readonly put: (sessionID: SessionSchema.ID, value: A) => Effect.Effect<void, unknown>
  readonly remove?: (sessionID: SessionSchema.ID) => Effect.Effect<boolean, unknown>
}

export interface Definition<A = any> {
  readonly kind: KernelKind | ToolKind
  readonly owner: "kernel" | `tool/${string}`
  readonly description: string
  readonly cardinality: Cardinality
  readonly lifetime: Lifetime
  readonly version: number
  readonly codec: Schema.Codec<A, Schema.Json>
  readonly removable?: boolean
  readonly projection?: Projection<A>
  /** System-owned fields (for example a mechanical verification verdict) may reject ordinary writes. */
  readonly validateWrite?: (input: {
    readonly id?: string
    readonly value: A
    readonly system: boolean
  }) => Effect.Effect<void, unknown>
  /** Decode an older stored version into the current typed value. Absence makes drift explicit. */
  readonly migrate?: (input: { readonly version: number; readonly value: Schema.Json }) => Effect.Effect<A>
}
type AnyDefinition = Definition

export interface DefinitionInfo {
  readonly kind: string
  readonly owner: string
  readonly description: string
  readonly cardinality: Cardinality
  readonly lifetime: Lifetime
  readonly version: number
  readonly removable: boolean
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
  /** Kernel-only authority. This is deliberately absent from the session tool's wire schema. */
  readonly system?: true
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
  readonly validate: (input: {
    sessionID: SessionSchema.ID
    kind: string
    id?: string
    value: unknown
  }) => Effect.Effect<Schema.Json, ComponentError>
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

export const ObservationDefinition = kernelDefinition({
  kind: "observation",
  description:
    "The latest screen frame sampled during this execution attempt: its local handle, capture time, SHA-256 digest, and exact covered region. A null region means the whole bound display.",
  cardinality: "singleton",
  lifetime: "attempt",
  version: 1,
  codec: Observation,
})

export const GoalDefinition = kernelDefinition({
  kind: "goal",
  description: "The session's durable objective. It survives transcript compaction and steers goal-oriented work.",
  cardinality: "singleton",
  lifetime: "entity",
  version: 1,
  codec: Goal,
})

export const PlanDefinition = kernelDefinition({
  kind: "plan",
  description:
    "One ordered step in the session's shallow execution plan. A non-null verdict is written only by the kernel after running its named check.",
  cardinality: "set",
  lifetime: "entity",
  version: 1,
  codec: PlanStep,
  validateWrite: ({ id, value, system }) => {
    if (id !== planComponentID(value.position))
      return Effect.fail(new Error(`Plan step ${value.position} must use id ${planComponentID(value.position)}`))
    return value.verdict === null || system
      ? Effect.void
      : Effect.fail(new Error("Plan verdicts are kernel-owned; run the check instead of declaring it passed"))
  },
})

export const toolDefinition = <A>(
  owner: string,
  input: Omit<Definition<A>, "kind" | "owner"> & { readonly name: string },
) => {
  const { name, ...definition } = input
  return { ...definition, kind: toolKind(owner, name), owner: `tool/${owner}` } satisfies Definition<A>
}

const infoOf = (definition: AnyDefinition): DefinitionInfo => ({
  kind: definition.kind,
  owner: definition.owner,
  description: definition.description,
  cardinality: definition.cardinality,
  lifetime: definition.lifetime,
  version: definition.version,
  removable: definition.removable !== false,
  schema: Schema.toJsonSchemaDocument(definition.codec),
})

const storedID = (definition: AnyDefinition, id: string | undefined): Effect.Effect<string, RegistryError> => {
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

const assertLifetime = (definition: AnyDefinition, input: PutInput): Effect.Effect<void, RegistryError> => {
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

const definitionProblem = (definition: AnyDefinition, expectedOwner: "kernel" | "tool"): string | undefined => {
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
  if (definition.projection && (definition.cardinality !== "singleton" || definition.lifetime !== "entity"))
    return `Projected component ${definition.kind} must be an entity-lifetime singleton`
  try {
    Schema.toJsonSchemaDocument(definition.codec)
  } catch (cause) {
    return `Component schema cannot be rendered for introspection: ${String(cause)}`
  }
  return undefined
}

export const make = (kernelDefinitions: ReadonlyArray<AnyDefinition> = []) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const definitions = new Map<string, AnyDefinition>()

    for (const definition of kernelDefinitions) {
      const problem = definitionProblem(definition, "kernel")
      if (problem) return yield* Effect.die(new Error(problem))
      if (definitions.has(definition.kind))
        return yield* Effect.die(new Error(`Duplicate compiled session component kind: ${definition.kind}`))
      definitions.set(definition.kind, definition)
    }

    const definitionOf = (kind: string): Effect.Effect<AnyDefinition, UnknownKindError> => {
      const definition = definitions.get(kind)
      return definition ? Effect.succeed(definition) : Effect.fail(new UnknownKindError({ kind }))
    }

    const projectionFailure = (definition: AnyDefinition, operation: string, cause: unknown) =>
      new RegistryError({
        message: `${operation} ${definition.kind} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      })

    const decodeInput = (definition: AnyDefinition, value: unknown) =>
      Schema.decodeUnknownEffect(definition.codec)(value).pipe(
        Effect.mapError((cause) => new InvalidValueError({ kind: definition.kind, message: String(cause) })),
      )

    const encodeInput = (definition: AnyDefinition, value: unknown) =>
      Schema.encodeEffect(definition.codec)(value).pipe(
        Effect.mapError((cause) => new InvalidValueError({ kind: definition.kind, message: String(cause) })),
      )

    const validate = Effect.fn("SessionComponent.validate")(function* (input: {
      sessionID: SessionSchema.ID
      kind: string
      id?: string
      value: unknown
    }) {
      const definition = yield* definitionOf(input.kind)
      const decoded = yield* decodeInput(definition, input.value)
      if (definition.validateWrite)
        yield* definition
          .validateWrite({ id: input.id, value: decoded, system: false })
          .pipe(Effect.mapError((cause) => projectionFailure(definition, "Validating", cause)))
      if (definition.projection?.validate)
        yield* definition.projection
          .validate(input.sessionID, decoded)
          .pipe(Effect.mapError((cause) => projectionFailure(definition, "Validating", cause)))
      return yield* encodeInput(definition, decoded)
    })

    const projectedEntry = Effect.fn("SessionComponent.projectedEntry")(function* (
      definition: AnyDefinition,
      sessionID: SessionSchema.ID,
      value: unknown,
    ) {
      const decoded = yield* decodeInput(definition, value)
      return {
        sessionID,
        kind: definition.kind,
        value: yield* encodeInput(definition, decoded),
        version: definition.version,
        lifetime: definition.lifetime,
        stale: false,
      } satisfies Entry
    })

    const decodeStored = Effect.fn("SessionComponent.decodeStored")(function* (
      definition: AnyDefinition,
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
      definition: AnyDefinition,
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
      if (definition.projection) {
        const value = yield* definition.projection
          .get(input.sessionID)
          .pipe(Effect.mapError((cause) => projectionFailure(definition, "Reading", cause)))
        return value === undefined ? undefined : yield* projectedEntry(definition, input.sessionID, value)
      }
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
      if (definition.projection) {
        const entry = yield* get(input)
        return entry === undefined ? [] : [entry]
      }
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
      const decoded = yield* decodeInput(definition, input.value)
      if (definition.validateWrite)
        yield* definition
          .validateWrite({ id: input.id, value: decoded, system: input.system === true })
          .pipe(Effect.mapError((cause) => projectionFailure(definition, "Writing", cause)))
      const value = yield* encodeInput(definition, decoded)
      if (definition.projection) {
        yield* definition.projection
          .put(input.sessionID, decoded)
          .pipe(Effect.mapError((cause) => projectionFailure(definition, "Writing", cause)))
        return yield* projectedEntry(definition, input.sessionID, decoded)
      }
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
      if (definition.removable === false)
        return yield* new RegistryError({ message: `${definition.kind} cannot be removed` })
      if (definition.projection) {
        if (!definition.projection.remove)
          return yield* new RegistryError({ message: `${definition.kind} has no removal adapter` })
        return yield* definition.projection
          .remove(input.sessionID)
          .pipe(Effect.mapError((cause) => projectionFailure(definition, "Removing", cause)))
      }
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
      validate,
      get,
      list,
      put,
      remove,
    })
  })

export const layerWith = (kernelDefinitions: ReadonlyArray<AnyDefinition> = []) =>
  Layer.effect(Service, make(kernelDefinitions))

export const layer = layerWith()
export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

const compiledDefinitions = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const events = yield* EventV2.Service
  const projects = yield* ProjectV2.Service
  const current = (sessionID: SessionSchema.ID) =>
    db
      .select({
        override: SessionTable.system_prompt_override,
        device: SessionTable.device,
        priority: SessionTable.priority,
        controlBinding: SessionTable.control_binding,
        directory: SessionTable.directory,
      })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
  const publish = (sessionID: SessionSchema.ID, override: string | null) =>
    events.publish(SessionEvent.PromptOverrideSwitched, {
      sessionID,
      messageID: SessionMessage.ID.create(),
      timestamp: DateTime.nowUnsafe(),
      override,
    })
  const publishDevice = (sessionID: SessionSchema.ID, device: string | null) =>
    events.publish(SessionEvent.DeviceSwitched, {
      sessionID,
      messageID: SessionMessage.ID.create(),
      timestamp: DateTime.nowUnsafe(),
      device,
    })
  const publishPriority = (sessionID: SessionSchema.ID, priority: number | null) =>
    events.publish(SessionEvent.PrioritySwitched, {
      sessionID,
      messageID: SessionMessage.ID.create(),
      timestamp: DateTime.nowUnsafe(),
      priority,
    })
  const publishControlBinding = (sessionID: SessionSchema.ID, controlBinding: string | null) =>
    events.publish(SessionEvent.ControlBindingSwitched, {
      sessionID,
      messageID: SessionMessage.ID.create(),
      timestamp: DateTime.nowUnsafe(),
      controlBinding,
    })
  const resolveWorkingFolder = (sessionID: SessionSchema.ID, value: string) =>
    Effect.gen(function* () {
      const row = yield* current(sessionID)
      if (row === undefined) return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
      const directory = AbsolutePath.make(value)
      const source = yield* projects.resolve(AbsolutePath.make(row.directory))
      const destination = yield* projects.resolve(directory)
      if (source.id !== destination.id)
        return yield* Effect.fail(
          new Error(`Working folder must stay in project ${source.id}; destination belongs to ${destination.id}`),
        )
      return { row, directory, destination }
    })

  return [
    kernelDefinition({
      kind: "system_prompt_override",
      description:
        "This session's full standing-instruction override. It composes above the immutable base prompt and is inherited by descendants.",
      cardinality: "singleton",
      lifetime: "entity",
      version: 1,
      codec: Schema.String,
      projection: {
        get: (sessionID) => current(sessionID).pipe(Effect.map((row) => row?.override ?? undefined)),
        put: (sessionID, value) =>
          Effect.gen(function* () {
            const row = yield* current(sessionID)
            if (row === undefined) return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
            if (row.override !== value) yield* publish(sessionID, value)
            return undefined
          }),
        remove: (sessionID) =>
          Effect.gen(function* () {
            const row = yield* current(sessionID)
            if (row === undefined) return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
            if (row.override === null) return false
            yield* publish(sessionID, null)
            return true
          }),
      },
    }),
    kernelDefinition({
      kind: "device",
      description:
        "The scheduling device id for this session. It groups capacity; it does not choose which model answers. Remove to inherit.",
      cardinality: "singleton",
      lifetime: "entity",
      version: 1,
      codec: Schema.NonEmptyString,
      projection: {
        get: (sessionID) => current(sessionID).pipe(Effect.map((row) => row?.device ?? undefined)),
        put: (sessionID, value) =>
          Effect.gen(function* () {
            const row = yield* current(sessionID)
            if (row === undefined) return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
            if (row.device !== value) yield* publishDevice(sessionID, value)
            return undefined
          }),
        remove: (sessionID) =>
          Effect.gen(function* () {
            const row = yield* current(sessionID)
            if (row === undefined) return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
            if (row.device === null) return false
            yield* publishDevice(sessionID, null)
            return true
          }),
      },
    }),
    kernelDefinition({
      kind: "priority",
      description:
        "A positive EEVDF scheduling weight for this session. Higher values receive more device share. Remove to inherit.",
      cardinality: "singleton",
      lifetime: "entity",
      version: 1,
      codec: Schema.Finite.check(Schema.isGreaterThan(0)),
      projection: {
        get: (sessionID) => current(sessionID).pipe(Effect.map((row) => row?.priority ?? undefined)),
        put: (sessionID, value) =>
          Effect.gen(function* () {
            const row = yield* current(sessionID)
            if (row === undefined) return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
            if (row.priority !== value) yield* publishPriority(sessionID, value)
            return undefined
          }),
        remove: (sessionID) =>
          Effect.gen(function* () {
            const row = yield* current(sessionID)
            if (row === undefined) return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
            if (row.priority === null) return false
            yield* publishPriority(sessionID, null)
            return true
          }),
      },
    }),
    kernelDefinition({
      kind: "control_binding",
      description:
        "The controlled surface. Use `x11-sandbox:<encoded-display>` for an isolated display. A real desktop requires `x11-window:<encoded-display>:<window-id>:<pid>:<encoded-WM_CLASS>` from a human-selected application; a plain display is never accepted. Descendants inherit it; remove to fall back to the sandbox-only instance default.",
      cardinality: "singleton",
      lifetime: "entity",
      version: 1,
      codec: Schema.NonEmptyString,
      projection: {
        get: (sessionID) => current(sessionID).pipe(Effect.map((row) => row?.controlBinding ?? undefined)),
        put: (sessionID, value) =>
          Effect.gen(function* () {
            const row = yield* current(sessionID)
            if (row === undefined) return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
            if (row.controlBinding !== value) yield* publishControlBinding(sessionID, value)
            return undefined
          }),
        remove: (sessionID) =>
          Effect.gen(function* () {
            const row = yield* current(sessionID)
            if (row === undefined) return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
            if (row.controlBinding === null) return false
            yield* publishControlBinding(sessionID, null)
            return true
          }),
      },
    }),
    GoalDefinition,
    PlanDefinition,
    ObservationDefinition,
    kernelDefinition({
      kind: "missing_working_folder",
      description:
        "The vanished working folder automatic recovery moved this session out of. It remains readable so the original folder can still find the chat, and clears when the session is deliberately moved.",
      cardinality: "singleton",
      lifetime: "entity",
      version: 1,
      codec: AbsolutePath,
      removable: false,
      validateWrite: ({ system }) =>
        system ? Effect.void : Effect.fail(new Error("missing_working_folder is maintained by recovery")),
      projection: {
        get: (sessionID) => SessionLocationRecovery.get(db, sessionID),
        put: (sessionID, value) => SessionLocationRecovery.record(db, sessionID, value),
      },
    }),
    kernelDefinition({
      kind: "working_folder",
      description:
        "The absolute working folder for this session. Moving re-derives project identity and the next turn's permission scope. It cannot be removed.",
      cardinality: "singleton",
      lifetime: "entity",
      version: 1,
      codec: AbsolutePath,
      removable: false,
      projection: {
        get: (sessionID) => current(sessionID).pipe(Effect.map((row) => row?.directory)),
        validate: (sessionID, value) => resolveWorkingFolder(sessionID, value).pipe(Effect.asVoid),
        put: (sessionID, value) =>
          Effect.gen(function* () {
            const { row, directory, destination } = yield* resolveWorkingFolder(sessionID, value)
            if (row.directory === directory) return
            yield* events.publish(SessionEvent.Moved, {
              sessionID,
              location: { directory },
              subdirectory: RelativePath.make(path.relative(destination.directory, directory).replaceAll("\\", "/")),
              timestamp: DateTime.nowUnsafe(),
            })
          }),
      },
    }),
  ]
})

export const kernelLayer = Layer.effect(Service, compiledDefinitions.pipe(Effect.flatMap(make)))
export const node = makeGlobalNode({
  service: Service,
  layer: kernelLayer,
  deps: [Database.node, EventV2.node, ProjectV2.node],
})
