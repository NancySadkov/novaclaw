import type {
  SessionMessage,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionMessageShell,
  V2Event,
} from "@novaclaw/sdk/v2"

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
export function appendMessage(messages: SessionMessage[], item: SessionMessage): void {
  if (messages.some((existing) => existing.id === item.id)) return
  messages.push(item)
}

/** The latest assistant message, returned only while it is still streaming (no `time.completed`). */
export function activeAssistant(messages: SessionMessage[]): SessionMessageAssistant | undefined {
  const item = messages.findLast((message) => message.type === "assistant")
  return item?.type === "assistant" && !item.time.completed ? item : undefined
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
    (item): item is SessionMessageAssistantTool =>
      item.type === "tool" && (callID === undefined || item.id === callID),
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

/**
 * Fold one `session.next.*` event into `messages` (the event's session array).
 * Non-transcript events (`prompt.admitted`, `moved`, `completed`, `retried`,
 * `responder/mode.switched`, `compaction.started`/`delta`, `revert.*`) and non-`session.next`
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
      match.time.completed = event.data.timestamp
      break
    }
    case "session.next.step.started": {
      // Client idempotency: a replayed step.started must not re-complete the active assistant.
      if (messages.some((message) => message.id === event.data.assistantMessageID)) break
      const current = activeAssistant(messages)
      if (current) current.time.completed = event.data.timestamp
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
      assistant.time.completed = event.data.timestamp
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
      assistant.time.completed = event.data.timestamp
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
    case "session.next.tool.input.ended": {
      const match = latestTool(findAssistant(messages, event.data.assistantMessageID), event.data.callID)
      if (match?.state.status === "pending") match.state.input = event.data.text
      break
    }
    case "session.next.tool.called": {
      const match = latestTool(findAssistant(messages, event.data.assistantMessageID), event.data.callID)
      if (!match) break
      match.time.ran = event.data.timestamp
      match.provider = event.data.provider
      match.state = { status: "running", input: event.data.input, structured: {}, content: [] }
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
      match.time.completed = event.data.timestamp
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
      match.time.completed = event.data.timestamp
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
    case "session.next.reasoning.ended": {
      const match = latestReasoning(findAssistant(messages, event.data.assistantMessageID), event.data.reasoningID)
      if (match) {
        match.text = event.data.text
        match.time = { created: match.time?.created ?? event.data.timestamp, completed: event.data.timestamp }
        if (event.data.providerMetadata !== undefined) match.providerMetadata = event.data.providerMetadata
      }
      break
    }
    case "session.next.compaction.ended":
      appendMessage(messages, {
        id: event.data.messageID,
        type: "compaction",
        reason: event.data.reason,
        summary: event.data.text,
        recent: event.data.recent,
        time: { created: event.data.timestamp },
      })
      break
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
  if (typeof created === "number") return created
  if (created instanceof Date) return created.getTime()
  if (typeof created === "object" && created !== null && typeof (created as { epochMillis?: unknown }).epochMillis === "number")
    return (created as { epochMillis: number }).epochMillis
  return undefined
}

function isInFlightAssistant(message: SessionMessage): boolean {
  return message.type === "assistant" && !message.time.completed
}

/** Oldest-first order, matching `server-session.ts` `cmpMessage` (time.created asc, then id asc). */
function compareOldestFirst(a: SessionMessage, b: SessionMessage): number {
  return a.time.created - b.time.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
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
      // Keep our streaming copy while the server's is still incomplete, else take the server's.
      const fetchedCompleted = fetchedCopy.type === "assistant" && !!fetchedCopy.time.completed
      if (isInFlightAssistant(message) && !fetchedCompleted) byId.set(message.id, message)
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
