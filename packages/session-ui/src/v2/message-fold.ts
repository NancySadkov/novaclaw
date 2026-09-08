import type {
  SessionMessage,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionMessageShell,
  V2Event,
} from "@novaclaw/sdk/v2"
import * as Timestamp from "@novaclaw/schema/time"

/**
 * Client-side fold of the native V2 `session.next.*` event stream into a flat
 * `SessionMessage[]` — the strategy-B replacement for the V1 `message`/`part`
 * reducer (F1e).
 *
 * **Canonical counterpart:** `packages/core/src/session/message-updater.ts`
 * (`SessionMessageUpdater.update` + its `memory()` adapter) folds the SAME
 * `session.next.*` state machine on the DB projector and is exhaustive over the
 * event union. This module deliberately mirrors that logic on the **generated SDK
 * wire types** (`@novaclaw/sdk/v2`: `time.created` is a `number`, ids are plain
 * strings) rather than reusing the core updater, because the client consumes wire
 * JSON from the SSE/fetch path and feeds SDK-typed render components — reusing the
 * core version would drag a per-event decode/encode boundary plus the Effect/immer
 * runtime into the browser reducer (the deleted TUI `data.tsx` split it the same way).
 * ⚠️ **Drift caution:** a new `session.next.*` event must be handled in BOTH this
 * fold and the core `SessionMessageUpdater`.
 *
 * **Ordering: oldest-first** (index 0 = oldest, last = newest) — matches the core
 * `memory()` adapter (which appends) and `server-session.ts` (ascending sort), so this
 * store is a drop-in for the existing render order. Assistant `content[]` is appended
 * in arrival order.
 *
 * **Intentional client divergences from the core updater** (both safe): (1) an
 * idempotent `step.started` guard — the client may replay events across a mid-turn
 * reload, so a duplicate must not re-complete the active assistant; (2) it applies
 * `session.next.tool.input.delta` to stream tool input live, whereas core no-ops it
 * (input deltas aren't durable, so the projector only needs `tool.input.ended`).
 *
 * Every function **mutates `messages` (and its nested objects) in place**, so a caller
 * can drive it from inside a solid-js `produce` draft. No runtime deps (types erased);
 * unit-testable on plain arrays. Callers route by `event.data.sessionID`.
 */

/** Append `item` unless a message with the same id already exists (idempotent → mid-turn-reload safe). */
/**
 * Marks a message the client is showing AHEAD of the server — on screen the instant the user pressed
 * Enter, before the prompt has been acknowledged.
 *
 * It lives in `metadata`, which is already part of the message type, so nothing in the schema or on the
 * wire had to learn about a client-only state. It is defined HERE, in the shared render layer, because
 * both sides need it and the dependency only runs one way: the app's store stamps it, this package's
 * transcript reads it.
 */
export const OPTIMISTIC_METADATA_KEY = "novaclawOptimistic"

/** True while a message is on screen but not yet acknowledged by the server. */
export function isOptimistic(message: SessionMessage | undefined): boolean {
  return (message as { metadata?: Record<string, unknown> } | undefined)?.metadata?.[OPTIMISTIC_METADATA_KEY] === true
}

/**
 * Stamp a timestamp onto a message whose `time` struct may be absent.
 *
 * 🔴 **A malformed row must be an EVENT, not a fatal error** (owner, 2026-08-27). The schema declares
 * `time` REQUIRED on an assistant message, and a row still reached the renderer without it — which is
 * exactly the case a bare `message.time.completed = t` cannot survive. Crashing the transcript because
 * one row is short of a field puts the whole UI on the floor over something the product is supposed to
 * absorb; `Cannot read properties of undefined (reading 'time')` took down a shipped 0.1.67 renderer
 * this way, through the app's single root ErrorBoundary.
 *
 * ⚠️ It REPAIRS rather than skips. Dropping the stamp would leave an assistant message that never
 * completes, and `isInFlightAssistant` reads exactly that field — so the transcript would show a turn
 * spinning forever instead of a turn that ended.
 */
function stamp(
  message: { time?: { created?: number; ran?: number; completed?: number } },
  field: "ran" | "completed",
  at: number,
): void {
  const time = (message.time ??= { created: at })
  time[field] = at
}

export function appendMessage(messages: SessionMessage[], item: SessionMessage): void {
  if (messages.some((existing) => existing.id === item.id)) return
  messages.push(item)
}

