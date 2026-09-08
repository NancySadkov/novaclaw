export * as AgentStatusSampler from "./sampler"

import { Context, DateTime, Effect, FiberSet, Layer } from "effect"
import { AgentStatusEvent } from "@novaclaw/schema/agent-status-event"
import { Log } from "@novaclaw/schema/log"
import { SessionEvent } from "@novaclaw/schema/session-event"
import { AgentV2 } from "../agent"
import { AgentStatus } from "../agent-status"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { LocationServiceMap } from "../location-service-map"
import { SessionScheduler } from "../session/scheduler"
import { SessionStore } from "../session/store"
import { llmClient } from "../effect/app-node-platform"
import { AgentStatusDerive } from "./derive"
import { cleanCommandLabel, SYSTEM as COMMAND_SYSTEM } from "./command-label"
import { SYSTEM as WORKER_SYSTEM } from "./worker-label"

/**
 * The general lifecycle sampler for agent entity components.
 *
 * Each rule reacts to a kernel event and schedules derived work without delaying that event's
 * publisher. Revisions coalesce bursts per agent entity: an older model answer is discarded when a
 * newer prompt/compaction/terminal transition arrived in any of that colleague's sessions. A watchdog can join
 * this observer later as another rule without creating another event loop.
 */
export interface Interface {
  readonly running: true
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/AgentStatusSampler") {}

export const lifecycleSession = (event: { readonly type: string; readonly data: unknown }): string | undefined => {
  const data = event.data as { sessionID?: unknown; status?: { type?: unknown } }
  if (typeof data?.sessionID !== "string") return undefined
  if (event.type === "session.next.prompted" || event.type === "session.next.compaction.ended") return data.sessionID
  if (event.type === "session.status" && (data.status?.type === "idle" || data.status?.type === "exited"))
    return data.sessionID
  return undefined
}

export const shellCall = (event: { readonly type: string; readonly data: unknown }) => {
  if (event.type !== "session.next.tool.called") return undefined
  const data = event.data as {
    sessionID?: unknown
    assistantMessageID?: unknown
    callID?: unknown
    tool?: unknown
    input?: { command?: unknown }
  }
  if (
    data.tool !== "bash" ||
    typeof data.sessionID !== "string" ||
    typeof data.assistantMessageID !== "string" ||
    typeof data.callID !== "string" ||
    typeof data.input?.command !== "string" ||
    !data.input.command.trim()
  )
    return undefined
  return {
    sessionID: data.sessionID,
    assistantMessageID: data.assistantMessageID,
    callID: data.callID,
    command: data.input.command,
  }
}

export const workerCall = (event: { readonly type: string; readonly data: unknown }) => {
  if (event.type !== "session.next.tool.called") return undefined
  const data = event.data as {
    sessionID?: unknown
    assistantMessageID?: unknown
    callID?: unknown
    tool?: unknown
    input?: { prompt?: unknown; description?: unknown }
  }
  const prompt = data.tool === "spawn" ? data.input?.prompt : data.tool === "task" ? data.input?.description : undefined
  if (
    typeof data.sessionID !== "string" ||
    typeof data.assistantMessageID !== "string" ||
    typeof data.callID !== "string" ||
    typeof prompt !== "string" ||
    !prompt.trim()
  )
    return undefined
  return {
    sessionID: data.sessionID,
    assistantMessageID: data.assistantMessageID,
    callID: data.callID,
    prompt,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const status = yield* AgentStatus.Service
    const store = yield* SessionStore.Service
    const labeller = yield* AgentStatusDerive.makeLabeller()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()
    type PendingSample = { readonly revision: number; readonly sessionID: string }
    const pendingByAgent = new Map<string, PendingSample>()
    const active = new Set<string>()
    const toolLabels = new Set<string>()
    let lifecycleRevision = 0

    const sample = (agent: string, sessionID: string, revision: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        const session = yield* store.get(sessionID as never)
        if (session?.agent !== agent) return
        const text = yield* labeller.recent(sessionID)
        if (!text) return
        const task = yield* labeller.label(sessionID, text)
        // A newer lifecycle fact arrived while the model was answering. Never publish the stale line.
        if (pendingByAgent.get(agent)?.revision !== revision) return
        if (!task) return
        const info = { agent, task, observed: Date.now() }
        yield* status.set(info)
        yield* events.publish(AgentStatusEvent.Updated, info, { location: session.location })
      }).pipe(
        Effect.catchCause((cause) =>
          Log.event("instance.status.sample.failed", { "instance.cause": Log.fault(cause) }),
        ),
      )

    const drain = (agent: string): Effect.Effect<void> => {
      let handled = 0
      return Effect.gen(function* () {
        while (true) {
          const pending = pendingByAgent.get(agent)
          if (!pending) return
          yield* sample(agent, pending.sessionID, pending.revision)
          handled = pending.revision
          if (pendingByAgent.get(agent)?.revision === handled) return
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            active.delete(agent)
            const latest = pendingByAgent.get(agent)
            if (latest?.revision === handled) pendingByAgent.delete(agent)
            // If a trigger landed after the last loop check, preserve it as the first revision of
            // a fresh drain instead of silently losing the lifecycle transition.
            if (latest && latest.revision > handled && !active.has(agent)) {
              active.add(agent)
              fork(drain(agent))
            }
          }),
        ),
      )
    }

