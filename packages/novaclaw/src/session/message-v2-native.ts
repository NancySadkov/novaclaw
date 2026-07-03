// F0: project STORED V2-native session history (`session_message` rows) into the
// legacy v1 `WithParts` shape the unchanged web/desktop/CLI clients fetch through
// `GET /session/:id/message`. Without this, a V2 session's transcript is invisible
// after a reload: V2 turns persist only to SessionMessageTable (core projector),
// while MessageV2.page reads the disjoint legacy Message/Part tables.
//
// This module MIRRORS the live translator (`event-v2-translate.ts`) — same part
// ids (V2 content ids verbatim; deterministic `${messageID}-text` for user
// prompts), same tool-state shaping, same content flattening — so a fetch that
// overlaps live streaming collapses into the SAME parts (the client dedups by
// id) instead of duplicating bubbles. Change one side only with the other in view.
//
// Rows are mapped from their RAW ENCODED form (`row.data` as written by the core
// projector: times are epoch millis, model is {providerID, id}), NOT schema-decoded
// — decode would produce DateTime objects we would immediately convert back.
//
// Dropped row types (agent-switched, model-switched, shell, synthetic, system,
// compaction) mirror the live translator's dropped events: no v1 rendering target.

import { SessionV1 } from "@novaclaw/schema/session-v1"
import type { SessionID } from "@novaclaw/schema/session-id"
import { errorMessage, flattenContent, userFilePartID, userTextPartID, v2PartID } from "@/event-v2-translate"
import type { WithParts } from "@novaclaw/core/v1/session"

// Raw encoded shapes as stored in session_message.data (id/type live on the row).
type RawToolState =
  | { status: "pending"; input: string }
  | { status: "running"; input: Record<string, unknown>; content?: unknown[]; structured?: Record<string, unknown> }
  | {
      status: "completed"
      input: Record<string, unknown>
      content?: unknown[]
      structured?: Record<string, unknown>
      result?: unknown
    }
  | {
      status: "error"
      input: Record<string, unknown>
      content?: unknown[]
      structured?: Record<string, unknown>
      error?: { type: "unknown"; message: string }
    }

type RawContent =
  | { type: "text"; id: string; text: string }
  | { type: "reasoning"; id: string; text: string; time?: { created: number; completed?: number } }
  | {
      type: "tool"
      id: string
      name: string
      state: RawToolState
      time: { created: number; ran?: number; completed?: number }
    }

export interface RawNativeRow {
  readonly id: string
  readonly type: string
  readonly time_created: number
  readonly data: Record<string, unknown>
}

const toolState = (raw: RawToolState, name: string, time: { created: number; ran?: number; completed?: number }) => {
  const start = time.ran ?? time.created
  switch (raw.status) {
    case "pending":
      return SessionV1.ToolStatePending.make({ status: "pending", input: {}, raw: raw.input })
    case "running":
      return SessionV1.ToolStateRunning.make({ status: "running", input: raw.input, time: { start } })
    case "completed":
      return SessionV1.ToolStateCompleted.make({
        status: "completed",
        input: raw.input,
        output: flattenContent(raw.content as Parameters<typeof flattenContent>[0]),
        // V2 carries no title; default to the tool name (matches the live translator).
        title: name,
        metadata: {},
        time: { start, end: time.completed ?? start },
      })
    case "error":
      return SessionV1.ToolStateError.make({
        status: "error",
        input: raw.input,
        error: errorMessage(raw.error),
        time: { start, end: time.completed ?? start },
      })
  }
}

/**
 * Map raw session_message rows (ANY order) into v1 WithParts, ASCENDING by
 * time_created (ties by id — the projector stamps monotonic ids). Assistant rows
 * are parented to the closest preceding user row, mirroring the live translator's
 * `state.userMessageID` grouping.
 */
