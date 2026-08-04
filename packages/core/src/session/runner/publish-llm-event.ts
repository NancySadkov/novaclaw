import { ToolOutput, type LLMEvent, type ProviderMetadata, type ToolResultValue, type Usage } from "@novaclaw/llm"
import { DateTime, Effect } from "effect"
import { EventV2 } from "../../event"
import { ModelV2 } from "../../model"
import { SessionEvent } from "../event"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import { SessionExecutionAttempt } from "../execution-attempt"

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID?: SessionMessage.ID
  readonly agent: string
  readonly model: ModelV2.Ref
  readonly snapshot?: string
  readonly executionBoundary?: (
    phase: SessionExecutionAttempt.Phase,
    checkpoint: "clear" | "mark" | "keep",
  ) => Effect.Effect<void>
  readonly providerToolProtocol?: () => Effect.Effect<void>
  readonly toolSideEffects?: Readonly<
    Record<string, "read" | "idempotent-write" | "non-idempotent" | "external-unknown">
  >
  readonly toolDispatched?: (receipt: {
    callID: string
    name: string
    sideEffect: SessionExecutionAttempt.ToolSideEffect
  }) => Effect.Effect<void>
  readonly toolSettled?: (callID: string) => Effect.Effect<void>
}

const STREAM_CHECKPOINT_CHARS = 512
const STREAM_CHECKPOINT_MS = 500

/**
 * A fault on its way to the wire, with the taxonomy still attached.
 *
 * ⚠️ Every site here used to write `{ type: "unknown", message }` — the ten-arm tagged union the
 * runner computes was collapsed to a bare string one call earlier, so no reader could ever key an
 * i18n string off it, no surface could offer "retry" for the faults that deserve it, and raw
 * transport text ("… cause: connect ECONNREFUSED 192.168.178.40:8000") went straight into the chat.
 * `_tag` and `retryable` are ADDITIONAL structure: `message` still carries the provider's own words,
 * and a reader that knows no tag renders exactly what it rendered before.
 *
 * `_tag` is `SessionMessage.ErrorTag` at the call sites but `string` on the wire, deliberately — see
 * the note on `SessionMessage.ErrorTags`. `retryable` answers the USER's question ("can retrying this
 * turn plausibly work?"), which is `ProviderRetry.isTransientProviderFailure`, **not** the
 * schema-level `LLMError.retryable` getter — those disagree, and `Transport` is exactly where.
 */
type Fault = {
  readonly message: string
  readonly _tag?: SessionMessage.ErrorTag
  readonly retryable?: boolean
  readonly status?: number
}

/** Omit the optional keys rather than writing `undefined`: an absent field re-encodes byte-identical. */
const wireError = (fault: Fault) => ({
  type: "unknown" as const,
  message: fault.message,
  ...(fault._tag === undefined ? {} : { _tag: fault._tag }),
  ...(fault.retryable === undefined ? {} : { retryable: fault.retryable }),
  ...(fault.status === undefined ? {} : { status: fault.status }),
})

const safe = (value: number | undefined) => Math.max(0, Number.isFinite(value) ? (value ?? 0) : 0)

