export * as SessionComponentRegistry from "./component-registry"

import { and, asc, eq } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { CatalogStore } from "../catalog-store"
import { EventV2 } from "../event"
import { Model } from "@novaclaw/schema/model"
import { ProjectV2 } from "../project"
import { SessionStrict } from "@novaclaw/schema/session-strict"
import { SessionType } from "@novaclaw/schema/session-type"
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
  "model",
  "agent",
  "session_type",
  "responder",
  "strict",
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
  /**
   * 🔴 The same authority question asked of a REMOVAL, and it needs its own hook because
   * `validateWrite` takes a decoded value and a removal has none.
   *
   * Without this, making a system-owned component removable would hand an agent the exact move its
   * write gate refuses: clearing `responder` undoes a human's takeover, and clearing `session_type`
   * changes attendance. A gate on one door only is not a gate.
   */
  readonly validateRemove?: (input: { readonly id?: string; readonly system: boolean }) => Effect.Effect<void, unknown>
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

export interface ReplaceSetInput {
  readonly sessionID: SessionSchema.ID
  readonly kind: string
  readonly items: ReadonlyArray<{ readonly id: string; readonly value: unknown }>
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
  /** Validate an ordinary removal without mutating, so a hard authority refusal precedes permission policy. */
  readonly validateRemoval: (input: {
    readonly sessionID: SessionSchema.ID
    readonly kind: string
    readonly id?: string
  }) => Effect.Effect<void, ComponentError>
  readonly get: (input: ReadInput) => Effect.Effect<Entry | undefined, ComponentError>
  readonly list: (input: Omit<ReadInput, "id">) => Effect.Effect<ReadonlyArray<Entry>, ComponentError>
  readonly put: (input: PutInput) => Effect.Effect<Entry, ComponentError>
  /**
   * Replace every row of a SET kind for one session, in one transaction, with each item validated
   * exactly as {@link put} validates it (excess-property decode, `validateWrite`, lifetime).
   *
   * ⚠️ This is the door the two kernel plan writers (`session/todo.ts`, `session/plan.ts`) used to
   * walk around with a raw `DELETE … kind = 'plan'` + `INSERT`, so nothing above ran for them: a
   * `PlanStep` gaining a required field would have kept both compiling and produced rows
   * `decodeStored` refuses at the READ, far from the writer. Projected kinds have no set to replace.
   */
  readonly replaceSet: (input: ReplaceSetInput) => Effect.Effect<void, ComponentError>
  /**
   * `system` claims kernel authority, exactly as `put` does — and it defaults to FALSE, so the
   * agent-facing component tool (which passes no flag) cannot clear a system-owned component.
   */
  readonly remove: (
    input: Omit<ReadInput, "attempt" | "now"> & { readonly system?: boolean },
  ) => Effect.Effect<boolean, ComponentError>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionComponentRegistry") {}

const SINGLETON_ID = ""
const kernelNames = new Set<string>(KERNEL_KIND_NAMES)

export const toolKind = (owner: string, name: string): ToolKind =>
  Schema.decodeUnknownSync(ToolKind)(`tool/${owner}/${name}`)

export const kernelDefinition = <A>(input: Omit<Definition<A>, "owner"> & { readonly kind: KernelKind }) =>
  ({ ...input, owner: "kernel" }) satisfies Definition<A>

/**
 * The composer's Tuning panel as one component value.
 *
 * ⚠️ Every key is OPTIONAL and absent means INHERIT, never "off" — the same tri-state the columns
 * carry (`session-feature.ts`). A struct that required all ten would turn "I have not decided" into
 * "I decided no" for nine of them the first time an agent wrote one.
 *
 * ⚠️ The key set is re-typed here rather than generated from `SessionFeature.Name`, because Drizzle
 * needs real column objects and the schema needs literal keys to stay precisely typed. That makes it
 * a THIRD copy of the list, so `session-tuning-component.test.ts` pins all three against each other.
 */
export const Tuning = Schema.Struct({
  introspection: Schema.optional(Schema.Boolean),
  quality: Schema.optional(Schema.Boolean),
  affective: Schema.optional(Schema.Boolean),
  thinkingBudget: Schema.optional(Schema.Boolean),
  surgicalEdits: Schema.optional(Schema.Boolean),
  askBeforeChanges: Schema.optional(Schema.Boolean),
  safeMode: Schema.optional(Schema.Boolean),
  contextBudget: Schema.optional(Schema.Boolean),
  memory: Schema.optional(Schema.Boolean),
  shortChat: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "SessionComponent.Tuning" })
export type Tuning = typeof Tuning.Type

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

