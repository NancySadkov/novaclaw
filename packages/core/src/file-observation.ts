export * as FileObservation from "./file-observation"

import { createHash, randomUUID } from "crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { SessionExecutionAttempt } from "./session/execution-attempt"
import { SessionSchema } from "./session/schema"

export interface Target {
  readonly canonical: string
  readonly resource: string
}

export interface Version {
  readonly digest: string
  readonly totalLength: number
  readonly text: string
}

export interface Coverage {
  readonly start: number
  readonly end: number
  readonly total: number
  readonly full: boolean
}

export interface Token {
  readonly token: string
  readonly coverage: "partial" | "full"
}

interface Record {
  readonly token: string
  readonly sessionID: SessionSchema.ID
  readonly attemptID: string
  readonly generation: number
  readonly canonical: string
  readonly digest: string
  readonly totalLength: number
  readonly createdAt: number
  readonly ranges: ReadonlyArray<readonly [number, number]>
  readonly full: boolean
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("FileObservation.InvalidError", {
  reason: Schema.Literals(["missing", "wrong-attempt", "wrong-session", "wrong-path", "partial"]),
}) {}

export class ChangedDuringReadError extends Schema.TaggedErrorClass<ChangedDuringReadError>()(
  "FileObservation.ChangedDuringReadError",
  { path: Schema.String },
) {}

export interface Interface {
  readonly snapshot: (target: Target) => Effect.Effect<Version, FSUtil.Error>
  readonly record: (input: {
    readonly sessionID: SessionSchema.ID
    readonly target: Target
    readonly version: Version
    readonly coverage: Coverage
  }) => Effect.Effect<Token | undefined>
  readonly validate: (input: {
    readonly token: string | undefined
    readonly sessionID: SessionSchema.ID
    readonly target: Target
  }) => Effect.Effect<string, InvalidError>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/FileObservation") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const records = new Map<string, Record>()
    const keys = new Map<string, string>()

    const snapshot = Effect.fn("FileObservation.snapshot")(function* (target: Target) {
      const bytes = yield* fs.readFile(target.canonical)
      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: (cause) => new FSUtil.FileSystemError({ method: `decode ${target.resource}`, cause }),
      })
      return {
        digest: createHash("sha256").update(bytes).digest("hex"),
        totalLength: bytes.length,
        text,
      }
    })

    const record = Effect.fn("FileObservation.record")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly target: Target
      readonly version: Version
      readonly coverage: Coverage
    }) {
      const fence = yield* SessionExecutionAttempt.currentFence()
      if (!fence) return undefined
      for (const [token, record] of records)
        if (
          record.sessionID === input.sessionID &&
          (record.attemptID !== fence.attemptID ||
            record.generation !== fence.generation ||
            (record.canonical === input.target.canonical && record.digest !== input.version.digest))
        ) {
          records.delete(token)
          for (const [key, value] of keys) if (value === token) keys.delete(key)
        }
      const key = [input.sessionID, fence.attemptID, fence.generation, input.target.canonical, input.version.digest].join(
        "\0",
      )
      const existingToken = keys.get(key)
      const existing = existingToken ? records.get(existingToken) : undefined
      const ranges = mergeRanges([
        ...(existing?.ranges ?? []),
        ...(input.coverage.end > input.coverage.start
          ? ([[input.coverage.start, input.coverage.end]] as const)
          : []),
      ])
      const full = input.coverage.full || ranges.some(([start, end]) => start === 0 && end === input.coverage.total)
      const token = existing?.token ?? `fob_${randomUUID()}`
      records.set(token, {
        token,
        sessionID: input.sessionID,
        attemptID: fence.attemptID,
        generation: fence.generation,
        canonical: input.target.canonical,
        digest: input.version.digest,
        totalLength: input.version.totalLength,
        createdAt: existing?.createdAt ?? Date.now(),
        ranges,
        full,
      })
      keys.set(key, token)
      return { token, coverage: full ? ("full" as const) : ("partial" as const) }
    })

    const validate = Effect.fn("FileObservation.validate")(function* (input: {
      readonly token: string | undefined
      readonly sessionID: SessionSchema.ID
      readonly target: Target
    }) {
      const record = input.token ? records.get(input.token) : undefined
      if (!record) return yield* new InvalidError({ reason: "missing" })
      const fence = yield* SessionExecutionAttempt.currentFence()
      if (!fence || fence.attemptID !== record.attemptID || fence.generation !== record.generation)
        return yield* new InvalidError({ reason: "wrong-attempt" })
      if (record.sessionID !== input.sessionID) return yield* new InvalidError({ reason: "wrong-session" })
      if (record.canonical !== input.target.canonical) return yield* new InvalidError({ reason: "wrong-path" })
      if (!record.full) return yield* new InvalidError({ reason: "partial" })
      return record.digest
    })

    return Service.of({ snapshot, record, validate })
  }),
)

const mergeRanges = (ranges: ReadonlyArray<readonly [number, number]>) => {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0])
  const merged: Array<readonly [number, number]> = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (!previous || range[0] > previous[1]) merged.push(range)
    else merged[merged.length - 1] = [previous[0], Math.max(previous[1], range[1])]
  }
  return merged
}

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node] })