const tokens = (usage: Usage | undefined) => {
  const reasoning = safe(usage?.reasoningTokens)
  const read = safe(usage?.cacheReadInputTokens)
  const write = safe(usage?.cacheWriteInputTokens)
  return {
    input: safe(usage?.nonCachedInputTokens),
    output: safe(usage?.visibleOutputTokens),
    reasoning,
    cache: { read, write },
  }
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : { value }

const message = (value: unknown) => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

type SettledOutput =
  | { readonly structured: Record<string, unknown>; readonly content: ToolOutput["content"] }
  | { readonly error: { readonly type: "unknown"; readonly message: string; readonly _tag?: string } }

const settledOutput = (value: ToolOutput | undefined, result: ToolResultValue): SettledOutput => {
  if (result.type === "error")
    return { error: { type: "unknown", message: message(result.value), _tag: "ToolFailure" } }
  const settled = value ?? ToolOutput.fromResultValue(result)
  if (!settled) throw new Error(`Unsupported tool result: ${message(result)}`)
  return { structured: record(settled.structured), content: settled.content }
}

/** Persist one provider turn without executing tools or starting a continuation turn. */
export const createLLMEventPublisher = (events: EventV2.Interface, input: Input) => {
  const tools = new Map<
    string,
    {
      readonly assistantMessageID: SessionMessage.ID
      readonly name: string
      inputEnded: boolean
      called: boolean
      settled: boolean
      providerExecuted: boolean
      providerMetadata?: ProviderMetadata
    }
  >()
  const timestamp = DateTime.now
  let assistantMessageID: SessionMessage.ID | undefined
  let assistantActive = false
  let assistantFailed = false
  let providerFailed = false
  let stepSettlement: { readonly finish: string; readonly tokens: ReturnType<typeof tokens> } | undefined
  const executionBoundary = input.executionBoundary ?? (() => Effect.void)
  const providerToolProtocol = input.providerToolProtocol ?? (() => Effect.void)
  let providerCheckpointed = false

  const checkpointProviderOutput = Effect.fnUntraced(function* () {
    if (providerCheckpointed) return
    providerCheckpointed = true
    yield* executionBoundary("provider", "mark")
  })

  const startAssistant = Effect.fnUntraced(function* () {
    if (assistantMessageID !== undefined) return assistantMessageID
    assistantMessageID = input.assistantMessageID ?? SessionMessage.ID.create()
    assistantActive = true
    yield* events.publish(SessionEvent.Step.Started, {
      ...input,
      assistantMessageID,
      timestamp: yield* timestamp,
      snapshot: input.snapshot,
    })
    return assistantMessageID
  })
  const currentAssistantMessageID = () =>
    assistantMessageID === undefined
      ? Effect.die("Tool event before assistant step start")
      : Effect.succeed(assistantMessageID)

  const fragments = (
    name: string,
    ended: (id: string, value: string, providerMetadata?: ProviderMetadata) => Effect.Effect<void>,
    progress: (id: string, offset: number, delta: string) => Effect.Effect<void>,
  ) => {
    const chunks = new Map<
      string,
      {
        readonly values: string[]
        length: number
        checkpointLength: number
        checkpointIndex: number
        checkpointAt: number
      }
    >()
    const start = (id: string) =>
      Effect.suspend(() => {
        if (chunks.has(id)) return Effect.die(`Duplicate ${name} start: ${id}`)
        chunks.set(id, {
          values: [],
          length: 0,
          checkpointLength: 0,
          checkpointIndex: 0,
          checkpointAt: Date.now(),
        })
        return Effect.void
      })
    const append = Effect.fnUntraced(function* (id: string, value: string) {
      const current = chunks.get(id)
      if (!current) return yield* Effect.die(`${name} delta before start: ${id}`)
      current.values.push(value)
      current.length += value.length
      const now = Date.now()
      if (
        current.length - current.checkpointLength < STREAM_CHECKPOINT_CHARS &&
        now - current.checkpointAt < STREAM_CHECKPOINT_MS
      )
        return
      const delta = current.values.slice(current.checkpointIndex).join("")
      yield* progress(id, current.checkpointLength, delta)
      current.checkpointLength = current.length
      current.checkpointIndex = current.values.length
      current.checkpointAt = now
    })
    const value = (current: NonNullable<ReturnType<typeof chunks.get>>) => current.values.join("")
    const end = Effect.fnUntraced(function* (id: string, providerMetadata?: ProviderMetadata) {
      const current = chunks.get(id)
      if (!current) return yield* Effect.die(`${name} end before start: ${id}`)
      yield* ended(id, value(current), providerMetadata)
      chunks.delete(id)
    })
    const flush = Effect.fnUntraced(function* () {
      for (const id of chunks.keys()) yield* end(id)
    })
    return { start, append, end, flush }
  }

  const text = fragments(
    "text",
    (textID, value) =>
      Effect.gen(function* () {
        yield* events.publish(SessionEvent.Text.Ended, {
          sessionID: input.sessionID,
          assistantMessageID: yield* currentAssistantMessageID(),
          timestamp: yield* timestamp,
          textID,
          text: value,
        })
      }),
    (textID, offset, delta) =>
      Effect.gen(function* () {
        yield* events.publish(SessionEvent.Text.Progress, {
          sessionID: input.sessionID,
          assistantMessageID: yield* currentAssistantMessageID(),
          timestamp: yield* timestamp,
          textID,
          offset,
          delta,
        })
      }),
  )
  const reasoning = fragments(
    "reasoning",
    (reasoningID, value, providerMetadata) =>
      Effect.gen(function* () {
        yield* events.publish(SessionEvent.Reasoning.Ended, {
          sessionID: input.sessionID,
          assistantMessageID: yield* currentAssistantMessageID(),
          timestamp: yield* timestamp,
          reasoningID,
          text: value,
          providerMetadata,
        })
      }),
    (reasoningID, offset, delta) =>
      Effect.gen(function* () {
        yield* events.publish(SessionEvent.Reasoning.Progress, {
          sessionID: input.sessionID,
          assistantMessageID: yield* currentAssistantMessageID(),
          timestamp: yield* timestamp,
          reasoningID,
          offset,
          delta,
        })
      }),
  )
  const toolInput = fragments(
    "tool input",
    (callID, value) =>
      Effect.gen(function* () {
        const tool = tools.get(callID)
        if (!tool) return yield* Effect.die(`Tool input end before start: ${callID}`)
        yield* events.publish(SessionEvent.Tool.Input.Ended, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID,
          text: value,
        })
        tool.inputEnded = true
      }),
    (callID, offset, delta) =>
      Effect.gen(function* () {
        const tool = tools.get(callID)
        if (!tool) return yield* Effect.die(`Tool input progress before start: ${callID}`)
        yield* events.publish(SessionEvent.Tool.Input.Progress, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID,
          offset,
          delta,
        })
      }),
  )

  const flushFragments = Effect.fnUntraced(function* () {
    yield* text.flush()
    yield* reasoning.flush()
    yield* toolInput.flush()
  })

  const startToolInput = Effect.fnUntraced(function* (event: { readonly id: string; readonly name: string }) {
    if (tools.has(event.id)) return yield* Effect.die(`Duplicate tool input start: ${event.id}`)
    const assistantMessageID = yield* startAssistant()
    tools.set(event.id, {
      assistantMessageID,
      name: event.name,
      inputEnded: false,
      called: false,
      settled: false,
      providerExecuted: false,
    })
    yield* toolInput.start(event.id)
    yield* events.publish(SessionEvent.Tool.Input.Started, {
      sessionID: input.sessionID,
      timestamp: yield* timestamp,
      assistantMessageID,
      callID: event.id,
      name: event.name,
    })
  })

  const endToolInput = Effect.fnUntraced(function* (event: { readonly id: string; readonly name: string }) {
    const tool = tools.get(event.id)
    if (!tool) return yield* Effect.die(`Tool input end before start: ${event.id}`)
    if (tool.name !== event.name)
      return yield* Effect.die(`Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`)
    if (tool.inputEnded) return yield* Effect.die(`Duplicate tool input end: ${event.id}`)
    yield* toolInput.end(event.id)
  })

  const flush = Effect.fn("SessionRunner.flush")(function* () {
    yield* flushFragments()
  })

  const failAssistant = Effect.fnUntraced(function* (fault: Fault) {
    if (assistantFailed) return
    yield* flush()
    const assistantMessageID = yield* startAssistant()
    assistantActive = false
    assistantFailed = true
    yield* events.publish(SessionEvent.Step.Failed, {
      sessionID: input.sessionID,
      timestamp: yield* timestamp,
      assistantMessageID,
      error: wireError(fault),
    })
  })

  /**
   * Settle a partially readable provider reply without turning it into a fatal assistant error.
   * The durable `broken` finish marker is lowered into the next model context, while zero usage is
   * honest: a severed stream often omits the provider's final usage frame.
   */
  const breakAssistant = Effect.fnUntraced(function* () {
    if (stepSettlement) return
    yield* flush()
    yield* startAssistant()
    assistantActive = false
    stepSettlement = { finish: "broken", tokens: tokens(undefined) }
  })

  const failUnsettledTools = Effect.fn("SessionRunner.failUnsettledTools")(function* (
    fault: Fault,
    hostedOnly = false,
  ) {
    for (const [callID, tool] of tools) {
      if (tool.settled || (hostedOnly && !tool.providerExecuted)) continue
      tool.settled = true
      yield* events.publish(SessionEvent.Tool.Failed, {
        sessionID: input.sessionID,
        timestamp: yield* timestamp,
        assistantMessageID: tool.assistantMessageID,
        callID,
        error: wireError(fault),
        provider: {
          executed: tool.providerExecuted,
          ...(tool.providerMetadata === undefined ? {} : { metadata: tool.providerMetadata }),
        },
      })
    }
  })

  const assistantMessageIDForTool = (callID: string) => {
    const tool = tools.get(callID)
    return tool ? Effect.succeed(tool.assistantMessageID) : Effect.die(`Unknown tool call: ${callID}`)
  }

  const publish = Effect.fn("SessionRunner.publishLLMEvent")(function* (
    event: LLMEvent,
    outputPaths: ReadonlyArray<string> = [],
  ) {
    switch (event.type) {
      case "step-start":
        return
      case "text-start":
        yield* checkpointProviderOutput()
        yield* text.start(event.id)
        yield* events.publish(SessionEvent.Text.Started, {
          sessionID: input.sessionID,
          assistantMessageID: yield* startAssistant(),
          timestamp: yield* timestamp,
          textID: event.id,
        })
        return
      case "text-delta":
        yield* text.append(event.id, event.text)
        yield* events.publish(SessionEvent.Text.Delta, {
          sessionID: input.sessionID,
          assistantMessageID: yield* currentAssistantMessageID(),
          timestamp: yield* timestamp,
          textID: event.id,
          delta: event.text,
        })
        return
      case "text-end":
        yield* text.end(event.id)
        return
      case "reasoning-start":
        yield* checkpointProviderOutput()
        yield* reasoning.start(event.id)
        yield* events.publish(SessionEvent.Reasoning.Started, {
          sessionID: input.sessionID,
          assistantMessageID: yield* startAssistant(),
          timestamp: yield* timestamp,
          reasoningID: event.id,
          providerMetadata: event.providerMetadata,
        })
        return
      case "reasoning-delta":
        yield* reasoning.append(event.id, event.text)
        yield* events.publish(SessionEvent.Reasoning.Delta, {
          sessionID: input.sessionID,
          assistantMessageID: yield* currentAssistantMessageID(),
          timestamp: yield* timestamp,
          reasoningID: event.id,
          delta: event.text,
        })
        return
      case "reasoning-end":
        yield* reasoning.end(event.id, event.providerMetadata)
        return
      case "tool-input-start":
        yield* startToolInput(event)
        return
      case "tool-input-delta": {
        const tool = tools.get(event.id)
        if (!tool) return yield* Effect.die(`Tool input delta before start: ${event.id}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool input name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.inputEnded) return yield* Effect.die(`Tool input delta after end: ${event.id}`)
        yield* toolInput.append(event.id, event.text)
        yield* events.publish(SessionEvent.Tool.Input.Delta, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          delta: event.text,
        })
        return
      }
      case "tool-input-end":
        yield* endToolInput(event)
        return
      case "tool-call": {
        if (!tools.has(event.id)) yield* startToolInput(event)
        const tool = tools.get(event.id)!
        if (!tool.inputEnded) yield* endToolInput(event)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool call name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.called) return yield* Effect.die(`Duplicate tool call: ${event.id}`)
        tool.called = true
        tool.providerExecuted = event.providerExecuted === true
        tool.providerMetadata = event.providerMetadata
        const sideEffect = input.toolSideEffects?.[event.name] ?? "external-unknown"
        // Fence the dangerous interval BEFORE publishing dispatch. A crash between these writes is
        // conservatively outcome-unknown; the inverse ordering could replay a side effect.
        yield* input.toolDispatched?.({ callID: event.id, name: event.name, sideEffect }) ?? Effect.void
        yield* executionBoundary("tool", "clear")
        yield* providerToolProtocol()
        yield* events.publish(SessionEvent.Tool.Called, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          tool: event.name,
          sideEffect,
          input: record(event.input),
          provider: {
            executed: tool.providerExecuted,
            ...(event.providerMetadata === undefined ? {} : { metadata: event.providerMetadata }),
          },
        })
        return
      }
      case "tool-result": {
        const tool = tools.get(event.id)
        if (!tool?.called) return yield* Effect.die(`Tool result before call: ${event.id}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool result name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.settled) {
          if (event.result.type === "error") return
          return yield* Effect.die(`Duplicate tool result: ${event.id}`)
        }
        tool.settled = true
        const result = settledOutput(event.output, event.result)
        const provider = {
          executed: event.providerExecuted === true || tool.providerExecuted,
          ...(event.providerMetadata === undefined ? {} : { metadata: event.providerMetadata }),
        }
        if ("error" in result) {
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID: input.sessionID,
            timestamp: yield* timestamp,
            assistantMessageID: tool.assistantMessageID,
            callID: event.id,
            error: result.error,
            result: event.result,
            provider,
          })
          yield* executionBoundary("tool", "mark")
          yield* input.toolSettled?.(event.id) ?? Effect.void
          return
        }
        yield* events.publish(SessionEvent.Tool.Success, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          ...result,
          outputPaths,
          ...(provider.executed ? { result: event.result } : {}),
          provider,
        })
        yield* executionBoundary("tool", "mark")
        yield* input.toolSettled?.(event.id) ?? Effect.void
        return
      }
      case "tool-error": {
        const tool = tools.get(event.id)
        if (!tool?.called) return yield* Effect.die(`Tool error before call: ${event.id}`)
        if (tool.name !== event.name)
          return yield* Effect.die(`Tool error name changed for ${event.id}: ${tool.name} -> ${event.name}`)
        if (tool.settled) return yield* Effect.die(`Duplicate tool error: ${event.id}`)
        tool.settled = true
        yield* events.publish(SessionEvent.Tool.Failed, {
          sessionID: input.sessionID,
          timestamp: yield* timestamp,
          assistantMessageID: tool.assistantMessageID,
          callID: event.id,
          error: wireError({ message: event.message, _tag: "ToolFailure" }),
          provider: {
            executed: tool.providerExecuted,
            ...(event.providerMetadata === undefined ? {} : { metadata: event.providerMetadata }),
          },
        })
        yield* executionBoundary("tool", "mark")
        yield* input.toolSettled?.(event.id) ?? Effect.void
        return
      }
      case "step-finish":
        yield* flush()
        yield* executionBoundary("provider", "mark")
        assistantActive = false
        if (stepSettlement) return yield* Effect.die("Duplicate step finish")
        stepSettlement = { finish: event.reason, tokens: tokens(event.usage) }
        return
      case "finish":
        return
      case "provider-error":
        providerFailed = true
        // No `_tag`: a provider-error event carries no reason arm, so claiming one would be the false
        // description ruling 2 forbids. `retryable` IS known here and was being discarded — the second
        // place the taxonomy died, and the one the original filing did not name.
        yield* failAssistant({
          message: event.message,
          ...(event.retryable === undefined ? {} : { retryable: event.retryable }),
        })
        return
    }
  })

  return {
    publish,
    flush,
    failAssistant,
    breakAssistant,
    failUnsettledTools,
    hasActiveAssistant: () => assistantActive,
    hasAssistantStarted: () => assistantMessageID !== undefined,
    hasProviderError: () => providerFailed,
    stepSettlement: () => stepSettlement,
    startAssistant,
    assistantMessageID: assistantMessageIDForTool,
  }
}