    const schedule = (agent: string, sessionID: string, revision: number) => {
      const current = pendingByAgent.get(agent)
      // Session lookup runs in a detached fiber, so preserve event ARRIVAL order even if two
      // lookups finish out of order. The newest entity fact is the only one allowed to label it.
      if (current && current.revision > revision) return
      pendingByAgent.set(agent, { revision, sessionID })
      if (active.has(agent)) return
      active.add(agent)
      fork(drain(agent))
    }

    const routeSample = (sessionID: string, revision: number) =>
      Effect.gen(function* () {
        const session = yield* store.get(sessionID as never)
        const agent = session?.agent
        if (!agent || AgentV2.POSTURE_IDS.has(AgentV2.ID.make(agent))) return
        schedule(agent, sessionID, revision)
      }).pipe(Effect.catchCause(() => Effect.void))

    const labelTool = (input: {
      readonly sessionID: string
      readonly assistantMessageID: string
      readonly callID: string
      readonly system: string
      readonly text: string
    }) =>
      Effect.gen(function* () {
        const session = yield* store.get(input.sessionID as never)
        if (!session) return
        const raw = yield* labeller.short(input.sessionID, {
          system: input.system,
          text: input.text,
          task: "tool-title",
          reasoningBudget: 0,
        })
        if (!raw) return
        const title = cleanCommandLabel(raw)
        if (!title) return
        yield* events.publish(
          SessionEvent.Tool.Labelled,
          {
            timestamp: yield* DateTime.now,
            sessionID: input.sessionID as never,
            assistantMessageID: input.assistantMessageID as never,
            callID: input.callID,
            title,
          },
          { location: session.location },
        )
      }).pipe(
        // This label is presentation-only and already has a deterministic fallback. A failed
        // maintenance sample must not turn into another ambient warning in the working chat.
        Effect.catchCause(() => Effect.void),
        Effect.ensuring(Effect.sync(() => toolLabels.delete(input.callID))),
      )

    const unsubscribe = yield* events.listen((event) => {
      const sessionID = lifecycleSession(event)
      const command = shellCall(event)
      const worker = workerCall(event)
      return Effect.sync(() => {
        if (sessionID) fork(routeSample(sessionID, ++lifecycleRevision))
        const presentation = command
          ? { ...command, system: COMMAND_SYSTEM, text: command.command }
          : worker
            ? { ...worker, system: WORKER_SYSTEM, text: worker.prompt }
            : undefined
        if (presentation && !toolLabels.has(presentation.callID)) {
          toolLabels.add(presentation.callID)
          fork(labelTool(presentation))
        }
      })
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    return Service.of({ running: true })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [EventV2.node, AgentStatus.node, SessionStore.node, LocationServiceMap.node, SessionScheduler.node, llmClient],
})
