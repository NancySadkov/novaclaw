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
 * Pure fold of the native V2 `session.next.*` event stream into a flat
 * `SessionMessage[]` — the strategy-B replacement for the V1 `message`/`part`
 * reducer (see `notes/f1e.md` in novaclaw-plan). Ported from the deleted TUI
 * `packages/tui/src/context/data.tsx` (git `caa938453^`), the reference
 * implementation, retyped against the generated `@novaclaw/sdk/v2` client.
 *
 * **Ordering: newest-first** — index 0 is the most recent message. New top-level
 * messages are prepended; an assistant's `content[]` is appended in arrival order.
 * The render layer owns display order.
 *
 * Every function **mutates `messages` (and its nested objects) in place**, so a
 * caller can drive it from inside a solid-js `produce` draft. The module has no
 * runtime dependencies (the type imports are erased) and is unit-testable on plain
 * arrays. Callers route by `event.data.sessionID` and pass that session's array.
 */

/** Insert `item` at the front unless a message with the same id already exists (idempotent → mid-turn-reload safe). */
export function prependMessage(messages: SessionMessage[], item: SessionMessage): void {
  if (messages.some((existing) => existing.id === item.id)) return
  messages.unshift(item)
}

/** The most recent assistant message that has not finished (no `time.completed`). */
export function activeAssistant(messages: SessionMessage[]): SessionMessageAssistant | undefined {
  const item = messages.find((message) => message.type === "assistant" && !message.time.completed)
  return item?.type === "assistant" ? item : undefined
}

/** The assistant message with the given id, if present. */
export function findAssistant(messages: SessionMessage[], messageID: string): SessionMessageAssistant | undefined {
  const item = messages.find((message) => message.type === "assistant" && message.id === messageID)
  return item?.type === "assistant" ? item : undefined
}

/** The shell message for the given callID, if present. */
export function activeShell(messages: SessionMessage[], callID: string): SessionMessageShell | undefined {
  const item = messages.find((message) => message.type === "shell" && message.callID === callID)
  return item?.type === "shell" ? item : undefined
}

/** The last tool part of the active/target assistant (optionally matching a callID). */
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
 * `compaction.started`/`delta`, `revert.*`) and non-`session.next` events are no-ops
 * here — they belong to the session-info / revert stores handled in later F1e slices.
 */
export function applySessionNextEvent(messages: SessionMessage[], event: V2Event): void {
  switch (event.type) {
    case "session.next.agent.switched":
      prependMessage(messages, {
        id: event.data.messageID,
        type: "agent-switched",
        agent: event.data.agent,
        time: { created: event.data.timestamp },
      })
      break
    case "session.next.model.switched":
      prependMessage(messages, {
        id: event.data.messageID,
        type: "model-switched",
        model: event.data.model,
        time: { created: event.data.timestamp },
      })
      break
    case "session.next.prompted":
      prependMessage(messages, {
        id: event.data.messageID,
        type: "user",
        text: event.data.prompt.text,
        files: event.data.prompt.files,
        agents: event.data.prompt.agents,
        time: { created: event.data.timestamp },
      })
      break
    case "session.next.context.updated":
      prependMessage(messages, {
        id: event.data.messageID,
        type: "system",
        text: event.data.text,
        time: { created: event.data.timestamp },
      })
      break
    case "session.next.synthetic":
      prependMessage(messages, {
        id: event.data.messageID,
        type: "synthetic",
        sessionID: event.data.sessionID,
        text: event.data.text,
        time: { created: event.data.timestamp },
      })
      break
    case "session.next.shell.started":
      prependMessage(messages, {
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
      if (messages.some((message) => message.id === event.data.assistantMessageID)) break
      const current = activeAssistant(messages)
      if (current) current.time.completed = event.data.timestamp
      prependMessage(messages, {
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
      if (event.data.snapshot) assistant.snapshot = { ...assistant.snapshot, end: event.data.snapshot }
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
        outputPaths: event.data.outputPaths,
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
        if (event.data.providerMetadata !== undefined) match.providerMetadata = event.data.providerMetadata
      }
      break
    }
    case "session.next.compaction.ended":
      prependMessage(messages, {
        id: event.data.messageID,
        type: "compaction",
        reason: event.data.reason,
        summary: event.data.text,
        recent: event.data.recent,
        time: { created: event.data.timestamp },
      })
      break
  }
}
