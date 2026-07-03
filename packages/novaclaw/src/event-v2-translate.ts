// Pure translator: V2 `session.next.*` events -> legacy v1 event envelopes.
//
// This MIRRORS the proven canonical fold in
// `@novaclaw/core/session/message-updater` (which projects each
// `session.next.*` event into a V2 SessionMessage draft). Instead of mutating a
// draft, this projects each event into the v1 legacy event vocabulary
// (`message.updated`, `message.part.updated`, `message.part.delta`) so the
// existing desktop + CLI clients render V2 sessions with NO client rewrite.
//
// The per-event switch structure and state transitions are kept aligned with
// message-updater: step.started creates the assistant, step.ended finalizes it
// (cost/tokens/finish/time.completed), text/reasoning stream into parts, and the
// tool lifecycle (input.started -> called -> success|failed) walks a ToolPart
// through pending -> running -> completed|error.
//
// Events that message-updater treats as `Effect.void`, or that have no v1
// streaming target (moved, prompt.admitted, retried, compaction.*, revert.*,
// agent.switched, model.switched, tool.input.delta, tool.progress, shell.*,
// context.updated, synthetic), translate to `[]` (drop). We do NOT
// invent mappings for those. `prompted` is the exception: it projects the
// user's own message (row + text/file parts) so legacy clients render it.
//
// HARD CONSTRAINT: we never synthesize a turn-terminal / idle / session.status
// envelope from step.ended. step.ended fires once per provider step (a
// tool-using turn emits N of them inside the runner's continuation loop), so it
// only finalizes the assistant Info row — turn completion is the handler
// increment's job, out of scope here.

import { DateTime } from "effect"
import { SessionV1 } from "@novaclaw/schema/session-v1"
import type { LLM } from "@novaclaw/schema/llm"
import type { Model } from "@novaclaw/schema/model"
import type { Provider } from "@novaclaw/schema/provider"
import type { SessionID } from "@novaclaw/schema/session-id"

export type LegacyEnvelope = { type: string; properties: unknown }

// Deterministic part ids for a user prompt's projected parts (F0). Both the live
// `prompted` projection below AND the stored-history fetch mapper
// (session/message-v2-native.ts) derive the SAME ids from the message id, so a
// fetch overlapping the live stream collapses into one part instead of
// duplicating the user bubble. (Previously the live path minted random
// PartID.ascending() ids — non-deterministic per translator instance, which
// multiplied user bubbles when more than one bridge instance was alive.)
export const userTextPartID = (messageID: string): SessionV1.PartID => `${messageID}-text` as SessionV1.PartID
export const userFilePartID = (messageID: string, index: number): SessionV1.PartID =>
  `${messageID}-file-${index}` as SessionV1.PartID

// The event delivered to the bridge `listen` callback. We type it structurally
// (rather than depend on the bridge's exact Payload import) so the translator
// stays a pure, dependency-light function. `data` is the decoded event payload
// (the Schema.Type form), so `timestamp` is a DateTime.Utc, not a number.
export type BridgeEvent = {
  readonly type: string
  readonly data: Record<string, any>
}

// V2 timestamps arrive decoded as DateTime.Utc (DateTimeUtcFromMillis decodes
// Finite -> DateTime). v1 time fields are plain epoch millis. Tolerate a raw
// number too (defensive + convenient for tests).
function toMillis(timestamp: unknown): number {
  if (typeof timestamp === "number") return timestamp
  if (DateTime.isDateTime(timestamp)) return DateTime.toEpochMillis(timestamp)
  return 0
}

// Flatten V2 ToolContent[] into a single legacy `output` string by joining the
// text-typed entries. (File-typed entries carry no inline text.) This mirrors
// the role the legacy `ToolStateCompleted.output` plays: a flat rendered blob.
// Exported: the stored-history mapper (session/message-v2-native.ts) must
// flatten identically or a mid-turn fetch renders different output than live.
export function flattenContent(content: ReadonlyArray<LLM.ToolContent> | undefined): string {
  if (!content) return ""
  return content
    .filter((item): item is Extract<LLM.ToolContent, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("")
}

// V2 UnknownError is `{ type: "unknown", message }`. Be defensive and also
// accept `{ data: { message } }` / `{ message }` shapes. Never return the object.
export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const e = error as { message?: unknown; data?: { message?: unknown } }
    if (typeof e.message === "string") return e.message
    if (e.data && typeof e.data.message === "string") return e.data.message
  }
  return "unknown error"
}