/** The latest assistant message, returned only while it is still streaming (no `time.completed`). */
export function activeAssistant(messages: SessionMessage[]): SessionMessageAssistant | undefined {
  const item = messages.findLast((message) => message.type === "assistant")
  return item?.type === "assistant" && !item.time?.completed ? item : undefined
}

/** The assistant message with the given id (latest, if ids somehow repeat), if present. */
export function findAssistant(messages: SessionMessage[], messageID: string): SessionMessageAssistant | undefined {
  const item = messages.findLast((message) => message.type === "assistant" && message.id === messageID)
  return item?.type === "assistant" ? item : undefined
}

/** The latest shell message for the given callID, if present. */
export function activeShell(messages: SessionMessage[], callID: string): SessionMessageShell | undefined {
  const item = messages.findLast((message) => message.type === "shell" && message.callID === callID)
  return item?.type === "shell" ? item : undefined
}

/** The last tool part of the target assistant (optionally matching a callID). */
export function latestTool(
  assistant: SessionMessageAssistant | undefined,
  callID?: string,
): SessionMessageAssistantTool | undefined {
  return assistant?.content.findLast(
    (item): item is SessionMessageAssistantTool => item.type === "tool" && (callID === undefined || item.id === callID),
  )
}

/** The last text part of the target assistant matching `textID`. */
export function latestText(
  assistant: SessionMessageAssistant | undefined,
  textID: string,
): SessionMessageAssistantText | undefined {
  return assistant?.content.findLast(
    (item): item is SessionMessageAssistantText => item.type === "text" && item.id === textID,
  )
}

/** The last reasoning part of the target assistant matching `reasoningID`. */
export function latestReasoning(
  assistant: SessionMessageAssistant | undefined,
  reasoningID: string,
): SessionMessageAssistantReasoning | undefined {
  return assistant?.content.findLast(
    (item): item is SessionMessageAssistantReasoning => item.type === "reasoning" && item.id === reasoningID,
  )
}

/** Merge a durable stream checkpoint without duplicating live deltas already seen by this client. */
function mergeCheckpoint(current: string, offset: number, delta: string): string {
  if (offset > current.length) return current
  const overlap = current.length - offset
  if (overlap >= delta.length) return current
  return current + delta.slice(Math.max(0, overlap))
}

/**
 * Fold one `session.next.*` event into `messages` (the event's session array).
 * Non-transcript events (`prompt.admitted`, `moved`, `completed`,
 * `responder/mode.switched`, `revert.*`) and non-`session.next`
 * events are no-ops here — they belong to the session-info / revert stores handled in later
 * F1e slices, exactly as the core updater routes them to the session row.
 */