export function nativeWithParts(rows: readonly RawNativeRow[], sessionID: string): WithParts[] {
  const ordered = [...rows].sort((a, b) =>
    a.time_created === b.time_created ? (a.id < b.id ? -1 : 1) : a.time_created - b.time_created,
  )
  const out: WithParts[] = []
  let lastUserID: string | undefined
  for (const row of ordered) {
    if (row.type === "user") {
      lastUserID = row.id
      out.push(userWithParts(row, sessionID))
      continue
    }
    if (row.type === "assistant") {
      out.push(assistantWithParts(row, sessionID, lastUserID))
      continue
    }
    // agent-switched / model-switched / shell / synthetic / system / compaction:
    // no v1 rendering target (mirrors the live translator's drops).
  }
  return out
}

function userWithParts(row: RawNativeRow, sessionID: string): WithParts {
  const data = row.data as {
    text?: string
    files?: ReadonlyArray<{ uri: string; mime?: string; name?: string; filename?: string }>
    time?: { created?: number }
  }
  const created = data.time?.created ?? row.time_created
  const info = {
    id: row.id,
    sessionID: sessionID as SessionID,
    role: "user",
    time: { created },
    agent: "",
    model: { providerID: "", modelID: "" },
  } as unknown as SessionV1.Info
  const parts: unknown[] = [
    {
      id: userTextPartID(row.id),
      sessionID,
      messageID: row.id,
      type: "text",
      text: data.text ?? "",
      time: { start: created, end: created },
    },
  ]
  let fileIndex = 0
  for (const file of data.files ?? []) {
    parts.push({
      id: userFilePartID(row.id, fileIndex++),
      sessionID,
      messageID: row.id,
      type: "file",
      mime: file.mime ?? "application/octet-stream",
      url: file.uri,
      ...(file.name ?? file.filename ? { filename: file.name ?? file.filename } : {}),
    })
  }
  return { info, parts: parts as WithParts["parts"] }
}

function assistantWithParts(row: RawNativeRow, sessionID: string, parentID: string | undefined): WithParts {
  const data = row.data as {
    agent?: string
    model?: { id?: string; providerID?: string; variant?: string }
    content?: RawContent[]
    finish?: string
    cost?: number
    tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    error?: { type: "unknown"; message: string }
    time?: { created?: number; completed?: number }
  }
  const created = data.time?.created ?? row.time_created
  const completed = data.time?.completed
  const info = {
    id: row.id,
    sessionID: sessionID as SessionID,
    role: "assistant",
    parentID: parentID ?? row.id,
    modelID: data.model?.id ?? "",
    providerID: data.model?.providerID ?? "",
    mode: data.agent ?? "",
    agent: data.agent ?? "",
    path: { cwd: "", root: "" },
    cost: data.cost ?? 0,
    tokens: data.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created, ...(completed !== undefined ? { completed } : {}) },
    ...(data.model?.variant !== undefined ? { variant: data.model.variant } : {}),
    ...(data.finish !== undefined ? { finish: data.finish } : {}),
    ...(data.error !== undefined
      ? { error: { name: "UnknownError", data: { message: errorMessage(data.error) } } }
      : {}),
  } as unknown as SessionV1.Info
  const parts: unknown[] = []
  for (const content of data.content ?? []) {
    if (content.type === "text") {
      parts.push({
        id: v2PartID(content.id),
        sessionID,
        messageID: row.id,
        type: "text",
        text: content.text,
        time: { start: created, ...(completed !== undefined ? { end: completed } : {}) },
      })
      continue
    }
    if (content.type === "reasoning") {
      const start = content.time?.created ?? created
      const end = content.time?.completed
      parts.push({
        id: v2PartID(content.id),
        sessionID,
        messageID: row.id,
        type: "reasoning",
        text: content.text,
        time: { start, ...(end !== undefined ? { end } : {}) },
      })
      continue
    }
    if (content.type === "tool") {
      parts.push({
        // Part id gets the prt_v2_ derivation (route-schema brand + live parity);
        // callID stays the RAW V2 id — it is a correlation field, not a PartID.
        id: v2PartID(content.id),
        sessionID,
        messageID: row.id,
        type: "tool",
        callID: content.id,
        tool: content.name,
        state: toolState(content.state, content.name, content.time),
      })
    }
  }
  return { info, parts: parts as WithParts["parts"] }
}

export * as MessageV2Native from "./message-v2-native"