type ToolEntry = {
  partID: SessionV1.PartID
  tool: string
  // raw input string captured from tool.input.ended (pending phase)
  raw: string
  // structured input object captured from tool.called (running phase)
  input: Record<string, unknown>
  timeStart: number
}

type SessionState = {
  // The currently-owned assistant message identity. message-updater resumes the
  // latest incomplete assistant; here each step.started (re)sets the owned id.
  assistantMessageID?: SessionV1.MessageID
  // The user message id of the in-flight turn, captured from `prompted`. Used as
  // the assistant rows' parentID so the desktop links them to the user turn
  // (matches legacy `parentID: lastUser.id`). Multiple `prompted` per turn
  // (steer/queue) is possible -> this holds the LAST one, the intended grouping.
  userMessageID?: SessionV1.MessageID
  // Stable legacy PartID per V2 textID / reasoningID.
  textParts: Map<string, SessionV1.PartID>
  reasoningParts: Map<string, SessionV1.PartID>
  // Per callID tool bookkeeping (partID, tool name, captured input, start time).
  tools: Map<string, ToolEntry>
}

function freshSession(): SessionState {
  return {
    assistantMessageID: undefined,
    userMessageID: undefined,
    textParts: new Map(),
    reasoningParts: new Map(),
    tools: new Map(),
  }
}