export function applySessionNextEvent(messages: SessionMessage[], event: V2Event): void {
  switch (event.type) {
    case "session.next.agent.switched":
      appendMessage(messages, {
        id: event.data.messageID,
        type: "agent-switched",
        agent: event.data.agent,
        time: { created: event.data.timestamp },
      })
      break
    case "session.next.model.switched":
      appendMessage(messages, {
        id: event.data.messageID,
        type: "model-switched",
        model: event.data.model,
        time: { created: event.data.timestamp },
      })
      break
    case "session.next.prompted":
      appendMessage(messages, {
        id: event.data.messageID,
        type: "user",
        text: event.data.prompt.text,
        files: event.data.prompt.files,
        agents: event.data.prompt.agents,
        time: { created: event.data.timestamp },
      })
      break
    case "session.next.context.updated":
      appendMessage(messages, {
        id: event.data.messageID,
        type: "system",
        text: event.data.text,
        time: { created: event.data.timestamp },
      })
      break
    case "session.next.synthetic":
      appendMessage(messages, {
        id: event.data.messageID,
        type: "synthetic",
        sessionID: event.data.sessionID,
        text: event.data.text,
        repair: event.data.repair,
        time: { created: event.data.timestamp },
      })
      break
    case "session.next.permission.changed":
      appendMessage(messages, {
        id: event.data.messageID,
        type: "permission-changed",
        op: event.data.op,
        previous: event.data.previous,
        mode: event.data.mode,
        ceiling: event.data.ceiling,
        justification: event.data.justification,
        time: { created: event.data.timestamp },
      })
      break
    case "session.next.shell.started":
      appendMessage(messages, {
        id: event.data.messageID,
        type: "shell",
        callID: event.data.callID,
        command: event.data.command,
        output: "",
        time: { created: event.data.timestamp },
      })
      break
    case "session.next.shell.ended": {
      const match = activeShell(messages, event.data.callID)
      if (!match) break
      match.output = event.data.output
      stamp(match, "completed", event.data.timestamp)
      break
    }
    case "session.next.step.started": {
      // Client idempotency: a replayed step.started must not re-complete the active assistant.
      if (messages.some((message) => message.id === event.data.assistantMessageID)) break
      const current = activeAssistant(messages)
      if (current) stamp(current, "completed", event.data.timestamp)
      appendMessage(messages, {
        id: event.data.assistantMessageID,
        type: "assistant",
        agent: event.data.agent,
        model: event.data.model,
        content: [],
        snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
        time: { created: event.data.timestamp },
      })
      break
    }
    case "session.next.step.ended": {
      const assistant = findAssistant(messages, event.data.assistantMessageID)
      if (!assistant) break
      stamp(assistant, "completed", event.data.timestamp)
      assistant.finish = event.data.finish
      assistant.cost = event.data.cost
      assistant.tokens = event.data.tokens
      if (event.data.snapshot || event.data.files)
        assistant.snapshot = {
          ...assistant.snapshot,
          end: event.data.snapshot,
          files: event.data.files ? [...event.data.files] : undefined,
        }
      break
    }
    case "session.next.step.failed": {
      const assistant = findAssistant(messages, event.data.assistantMessageID)
      if (!assistant) break
      stamp(assistant, "completed", event.data.timestamp)
      assistant.finish = "error"
      assistant.error = event.data.error
      break
    }
    case "session.next.text.started":
      findAssistant(messages, event.data.assistantMessageID)?.content.push({
        type: "text",
        id: event.data.textID,
        text: "",
      })
      break
    case "session.next.text.delta": {
      const match = latestText(findAssistant(messages, event.data.assistantMessageID), event.data.textID)
      if (match) match.text += event.data.delta
      break
    }
    case "session.next.text.progress": {
      const match = latestText(findAssistant(messages, event.data.assistantMessageID), event.data.textID)
      if (match) match.text = mergeCheckpoint(match.text, event.data.offset, event.data.delta)
      break
    }
    case "session.next.text.ended": {
      const match = latestText(findAssistant(messages, event.data.assistantMessageID), event.data.textID)
      if (match) match.text = event.data.text
      break
    }
    case "session.next.tool.input.started":
      findAssistant(messages, event.data.assistantMessageID)?.content.push({
        type: "tool",
        id: event.data.callID,
        name: event.data.name,
        time: { created: event.data.timestamp },
        state: { status: "pending", input: "" },
      })
      break
    case "session.next.tool.input.delta": {
      // Client-only: stream the pending tool input live (core no-ops this — not durable).
      const match = latestTool(findAssistant(messages, event.data.assistantMessageID), event.data.callID)
      if (match?.state.status === "pending") match.state.input += event.data.delta
      break
    }
    case "session.next.tool.input.progress": {
      const match = latestTool(findAssistant(messages, event.data.assistantMessageID), event.data.callID)
      if (match?.state.status === "pending")
        match.state.input = mergeCheckpoint(match.state.input, event.data.offset, event.data.delta)
      break
    }
    case "session.next.tool.input.ended": {
      const match = latestTool(findAssistant(messages, event.data.assistantMessageID), event.data.callID)
      if (match?.state.status === "pending") match.state.input = event.data.text
      break
    }
    case "session.next.tool.called": {
      const match = latestTool(findAssistant(messages, event.data.assistantMessageID), event.data.callID)
      if (!match) break
      stamp(match, "ran", event.data.timestamp)
      match.provider = event.data.provider
      match.state = { status: "running", input: event.data.input, structured: {}, content: [] }
      break
    }
    case "session.next.tool.labelled": {
      const match = latestTool(findAssistant(messages, event.data.assistantMessageID), event.data.callID)
      if (match) match.title = event.data.title
      break
    }
    case "session.next.tool.progress": {
      const match = latestTool(findAssistant(messages, event.data.assistantMessageID), event.data.callID)
      if (match?.state.status !== "running") break
      match.state.structured = event.data.structured
      match.state.content = [...event.data.content]
      break
    }
    case "session.next.tool.success": {
      const match = latestTool(findAssistant(messages, event.data.assistantMessageID), event.data.callID)
      if (match?.state.status !== "running") break
      match.state = {
        status: "completed",
        input: match.state.input,
        structured: event.data.structured,
        content: [...event.data.content],
        outputPaths: event.data.outputPaths ? [...event.data.outputPaths] : [],
        result: event.data.result,
      }
      match.provider = {
        executed: event.data.provider.executed || match.provider?.executed === true,
        metadata: match.provider?.metadata,
        resultMetadata: event.data.provider.metadata,
      }
      stamp(match, "completed", event.data.timestamp)
      break
    }
    case "session.next.tool.failed": {
      const match = latestTool(findAssistant(messages, event.data.assistantMessageID), event.data.callID)
      if (!match || (match.state.status !== "pending" && match.state.status !== "running")) break
      match.state = {
        status: "error",
        error: event.data.error,
        input: typeof match.state.input === "string" ? {} : match.state.input,
        structured: match.state.status === "running" ? match.state.structured : {},
        content: match.state.status === "running" ? match.state.content : [],
        result: event.data.result,
      }
      match.provider = {
        executed: event.data.provider.executed || match.provider?.executed === true,
        metadata: match.provider?.metadata,
        resultMetadata: event.data.provider.metadata,
      }
      stamp(match, "completed", event.data.timestamp)
      break
    }
    case "session.next.reasoning.started":
      findAssistant(messages, event.data.assistantMessageID)?.content.push({
        type: "reasoning",
        id: event.data.reasoningID,
        text: "",
        providerMetadata: event.data.providerMetadata,
        time: { created: event.data.timestamp },
      })
      break
    case "session.next.reasoning.delta": {
      const match = latestReasoning(findAssistant(messages, event.data.assistantMessageID), event.data.reasoningID)
      if (match) match.text += event.data.delta
      break
    }
    case "session.next.reasoning.progress": {
      const match = latestReasoning(findAssistant(messages, event.data.assistantMessageID), event.data.reasoningID)
      if (match) match.text = mergeCheckpoint(match.text, event.data.offset, event.data.delta)
      break
    }
    case "session.next.reasoning.ended": {
      const match = latestReasoning(findAssistant(messages, event.data.assistantMessageID), event.data.reasoningID)
      if (match) {
        match.text = event.data.text
        match.time = { created: match.time?.created ?? event.data.timestamp, completed: event.data.timestamp }
        if (event.data.providerMetadata !== undefined) match.providerMetadata = event.data.providerMetadata
      }
      break
    }
    case "session.next.compaction.started":
      appendMessage(messages, {
        id: event.data.messageID,
        type: "compaction-status",
        reason: event.data.reason,
        status: "running",
        generatedChars: 0,
        time: { created: event.data.timestamp },
      })
      break
    case "session.next.compaction.delta": {
      const match = messages.findLast(
        (message) => message.type === "compaction-status" && message.id === event.data.messageID,
      )
      if (match?.type === "compaction-status") match.generatedChars += event.data.text.length
      break
    }
    case "session.next.compaction.progress": {
      const match = messages.findLast(
        (message) => message.type === "compaction-status" && message.id === event.data.messageID,
      )
      if (match?.type === "compaction-status") match.generatedChars = event.data.generatedChars
      break
    }
    case "session.next.compaction.ended": {
      const index = messages.findLastIndex(
        (message) => message.type === "compaction-status" && message.id === event.data.messageID,
      )
      const match = index < 0 ? undefined : messages[index]
      if (event.data.failure !== undefined) {
        if (match?.type === "compaction-status") {
          match.status = "failed"
          match.failure = event.data.failure
          match.generatedChars = event.data.generatedChars ?? 0
          match.time.completed = event.data.timestamp
        }
        break
      }
      if (match?.type === "compaction-status") {
        messages[index] = {
          id: match.id,
          type: "compaction",
          metadata: match.metadata,
          reason: event.data.reason,
          summary: event.data.text,
          recent: event.data.recent,
          generatedChars: event.data.generatedChars ?? event.data.text.length,
          time: { created: match.time.created, completed: event.data.timestamp },
        }
      } else {
        appendMessage(messages, {
          id: event.data.messageID,
          type: "compaction",
          reason: event.data.reason,
          summary: event.data.text,
          recent: event.data.recent,
          generatedChars: event.data.generatedChars ?? event.data.text.length,
          time: { created: event.data.timestamp, completed: event.data.timestamp },
        })
      }
      break
    }
    case "session.next.revert.committed": {
      // A committed revert truncates the transcript: the core deletes every message AFTER the
      // boundary (seq > boundary), keeping the boundary message itself. Message ids are ascending,
      // so `id > boundary` is exactly that set. Prune in place: this is the INSTANT path, and the
      // authoritative-reconcile branch of `mergeNativeMessages` is the backstop for a missed event.
      // The "before everything" sentinel `msg_` (reverting the first prompt) sorts before every real
      // id, so `id > "msg_"` matches ALL messages and the whole transcript clears — no special case.
      const boundary = event.data.messageID
      for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.id > boundary) messages.splice(i, 1)
      break
    }
    // `revert.staged` / `revert.cleared` don't change the transcript (staged is a reversible
    // file/preview op) — they stay no-ops here, folded into the session row instead.
  }
}