    /**
     * A WRITE decodes strictly: an unknown key is refused, not dropped.
     *
     * 🔴 **Without this the registry answers success for a write that vanished.** Effect Schema's
     * default is `onExcessProperty: "ignore"`, so `{introspction: true}` — one transposed letter —
     * decoded to `{}`, stored `{}`, and returned an `Entry` the caller read as confirmation. Every
     * struct-codec component had this: `tuning` (ten switches an agent sets by name), `observation`,
     * `goal`, `plan`, and every component a tool registers. The agent's next read shows the old
     * value, which reads as "the instance is broken" rather than "I typed it wrong" — the same loop
     * the self-healing law's unrouted-config-key defect produced (`config-store-write.ts`).
     *
     * ⚠️ Deliberately NOT applied to `projectedEntry`'s read path. That value came out of a
     * kernel-owned store through the definition's own projection, so an excess key there would be a
     * kernel bug, and failing a READ is how a session becomes unopenable. Refusing bad input and
     * refusing to show existing state are different promises; only the first is this one.
     *
     * ⚠️ It also refuses a key a NEWER build would understand. That is the right direction for a
     * write — silently discarding half of what an agent asked for is worse than telling it the field
     * is unknown — and it is the opposite of `ProjectFile.parse`'s deliberate leniency, which exists
     * so an older build can READ a newer file.
     */
    const decodeWrite = (definition: AnyDefinition, value: unknown) =>
      Schema.decodeUnknownEffect(definition.codec, { errors: "all", onExcessProperty: "error" })(value).pipe(
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
      const decoded = yield* decodeWrite(definition, input.value)
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

    const validateRemoval = Effect.fn("SessionComponent.validateRemoval")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly kind: string
      readonly id?: string
    }) {
      const definition = yield* definitionOf(input.kind)
      yield* storedID(definition, input.id)
      if (definition.removable === false)
        return yield* new RegistryError({ message: `${definition.kind} cannot be removed` })
      if (definition.validateRemove)
        yield* definition
          .validateRemove({ ...(input.id === undefined ? {} : { id: input.id }), system: false })
          .pipe(Effect.mapError((cause) => projectionFailure(definition, "Validating removal of", cause)))
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
      const decoded = yield* decodeWrite(definition, input.value)
      if (definition.validateWrite)
        yield* definition
          .validateWrite({ id: input.id, value: decoded, system: input.system === true })
          .pipe(Effect.mapError((cause) => projectionFailure(definition, "Writing", cause)))
      // 🔴 The projection's own check runs HERE too, not only in `validate`. It used to run only
      // there, which made it a courtesy for the dry-run path rather than a rule: a caller that went
      // straight to `put` skipped it entirely. `working_folder` was safe only because its `put`
      // re-ran the identical resolution by hand — i.e. the guarantee was upheld by a duplicate that
      // the next projection to declare a `validate` would not have known to copy, and `model`'s
      // catalog check is exactly that next one.
      if (definition.projection?.validate)
        yield* definition.projection
          .validate(input.sessionID, decoded)
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

    const replaceSet = Effect.fn("SessionComponent.replaceSet")(function* (input: ReplaceSetInput) {
      const definition = yield* definitionOf(input.kind)
      if (definition.cardinality !== "set")
        return yield* new RegistryError({ message: `${definition.kind} is not a set; use put` })
      if (definition.projection)
        return yield* new RegistryError({ message: `${definition.kind} is projected; it has no set to replace` })
      // Validate EVERYTHING before writing ANYTHING: a refusal that half-replaced the set would be
      // worse than the raw SQL this replaces.
      const rows: Array<{ componentID: string; value: Schema.Json }> = []
      for (const item of input.items) {
        const componentID = yield* storedID(definition, item.id)
        const put: PutInput = { sessionID: input.sessionID, kind: input.kind, id: item.id, value: item.value }
        yield* assertLifetime(definition, put)
        const decoded = yield* decodeWrite(definition, item.value)
        if (definition.validateWrite)
          yield* definition
            .validateWrite({ id: item.id, value: decoded, system: input.system === true })
            .pipe(Effect.mapError((cause) => projectionFailure(definition, "Writing", cause)))
        rows.push({ componentID, value: yield* encodeInput(definition, decoded) })
      }
      const now = Date.now()
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .delete(SessionComponentTable)
              .where(
                and(
                  eq(SessionComponentTable.session_id, input.sessionID),
                  eq(SessionComponentTable.kind, definition.kind),
                ),
              )
              .run()
            if (rows.length === 0) return
            yield* tx
              .insert(SessionComponentTable)
              .values(
                rows.map((row) => ({
                  session_id: input.sessionID,
                  kind: definition.kind,
                  component_id: row.componentID,
                  schema_version: definition.version,
                  lifetime: definition.lifetime,
                  value: row.value,
                  time_created: now,
                  time_updated: now,
                })),
              )
              .run()
          }),
        )
        .pipe(Effect.orDie)
    })

    const remove = Effect.fn("SessionComponent.remove")(function* (
      input: Omit<ReadInput, "attempt" | "now"> & { readonly system?: boolean },
    ) {
      const definition = yield* definitionOf(input.kind)
      const componentID = yield* storedID(definition, input.id)
      if (definition.removable === false)
        return yield* new RegistryError({ message: `${definition.kind} cannot be removed` })
      // ⚠️ Defaults to NOT system, matching `put`. The agent-facing component tool passes no flag,
      // so a kind that gates removal refuses it unless a caller deliberately claims authority.
      if (definition.validateRemove)
        yield* definition
          .validateRemove({ ...(input.id === undefined ? {} : { id: input.id }), system: input.system === true })
          .pipe(Effect.mapError((cause) => projectionFailure(definition, "Removing", cause)))
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
      // ⚠️ AN OPEN DOOR NOBODY HAS WALKED THROUGH (2026-09-03). This is the third-party half
      // of the component tier — the answer to "a tool cannot attach state" — and it has NO production
      // caller: `tool/define-tool.ts` and `adhoc-tools/` declare no component, no route exposes a
      // generic component surface, and the only walkers are `test/fixtures/session-component-worker.ts`
      // and the registry's own test. So the door is landed and unproven, and the status is stated here
      // rather than implied by a green test. The bar before a stranger relies on it: wire ONE real
      // tool through it end to end. Until then, do not build on it as if it were exercised.
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
      validateRemoval,
      get,
      list,
      put,
      replaceSet,
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
  // The catalog the `model` component resolves THROUGH. Validating on write is what makes "resolves
  // through the catalog" a property of the component rather than a note in a ledger.
  //
  // ⚠️ `agent` gets NO such check, and the reason is structural rather than an oversight: the agent
  // registry is a LOCATION-scoped service and this registry is a GLOBAL node, so it cannot hold one
  // without either duplicating the registry per location or making the whole component surface
  // location-scoped. The runner's `agents.select` already falls back to the default agent for an
  // unknown name, so an unrecognised value degrades rather than breaking the chat.
  const catalog = yield* CatalogStore.Service
  const current = (sessionID: SessionSchema.ID) =>
    db
      .select({
        override: SessionTable.system_prompt_override,
        device: SessionTable.device,
        priority: SessionTable.priority,
        controlBinding: SessionTable.control_binding,
        directory: SessionTable.directory,
        parentID: SessionTable.parent_id,
        model: SessionTable.model,
        agent: SessionTable.agent,
        sessionType: SessionTable.type,
        responder: SessionTable.responder,
        strict: SessionTable.strict,
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
  // The ten Tuning columns, keyed by feature name. Drizzle needs the column objects themselves, so
  // this cannot be derived from the descriptor; `session-tuning-component.test.ts` pins it.
  const TUNING_COLUMNS = {
    introspection: SessionTable.introspection,
    quality: SessionTable.quality,
    affective: SessionTable.affective,
    thinkingBudget: SessionTable.thinking_budget,
    surgicalEdits: SessionTable.surgical_edits,
    askBeforeChanges: SessionTable.ask_before_changes,
    safeMode: SessionTable.safe_mode,
    contextBudget: SessionTable.context_budget,
    memory: SessionTable.memory,
    shortChat: SessionTable.short_chat,
  } as const
  const TUNING_NAMES = Object.keys(TUNING_COLUMNS) as (keyof typeof TUNING_COLUMNS)[]

  const currentTuning = (sessionID: SessionSchema.ID) =>
    db.select(TUNING_COLUMNS).from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)

  const publishFeature = (
    sessionID: SessionSchema.ID,
    feature: (typeof TUNING_NAMES)[number],
    enabled: boolean | null,
  ) =>
    events.publish(SessionEvent.FeatureSwitched, {
      sessionID,
      messageID: SessionMessage.ID.create(),
      timestamp: DateTime.nowUnsafe(),
      feature,
      enabled,
    })

  const publishModel = (sessionID: SessionSchema.ID, model: Model.Ref | null) =>
    events.publish(SessionEvent.ModelSwitched, {
      sessionID,
      messageID: SessionMessage.ID.create(),
      timestamp: DateTime.nowUnsafe(),
      model,
    })
  const publishAgent = (sessionID: SessionSchema.ID, agent: string | null) =>
    events.publish(SessionEvent.AgentSwitched, {
      sessionID,
      messageID: SessionMessage.ID.create(),
      timestamp: DateTime.nowUnsafe(),
      agent,
    })
  const publishType = (sessionID: SessionSchema.ID, sessionType: SessionType.Info | null) =>
    events.publish(SessionEvent.TypeSwitched, {
      sessionID,
      messageID: SessionMessage.ID.create(),
      timestamp: DateTime.nowUnsafe(),
      sessionType,
    })
  const publishResponder = (sessionID: SessionSchema.ID, responder: "nova" | "operator" | null) =>
    events.publish(SessionEvent.ResponderSwitched, {
      sessionID,
      messageID: SessionMessage.ID.create(),
      timestamp: DateTime.nowUnsafe(),
      responder,
    })
  const publishStrict = (sessionID: SessionSchema.ID, strict: SessionStrict.Override | null) =>
    events.publish(SessionEvent.StrictSwitched, {
      sessionID,
      messageID: SessionMessage.ID.create(),
      timestamp: DateTime.nowUnsafe(),
      strict,
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
        "A real Device placement for this session. The selected Device must serve the resolved model; an unknown or incompatible pin refuses the turn before provider dispatch. Remove to restore automatic placement.",
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
      kind: "tuning",
      description:
        "This chat's harness-helper switches — the composer's Tuning panel. Each is a tri-state: true or " +
        "false is this chat's explicit stance, and an absent key INHERITS (the parent chain, then the " +
        "matching global block). Writing replaces the whole set, so a key you leave out returns to inherit; " +
        "remove returns every switch to inherit at once.",
      cardinality: "singleton",
      lifetime: "entity",
      version: 1,
      codec: Tuning,
      removable: true,
      projection: {
        // Absent rather than `{}` when nothing is set: "this chat takes no stance" is the same
        // answer as having no component, and two spellings of it would make callers test for both.
        get: (sessionID) =>
          currentTuning(sessionID).pipe(
            Effect.map((row) => {
              if (row === undefined) return undefined
              const value: Record<string, boolean> = {}
              for (const name of TUNING_NAMES) {
                const held = row[name]
                if (held !== null && held !== undefined) value[name] = held
              }
              return Object.keys(value).length === 0 ? undefined : (value as Tuning)
            }),
          ),
        put: (sessionID, value) =>
          Effect.gen(function* () {
            const row = yield* currentTuning(sessionID)
            if (row === undefined) return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
            // One event per CHANGED switch, not one per key: the projector writes a column per
            // event, and re-publishing an unchanged value would put a no-op in the transcript that
            // reads as the user having flipped something.
            for (const name of TUNING_NAMES) {
              const desired = value[name] ?? null
              if ((row[name] ?? null) === desired) continue
              yield* publishFeature(sessionID, name, desired)
            }
            return undefined
          }),
        remove: (sessionID) =>
          Effect.gen(function* () {
            const row = yield* currentTuning(sessionID)
            if (row === undefined) return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
            let cleared = false
            for (const name of TUNING_NAMES) {
              if ((row[name] ?? null) === null) continue
              yield* publishFeature(sessionID, name, null)
              cleared = true
            }
            return cleared
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
        "The controlled surface. Use `x11-sandbox:<encoded-display>` for an isolated display. A real desktop requires an exact app grant: `x11-window:<encoded-display>:<window-id>:<pid>:<encoded-WM_CLASS>` or `windows-window:<HWND>:<pid>:<encoded-executable>`. A plain display is never accepted. Descendants inherit it; remove to fall back to the sandbox-only instance default.",
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
    kernelDefinition({
      kind: "model",
      description:
        "The model answering this session. Descendants inherit it unless they override. It is validated against the catalog, so a model that is not served cannot be set.",
      cardinality: "singleton",
      lifetime: "entity",
      version: 1,
      codec: Model.Ref,
      // Clearable since 2026-08-14: `ModelSwitched.model` is nullable, so the kernel has an event
      // meaning "go back to inheriting". No migration was needed — `session.model` was always a
      // nullable column, because a session that never overrode the model has exactly this state.
      removable: true,
      projection: {
        // The column is a plain JSON object; `Model.Ref` is branded. The codec re-decodes it either
        // way, so the cast is at the boundary where the shapes are known to match rather than spread
        // across the projection.
        get: (sessionID) =>
          current(sessionID).pipe(Effect.map((row) => (row?.model ?? undefined) as Model.Ref | undefined)),
        // The catalog is the registry this field resolves through, so "does this model exist" is
        // answered HERE rather than at the next turn, where an unservable ref surfaces as a provider
        // error the user has no way to connect back to the write that caused it.
        validate: (_sessionID, value) =>
          Effect.gen(function* () {
            const stored = yield* catalog.providers()
            const layers = stored[value.providerID]
            // ⚠️ ANY layer, not the merged view: a model added by a later layer is servable, and
            // re-implementing the merge here would be a second copy of the catalog's own algebra.
            if (!layers?.some((layer) => layer.models?.[value.id] !== undefined))
              return yield* Effect.fail(
                new Error(`No model ${value.providerID}/${value.id} in this instance's catalog`),
              )
          }),
        put: (sessionID, value) =>
          Effect.gen(function* () {
            const row = yield* current(sessionID)
            if (row === undefined) return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
            const same =
              row.model?.id === value.id &&
              row.model?.providerID === value.providerID &&
              (row.model?.variant ?? undefined) === value.variant
            if (!same) yield* publishModel(sessionID, value)
            return undefined
          }),
        remove: (sessionID) =>
          Effect.gen(function* () {
            const row = yield* current(sessionID)
            if (row === undefined) return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
            // `false` = nothing to clear, which is not a failure: the session already inherits.
            if (row.model === null || row.model === undefined) return false
            yield* publishModel(sessionID, null)
            return true
          }),
      },
    }),
    kernelDefinition({
      kind: "agent",
      description:
        "The agent identity driving this session — its base prompt, tools and permissions. READ-ONLY to an agent: only the host may change identity, and a root chat must always keep an owner. Descendants inherit it unless they override.",
      cardinality: "singleton",
      lifetime: "entity",
      version: 1,
      codec: Schema.NonEmptyString,
      // 🔴 Identity is authority, not a session preference. Permission rules are operator dials and
      // may be widened, so the hard organization-chart boundary must run BEFORE the permission tier:
      // an officer may inspect who it is, but cannot become Nova or impersonate another officer by
      // granting itself `session`/`session_privileged`. Kernel callers use explicit system authority;
      // the model-facing session tool has no such field in its wire schema.
      validateWrite: ({ system }) =>
        system
          ? Effect.void
          : Effect.fail(
              new Error(
                "A session's agent identity is assigned by the host, not by the agent: changing it could widen organization authority or expose another colleague's private context.",
              ),
            ),
      // Clearing reaches the same escalation through inheritance, so the second door carries the
      // same hard gate. Root removal has an additional invariant in the projection below: even a
      // kernel caller cannot make a root ownerless through this low-level component operation.
      validateRemove: ({ system }) =>
        system
          ? Effect.void
          : Effect.fail(
              new Error(
                "A session's agent identity is assigned by the host, not by the agent: clearing it could erase the chat's owner or inherit a different identity.",
              ),
            ),
      removable: true,
      projection: {
        get: (sessionID) => current(sessionID).pipe(Effect.map((row) => row?.agent ?? undefined)),
        put: (sessionID, value) =>
          Effect.gen(function* () {
            const row = yield* current(sessionID)
            if (row === undefined) return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
            if (row.agent !== value) yield* publishAgent(sessionID, value)
            return undefined
          }),
        remove: (sessionID) =>
          Effect.gen(function* () {
            const row = yield* current(sessionID)
            if (row === undefined) return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
            if (row.parentID === null || row.parentID === undefined)
              return yield* Effect.fail(new Error("A root session must keep its agent owner"))
            if (row.agent === null || row.agent === undefined) return false
            yield* publishAgent(sessionID, null)
            return true
          }),
      },
    }),
    kernelDefinition({
      kind: "session_type",
      description:
        "This chat's kernel thread type — interactive, sub-agent, auto-prompting or goal-oriented. READ-ONLY to an agent: it is set by the person driving the chat.",
      cardinality: "singleton",
      lifetime: "entity",
      version: 1,
      codec: SessionType.Info,
      removable: true,
      // 🔴 SYSTEM-ONLY, and this is a security decision rather than a missing feature. Attendance
      // derives from the chain ROOT's type (`rootAttendance`, agent-jail doctrine): an UNATTENDED
      // root has out-of-folder writes DENIED outright and its bash confined, because nobody is there
      // to answer an ask. An agent that could write its own type would declare itself `interactive`
      // and walk straight out of that stance — the escalation the whole unattended arm exists to
      // prevent. Exposed for READING because "what kind of thread am I" is a legitimate question and
      // answering it costs nothing; the composer's Mode control remains how a HUMAN changes it.
      validateWrite: ({ system }) =>
        system
          ? Effect.void
          : Effect.fail(
              new Error(
                "A session's type is set by the person driving the chat, not by the agent: declaring yourself attended would lift the unattended confinement stance.",
              ),
            ),
      // 🔴 The SAME ruling on the other door. Clearing is not a neutral act here: a root chat's type
      // IS its attendance, so an agent clearing it would drop an unattended designation back to the
      // inherited default and lift its own confinement — the write gate's escalation, reached by
      // removal instead. Reading stays free; changing it stays the human's.
      validateRemove: ({ system }) =>
        system
          ? Effect.void
          : Effect.fail(
              new Error(
                "A session's type is set by the person driving the chat, not by the agent: clearing it would lift the unattended confinement stance.",
              ),
            ),
      projection: {
        get: (sessionID) => current(sessionID).pipe(Effect.map((row) => row?.sessionType ?? undefined)),
        put: (sessionID, value) =>
          Effect.gen(function* () {
            const row = yield* current(sessionID)
            if (row === undefined) return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
            if (row.sessionType !== value) yield* publishType(sessionID, value)
            return undefined
          }),
        remove: (sessionID) =>
          Effect.gen(function* () {
            const row = yield* current(sessionID)
            if (row === undefined) return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
            if (row.sessionType === null || row.sessionType === undefined) return false
            yield* publishType(sessionID, null)
            return true
          }),
      },
    }),
    kernelDefinition({
      kind: "responder",
      description:
        'Who answers on our side of this chat: "nova" (the agent) or "operator" (a human has taken over, so the agent stops auto-responding). An agent may hand control to a human; only a human hands it back.',
      cardinality: "singleton",
      lifetime: "entity",
      version: 1,
      codec: Schema.Literals(["nova", "operator"]),
      // Clearable since 2026-08-14: `ResponderSwitched.responder` is nullable. The one-way ruling
      // below governs WHO may clear it.
      removable: true,
      // 🔴 ONE-WAY for an agent, mirroring the narrowing keystone on `permissionMode`. Standing down
      // is always allowed — an agent deciding a human should take this conversation is the product
      // working. Taking control BACK is not the agent's to decide: a human took over for a reason,
      // and an agent that could set `nova` would overrule them silently, on their own account.
      validateWrite: ({ value, system }) =>
        system || value === "operator"
          ? Effect.void
          : Effect.fail(
              new Error(
                "A human has taken over this chat. You can hand control to a person, but only a person hands it back.",
              ),
            ),
      // 🔴 Removal is the same move as writing `nova`, because clearing falls back to the inherited
      // default — which is the agent answering. An agent allowed to clear this would take control
      // back from the human by another name, so the one-way rule has to hold on both doors.
      validateRemove: ({ system }) =>
        system
          ? Effect.void
          : Effect.fail(
              new Error(
                "A human has taken over this chat. You can hand control to a person, but only a person hands it back.",
              ),
            ),
      projection: {
        get: (sessionID) => current(sessionID).pipe(Effect.map((row) => row?.responder ?? undefined)),
        put: (sessionID, value) =>
          Effect.gen(function* () {
            const row = yield* current(sessionID)
            if (row === undefined) return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
            if (row.responder !== value) yield* publishResponder(sessionID, value)
            return undefined
          }),
        remove: (sessionID) =>
          Effect.gen(function* () {
            const row = yield* current(sessionID)
            if (row === undefined) return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
            if (row.responder === null || row.responder === undefined) return false
            yield* publishResponder(sessionID, null)
            return true
          }),
      },
    }),
    kernelDefinition({
      kind: "strict",
      description:
        "This chat's Strict-harness override: whether the deterministic step-tree engine drives the turn, and its attempt/wall-clock bounds. Remove to inherit the parent chain, then the instance setting.",
      cardinality: "singleton",
      lifetime: "entity",
      version: 1,
      codec: SessionStrict.Override,
      // The one of the five that CAN be cleared: `StrictSwitched.strict` is nullable, so the kernel
      // already has an event meaning "back to inherit".
      removable: true,
      projection: {
        get: (sessionID) => current(sessionID).pipe(Effect.map((row) => row?.strict ?? undefined)),
        put: (sessionID, value) =>
          Effect.gen(function* () {
            const row = yield* current(sessionID)
            if (row === undefined) return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
            yield* publishStrict(sessionID, value)
            return undefined
          }),
        remove: (sessionID) =>
          Effect.gen(function* () {
            const row = yield* current(sessionID)
            if (row === undefined) return yield* Effect.fail(new Error(`Session not found: ${sessionID}`))
            if (row.strict === null) return false
            yield* publishStrict(sessionID, null)
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
  deps: [Database.node, EventV2.node, ProjectV2.node, CatalogStore.node],
})