export function createTranslator() {
  // One translator instance is keyed per sessionID by the bridge, but we still
  // key state by sessionID internally so an instance is robust if fed >1 session.
  const sessions = new Map<string, SessionState>()
  const stateFor = (sessionID: string): SessionState => {
    let state = sessions.get(sessionID)
    if (!state) {
      state = freshSession()
      sessions.set(sessionID, state)
    }
    return state
  }

  // Reuse the V2 stream id (textID/reasoningID/callID) VERBATIM as the legacy part
  // id. The V2 store persists each content part under this same id (message-updater:
  // `id: event.data.textID`) and the desktop's `client.session.messages` fetch returns
  // it unchanged, so emitting the SAME id here collapses the live-translated part and
  // the fetched part into ONE (the client dedups parts by id) instead of rendering the
  // assistant text twice. Previously we minted a random `prt_…`, which never matched
  // the fetched id → two parts → duplicate bubble. The V2 id is not "prt"-prefixed, so
  // parts below are built STRUCTURALLY (not via `*.make`, whose brand check rejects a
  // non-"prt" id); the client stores non-"prt" fetched ids the same way, so this is safe.
  const textPartID = (_state: SessionState, textID: string): SessionV1.PartID => textID as SessionV1.PartID

  const reasoningPartID = (_state: SessionState, reasoningID: string): SessionV1.PartID =>
    reasoningID as SessionV1.PartID

  // Build the v1 Assistant Info row. step.started supplies zeroed cost/tokens;
  // step.ended/step.failed override via the `extra` overlay.
  const assistantInfo = (input: {
    sessionID: string
    messageID: SessionV1.MessageID
    parentID?: SessionV1.MessageID
    agent: string
    model: { id: string; providerID: string; variant?: string }
    created: number
    completed?: number
    cost?: number
    tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    finish?: string
    error?: { name: "UnknownError"; data: { message: string } }
  }) =>
    SessionV1.Assistant.make({
      id: input.messageID,
      sessionID: input.sessionID as SessionID,
      role: "assistant",
      // Group the assistant row under the in-flight user turn so the desktop's
      // `assistantMessagesByParent` links it to the user message (the red Error
      // card only renders for rows parented to the user). Falls back to the
      // message's own id (a safe, schema-valid default) when no `prompted` was
      // seen yet, preserving prior behavior.
      parentID: input.parentID ?? input.messageID,
      modelID: input.model.id as Model.ID,
      providerID: input.model.providerID as Provider.ID,
      mode: input.agent,
      agent: input.agent,
      path: { cwd: "", root: "" },
      cost: input.cost ?? 0,
      tokens: input.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: {
        created: input.created,
        ...(input.completed !== undefined ? { completed: input.completed } : {}),
      },
      ...(input.model.variant !== undefined ? { variant: input.model.variant } : {}),
      ...(input.finish !== undefined ? { finish: input.finish } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    } as Parameters<typeof SessionV1.Assistant.make>[0])

  // Build the v1 User Info row from a V2 `prompted` event. The V2 event carries
  // no agent/model (those live on the session, not the prompt), so we default
  // them to empty — exactly like step.ended defaults a model-less assistant.
  // The desktop/CLI reducers key a user message by id + render its text/file
  // parts; they do not read agent/model off a user row, so empty is safe.
  const userInfo = (input: {
    sessionID: string
    messageID: SessionV1.MessageID
    created: number
  }): SessionV1.Info =>
    SessionV1.User.make({
      id: input.messageID,
      sessionID: input.sessionID as SessionID,
      role: "user",
      time: { created: input.created },
      agent: "",
      model: { providerID: "" as Provider.ID, modelID: "" as Model.ID },
    } as Parameters<typeof SessionV1.User.make>[0]) as SessionV1.Info

  const messageUpdated = (info: SessionV1.Info): LegacyEnvelope => ({
    type: SessionV1.Event.MessageUpdated.type,
    properties: { sessionID: info.sessionID, info },
  })

  // `.make()` returns the schema's (deeply-readonly) decoded Type, which doesn't
  // structurally match the exported mutable `SessionV1.Part`. The part is already
  // schema-validated at construction; here it only needs to flow into the
  // envelope's `unknown` properties, so accept the constructor's return type.
  type AnyPart =
    | ReturnType<typeof SessionV1.TextPart.make>
    | ReturnType<typeof SessionV1.ReasoningPart.make>
    | ReturnType<typeof SessionV1.ToolPart.make>
    | ReturnType<typeof SessionV1.FilePart.make>
  const partUpdated = (sessionID: string, part: AnyPart, time: number): LegacyEnvelope => ({
    type: SessionV1.Event.PartUpdated.type,
    properties: { sessionID, part, time },
  })

  const partDelta = (input: {
    sessionID: string
    messageID: SessionV1.MessageID
    partID: SessionV1.PartID
    delta: string
  }): LegacyEnvelope => ({
    type: SessionV1.PartDelta.type,
    properties: {
      sessionID: input.sessionID,
      messageID: input.messageID,
      partID: input.partID,
      field: "text",
      delta: input.delta,
    },
  })

  const translate = (event: BridgeEvent): LegacyEnvelope[] => {
    const type = event.type
    const data = event.data
    if (typeof data?.sessionID !== "string") return []
    const sessionID: string = data.sessionID
    const state = stateFor(sessionID)

    switch (type) {
      // --- step lifecycle ----------------------------------------------------
      case "session.next.step.started": {
        const messageID = data.assistantMessageID as SessionV1.MessageID
        state.assistantMessageID = messageID
        const created = toMillis(data.timestamp)
        const info = assistantInfo({
          sessionID,
          messageID,
          parentID: state.userMessageID,
          agent: data.agent,
          model: data.model,
          created,
        })
        // Ordering: the assistant role row MUST precede any part events for it.
        return [messageUpdated(info)]
      }

      case "session.next.step.ended": {
        const messageID = data.assistantMessageID as SessionV1.MessageID
        const completed = toMillis(data.timestamp)
        // Finalize ONLY the assistant Info row (cost/tokens/finish/time.completed).
        // NOT a turn terminal: step.ended fires once per provider step.
        const info = assistantInfo({
          sessionID,
          messageID,
          parentID: state.userMessageID,
          agent: data.agent ?? "",
          model: data.model ?? { id: "", providerID: "" },
          created: completed,
          completed,
          cost: data.cost,
          tokens: data.tokens,
          finish: data.finish,
        })
        return [messageUpdated(info)]
      }

      case "session.next.step.failed": {
        const messageID = data.assistantMessageID as SessionV1.MessageID
        const completed = toMillis(data.timestamp)
        const info = assistantInfo({
          sessionID,
          messageID,
          parentID: state.userMessageID,
          agent: data.agent ?? "",
          model: data.model ?? { id: "", providerID: "" },
          created: completed,
          completed,
          finish: "error",
          error: { name: "UnknownError", data: { message: errorMessage(data.error) } },
        })
        return [messageUpdated(info)]
      }

      // --- text streaming ----------------------------------------------------
      case "session.next.text.started": {
        const messageID = (state.assistantMessageID ?? data.assistantMessageID) as SessionV1.MessageID
        const partID = textPartID(state, data.textID)
        const start = toMillis(data.timestamp)
        // Create the (empty) text part BEFORE any delta references it. Both
        // reducers require the part to exist before a delta lands.
        const part = {
          id: partID,
          sessionID: sessionID as SessionID,
          messageID,
          type: "text",
          text: "",
          time: { start },
        } as unknown as ReturnType<typeof SessionV1.TextPart.make>
        return [partUpdated(sessionID, part, start)]
      }

      case "session.next.text.delta": {
        const messageID = (state.assistantMessageID ?? data.assistantMessageID) as SessionV1.MessageID
        const partID = textPartID(state, data.textID)
        return [partDelta({ sessionID, messageID, partID, delta: data.delta })]
      }

      case "session.next.text.ended": {
        const messageID = (state.assistantMessageID ?? data.assistantMessageID) as SessionV1.MessageID
        const partID = textPartID(state, data.textID)
        const end = toMillis(data.timestamp)
        // Re-emit the full part with final text + time.end (the replayable boundary).
        const part = {
          id: partID,
          sessionID: sessionID as SessionID,
          messageID,
          type: "text",
          text: data.text,
          time: { start: end, end },
        } as unknown as ReturnType<typeof SessionV1.TextPart.make>
        return [partUpdated(sessionID, part, end)]
      }

      // --- reasoning streaming ----------------------------------------------
      case "session.next.reasoning.started": {
        const messageID = (state.assistantMessageID ?? data.assistantMessageID) as SessionV1.MessageID
        const partID = reasoningPartID(state, data.reasoningID)
        const start = toMillis(data.timestamp)
        const part = {
          id: partID,
          sessionID: sessionID as SessionID,
          messageID,
          type: "reasoning",
          text: "",
          time: { start },
        } as unknown as ReturnType<typeof SessionV1.ReasoningPart.make>
        return [partUpdated(sessionID, part, start)]
      }

      case "session.next.reasoning.delta": {
        const messageID = (state.assistantMessageID ?? data.assistantMessageID) as SessionV1.MessageID
        const partID = reasoningPartID(state, data.reasoningID)
        return [partDelta({ sessionID, messageID, partID, delta: data.delta })]
      }

      case "session.next.reasoning.ended": {
        const messageID = (state.assistantMessageID ?? data.assistantMessageID) as SessionV1.MessageID
        const partID = reasoningPartID(state, data.reasoningID)
        const end = toMillis(data.timestamp)
        const part = {
          id: partID,
          sessionID: sessionID as SessionID,
          messageID,
          type: "reasoning",
          text: data.text,
          time: { start: end, end },
        } as unknown as ReturnType<typeof SessionV1.ReasoningPart.make>
        return [partUpdated(sessionID, part, end)]
      }

      // --- tool lifecycle ----------------------------------------------------
      case "session.next.tool.input.started": {
        const messageID = (state.assistantMessageID ?? data.assistantMessageID) as SessionV1.MessageID
        const callID = data.callID as string
        const start = toMillis(data.timestamp)
        let entry = state.tools.get(callID)
        if (!entry) {
          entry = {
            partID: callID as SessionV1.PartID,
            tool: data.name,
            raw: "",
            input: {},
            timeStart: start,
          }
          state.tools.set(callID, entry)
        } else {
          entry.tool = data.name
          entry.timeStart = start
        }
        const part = {
          id: entry.partID,
          sessionID: sessionID as SessionID,
          messageID,
          type: "tool",
          callID,
          tool: entry.tool,
          state: SessionV1.ToolStatePending.make({ status: "pending", input: {}, raw: "" }),
        } as unknown as ReturnType<typeof SessionV1.ToolPart.make>
        return [partUpdated(sessionID, part, start)]
      }

      case "session.next.tool.input.ended": {
        // message-updater records the raw input on the pending state. We stash
        // it and surface it on the next ToolPart we emit (running/completed).
        const entry = state.tools.get(data.callID as string)
        if (entry) entry.raw = data.text
        return []
      }

      case "session.next.tool.called": {
        const messageID = (state.assistantMessageID ?? data.assistantMessageID) as SessionV1.MessageID
        const callID = data.callID as string
        const time = toMillis(data.timestamp)
        let entry = state.tools.get(callID)
        if (!entry) {
          // tool.called without a prior input.started: synthesize an entry so
          // every ToolPart still carries a stable partID + tool name.
          entry = {
            partID: callID as SessionV1.PartID,
            tool: data.tool,
            raw: "",
            input: {},
            timeStart: time,
          }
          state.tools.set(callID, entry)
        }
        entry.tool = data.tool
        entry.input = data.input ?? {}
        const part = {
          id: entry.partID,
          sessionID: sessionID as SessionID,
          messageID,
          type: "tool",
          callID,
          tool: entry.tool,
          state: SessionV1.ToolStateRunning.make({
            status: "running",
            input: entry.input,
            time: { start: entry.timeStart || time },
          }),
        } as unknown as ReturnType<typeof SessionV1.ToolPart.make>
        return [partUpdated(sessionID, part, time)]
      }

      case "session.next.tool.success": {
        const messageID = (state.assistantMessageID ?? data.assistantMessageID) as SessionV1.MessageID
        const callID = data.callID as string
        const time = toMillis(data.timestamp)
        const entry = state.tools.get(callID)
        const partID = entry?.partID ?? (callID as SessionV1.PartID)
        const tool = entry?.tool ?? "unknown"
        const output = flattenContent(data.content)
        const part = {
          id: partID,
          sessionID: sessionID as SessionID,
          messageID,
          type: "tool",
          callID,
          tool,
          state: SessionV1.ToolStateCompleted.make({
            status: "completed",
            input: entry?.input ?? {},
            output,
            // V2 carries no title; default to the tool name (v1-acceptable).
            title: tool,
            metadata: {},
            time: { start: entry?.timeStart || time, end: time },
          }),
        } as unknown as ReturnType<typeof SessionV1.ToolPart.make>
        return [partUpdated(sessionID, part, time)]
      }

      case "session.next.tool.failed": {
        const messageID = (state.assistantMessageID ?? data.assistantMessageID) as SessionV1.MessageID
        const callID = data.callID as string
        const time = toMillis(data.timestamp)
        const entry = state.tools.get(callID)
        const partID = entry?.partID ?? (callID as SessionV1.PartID)
        const tool = entry?.tool ?? "unknown"
        const part = {
          id: partID,
          sessionID: sessionID as SessionID,
          messageID,
          type: "tool",
          callID,
          tool,
          state: SessionV1.ToolStateError.make({
            status: "error",
            input: entry?.input ?? {},
            // Extract a flat string; never pass the V2 error object.
            error: errorMessage(data.error),
            time: { start: entry?.timeStart || time, end: time },
          }),
        } as unknown as ReturnType<typeof SessionV1.ToolPart.make>
        return [partUpdated(sessionID, part, time)]
      }

      // --- user prompt -------------------------------------------------------
      // The user's own message. message-updater builds a SessionMessage.User
      // from this same event (text/files/agents). Here we project it into the
      // v1 user row + its text part (+ file parts) so legacy clients render the
      // prompt the user typed. Only `prompted` creates the row; `prompt.admitted`
      // stays a drop (it precedes promotion and carries no renderable identity).
      case "session.next.prompted": {
        const messageID = data.messageID as SessionV1.MessageID
        // Capture the in-flight turn's user message id so the assistant rows
        // (step.started/ended/failed) group under it. Last `prompted` wins.
        state.userMessageID = messageID
        const created = toMillis(data.timestamp)
        const prompt = (data.prompt ?? {}) as {
          text?: string
          files?: ReadonlyArray<{ uri: string; mime?: string; name?: string; filename?: string }>
        }
        const out: LegacyEnvelope[] = [messageUpdated(userInfo({ sessionID, messageID, created }))]
        // The text part. Always emit it (even empty) so the user row has a
        // renderable body and an ordering anchor, matching the assistant path
        // where the role row precedes its parts. Deterministic id (not a minted
        // prt_… id): the stored-history fetch derives the same one, and every
        // translator instance agrees, so re-delivery cannot duplicate the bubble.
        // Built structurally — the id is not "prt"-prefixed (same rationale as
        // textPartID above).
        const textPart = {
          id: userTextPartID(messageID),
          sessionID: sessionID as SessionID,
          messageID,
          type: "text",
          text: prompt.text ?? "",
          time: { start: created, end: created },
        } as unknown as ReturnType<typeof SessionV1.TextPart.make>
        out.push(partUpdated(sessionID, textPart, created))
        // File attachments, if any. V2 FileAttachment is {uri, mime, name?};
        // v1 FilePart is {url, mime, filename?}.
        let fileIndex = 0
        for (const file of prompt.files ?? []) {
          const filePart = {
            id: userFilePartID(messageID, fileIndex++),
            sessionID: sessionID as SessionID,
            messageID,
            type: "file",
            mime: file.mime ?? "application/octet-stream",
            url: file.uri,
            ...(file.name ?? file.filename ? { filename: file.name ?? file.filename } : {}),
          } as unknown as ReturnType<typeof SessionV1.FilePart.make>
          out.push(partUpdated(sessionID, filePart, created))
        }
        return out
      }

      // --- dropped: no v1 streaming target (mirrors message-updater Effect.void
      //     handlers + the live-only/structural events) -------------------------
      // session.next.moved, prompt.admitted, retried, compaction.*, revert.*,
      // agent.switched, model.switched, tool.input.delta, tool.progress,
      // shell.started, shell.ended, context.updated, synthetic
      default:
        return []
    }
  }

  return { translate }
}

export * as EventV2Translate from "./event-v2-translate"