// ── Merging fetched history pages into the live store ──────────────────────────

/** Creation time in epoch millis, tolerating both the wire number and a decoded DateTime carrier. */
function messageCreatedAt(message: SessionMessage): number | undefined {
  const created = (message as { time?: { created?: unknown } }).time?.created
  return Timestamp.toEpochMillis(created)
}

export function isInFlightAssistant(message: SessionMessage): boolean {
  return (
    message.type === "assistant" &&
    (!message.time?.completed ||
      message.content.some(
        (part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
      ))
  )
}

/**
 * Oldest-first order: **the durable sequence**, then acceptance time, then id.
 *
 * ⚠️ **This used to sort on `time.created` alone, and `created` is not the order.** A prompt queued
 * behind a running turn is accepted before the answer it waits behind, and a spawned session's task
 * prompt can carry a `created` from days earlier — so the transcript rendered an answered prompt as
 * unanswered and folded its answer under the NEXT prompt (measured 2026-08-11 over this store: 7 of
 * 299 multi-message sessions came out in the wrong order, both shapes present). The server has
 * always read by `seq`; the client threw that order away and reconstructed a different one.
 *
 * ⚠️ Its old doc comment claimed to match `server-session.ts`'s `cmpMessage`. **No such function
 * exists** — it had been claiming agreement with deleted code, which is how a comparator drifts from
 * the order it is supposed to mirror without anything failing.
 *
 * **An unsequenced message sorts LAST, and that is correct rather than a fallback.** No `seq` means
 * the message has not been through the aggregate yet — a streaming assistant, an optimistic user
 * bubble — and a message that has not been persisted is by definition the newest thing in the list.
 * Sorting it by `created` against sequenced neighbours is what would be a guess.
 */
const sequenceOf = (message: SessionMessage): number => message.seq ?? Number.MAX_SAFE_INTEGER

function compareOldestFirst(a: SessionMessage, b: SessionMessage): number {
  return (
    sequenceOf(a) - sequenceOf(b) ||
    (a.time?.created ?? 0) - (b.time?.created ?? 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

/** Structural equality for wire messages, whose values are JSON and therefore acyclic. */
function sameWireValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((value, index) => sameWireValue(value, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => Object.hasOwn(right, key) && sameWireValue(left[key], right[key]))
}

/**
 * Merge a fetched native history page into the current live-folded list (both
 * oldest-first), returning a new sorted array. Used to bootstrap, page older history,
 * and reconcile after a reconnect — `applySessionNextEvent` handles the live stream
 * between merges.
 *
 * Rule: the fetched page is authoritative for the settled messages it contains, but a
 * `current` entry is kept when it is (a) the live **in-flight assistant** — its streamed
 * content is ahead of the last-persisted fetched copy, so fetched would clobber live
 * deltas — or (b) absent from the page (an in-flight tail the snapshot predates, or an
 * older page not re-fetched). Result is sorted oldest-first.
 *
 * Exception to (a): when the FETCHED copy is a **completed** assistant, it wins even over
 * an in-flight `current` — the server saying "this turn ended" means the live copy is not
 * ahead, it is *stale* (the stream dropped events mid-turn: missed `reasoning.ended` /
 * `step.ended` would otherwise pin a forever-"streaming" message that no later reconcile
 * can heal, e.g. a reasoning fold stuck open/pulsing after an SSE flap).
 *
 * Server-side DELETIONS: an authoritative (no-cursor) fetch may drop a `current` row the
 * server no longer has, bounded by the page range and `asOf` — see those options. This is
 * the backstop for a missed `revert.committed`; the live fold below is the instant path.
 */
export function mergeNativeMessages(
  current: SessionMessage[],
  fetched: SessionMessage[],
  options?: {
    /**
     * True when `fetched` is a full reconcile of the newest page (no cursor), which makes it AUTHORITATIVE
     * about what exists inside the range it covers. Without this the merge is a pure union, so any row the
     * client holds that the server has DELETED is resurrected forever: miss one `revert.committed` (an SSE
     * reconnect, a backgrounded tab, a revert performed on another device) and the reverted messages never
     * go away — not even on a fresh load. Paged loads pass false, since a page says nothing about the rows
     * outside it.
     */
    authoritative?: boolean
    /**
     * When the fetch was ISSUED (epoch millis). The response reflects server state at that moment, which is
     * what separates the two reasons a local row can be missing from it: created BEFORE the fetch and absent
     * ⇒ the server deleted it; created AFTER ⇒ it simply arrived too late to be included. Without this the
     * two are indistinguishable, since a reverted tail and a freshly-streamed message both sit above the
     * newest fetched id.
     */
    asOf?: number
  },
): SessionMessage[] {
  const byId = new Map<string, SessionMessage>()
  for (const message of fetched) byId.set(message.id, message)
  // The id range this fetch actually covers. Ids ascend, so anything outside it was simply not requested.
  let lowest: string | undefined
  let highest: string | undefined
  for (const message of fetched) {
    if (lowest === undefined || message.id < lowest) lowest = message.id
    if (highest === undefined || message.id > highest) highest = message.id
  }
  for (const message of current) {
    const fetchedCopy = byId.get(message.id)
    if (fetchedCopy) {
      // A mount/reconnect refresh commonly returns the exact rows already on screen. Preserve their
      // identities: Solid keys transcript turns by the message objects, so replacing equal wire data
      // tears down and rebuilds the whole chat for no semantic change, collapsing its scroll box.
      if (sameWireValue(message, fetchedCopy)) {
        byId.set(message.id, message)
        continue
      }
      // Keep our streaming copy while the server's is still incomplete, else take the server's.
      // Settlement is monotonic too: a response captured before the turn ended must not replace a
      // completed current assistant after a newer live event or fetch has settled it. This is the
      // lower-level backstop for callers whose overlapping fetches cannot be fenced together.
      const fetchedCompleted = fetchedCopy.type === "assistant" && !!fetchedCopy.time?.completed
      const currentCompleted =
        message.type === "assistant" && !!message.time?.completed && !isInFlightAssistant(message)
      if ((isInFlightAssistant(message) || currentCompleted) && !fetchedCompleted) byId.set(message.id, message)
      continue
    }
    // Absent from the fetch. An in-flight assistant simply has not been persisted yet — always keep it.
    if (isInFlightAssistant(message) || options === undefined || options.authoritative !== true) {
      byId.set(message.id, message)
      continue
    }
    // Drop it only if this fetch actually covered it. Two bounds, and both matter:
    //  · not OLDER than the page (a limited newest-page fetch says nothing about earlier history), and
    //  · created no later than the fetch itself (anything newer may just have missed the response).
    // An EMPTY authoritative fetch has no lower bound and means the session is empty — a full revert.
    const withinPage = lowest === undefined || message.id >= lowest
    const created = messageCreatedAt(message)
    const predatesFetch = options.asOf === undefined || created === undefined || created <= options.asOf
    if (!(withinPage && predatesFetch)) byId.set(message.id, message)
  }
  return [...byId.values()].sort(compareOldestFirst)
}

/**
 * Queued rows that are NOT already in the transcript.
 *
 * ⚠️ **The duplicate the owner saw on a packaged build (2026-08-11):** the first "hi" of a session
 * rendered TWICE — once as the accepted user message, once as a "Queued" bubble — and the queued
 * copy vanished a moment later. Two independent lists reach the transcript and nothing reconciled
 * them: `messages` (which carries the optimistic row the instant Enter is pressed) and `pending`
 * (polled every 2 s from the server's admitted-but-unstarted set). The FIRST prompt of a session is
 * admitted with `delivery: "queue"` and sits there until the runner picks it up, so for that window
 * both lists legitimately hold the same prompt.
 *
 * The id makes it decidable rather than a heuristic: the client generates the message id and sends it
 * as `prompt({id})`, so the server's echo and its pending row carry the SAME id (see
 * `message-v2-store.ts`'s note on optimistic sends). Matching on text or timestamp would be a guess;
 * matching on id is the identity the two lists already share.
 *
 * The transcript wins because it is the richer render — the queued bubble is a stand-in for a message
 * that is not on screen yet, and once the message IS on screen the stand-in is noise.
 */
export function unqueuedPending<P extends { readonly id: string }>(
  pending: readonly P[] | undefined,
  messages: readonly { readonly id: string }[],
): readonly P[] {
  if (!pending || pending.length === 0) return []
  const shown = new Set(messages.map((message) => message.id))
  return pending.filter((item) => !shown.has(item.id))
}
