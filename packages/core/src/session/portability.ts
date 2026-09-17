export * as SessionPortability from "./portability"

/**
 * SESSION PORTABILITY — read another harness's session export, and write one of ours.
 *
 * 🔴 The goal is to move a transcript between coding agents: another harness's export is imported as
 * a NovaClaw session so work can continue here, and a NovaClaw session can be exported so another
 * harness can read it back.
 *
 * ## Why this module is dependency-free
 *
 * It is imported by BOTH the server handler (which writes the messages) and the app renderer (which
 * builds the export from messages it already holds). So it may not pull `node:*`, a database or a
 * service — only plain types. That is the same discipline `config/local-runtime.ts` follows.
 *
 * ## The shape, and the two dialects
 *
 * The corpus this was written against is a foreign V2 export: `{ info, messages }`, where a message
 * is `{ type: "user" | "assistant" | …, … }` and an assistant carries `content[]` of
 * `{ type: "text" | "reasoning" | "tool", … }`. NovaClaw's own messages are descendants of the same
 * format, so one tolerant reader handles both and the writer emits a superset that round-trips through
 * the reader by construction.
 *
 * ⚠️ **Unknown message/message-part kinds are SKIPPED, not guessed.** A harness that adds a part type
 * we do not model must not turn one unknown part into a malformed assistant message that fails schema
 * validation and loses the whole import. The skip count is returned and reported.
 *
 * ## Encrypted reasoning traces
 *
 * 🔴 Anthropic extended thinking arrives as a reasoning block whose visible `text` is accompanied by an
 * opaque, cryptographically-signed payload (`providerMetadata.anthropic.signature`, and
 * `redactedData` for a redacted block). It is not reasoning we can read, but it is bytes a later
 * re-export MUST preserve verbatim — dropping them turns a legal transcript into one the provider
 * refuses ("thinking blocks cannot be modified"). So the reader copies `providerMetadata` through
 * untouched, and parks every other unrecognised field on the part under `providerMetadata.imported`,
 * where it survives storage without pretending to be reasoning text.
 */

export const FORMAT = "novaclaw-session"
export const VERSION = 1

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined
const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])
const record = (value: unknown): Json => (isRecord(value) ? value : {})
/** `providerMetadata` is `Record<string, Record<string, unknown>>`, so only records may ride it. */
const metadataRecord = (value: unknown): Record<string, Json> =>
  isRecord(value)
    ? Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => (isRecord(entry) ? [[key, entry]] : [])))
    : {}

/** Ids minted for parts an export did not carry one for. Scoped to one import, never persisted as identity. */
const partIds = () => {
  let counter = 0
  return (prefix: string) => `${prefix}_${(counter += 1).toString(36)}`
}
const nextPartId = partIds()

export interface ExportedInfo {
  readonly title?: string
  readonly agent?: string
  readonly model?: { readonly providerID: string; readonly id: string; readonly variant?: string }
  readonly time?: { readonly created?: number; readonly updated?: number }
  readonly location?: { readonly directory?: string }
}

/** A session document we write. `messages` are the native records, which the reader accepts unchanged. */
export const exportDocument = (input: {
  readonly info?: ExportedInfo
  readonly messages: readonly unknown[]
  readonly exportedAt?: number
}): string =>
  JSON.stringify(
    {
      format: FORMAT,
      version: VERSION,
      exportedAt: input.exportedAt ?? Date.now(),
      info: input.info ?? {},
      messages: input.messages,
    },
    null,
    2,
  )

export interface Imported {
  readonly title?: string
  readonly agent?: string
  readonly directory?: string
  readonly model?: { readonly providerID: string; readonly id: string }
  /** NovaClaw-shaped messages with fresh part ids, ready to record. Message ids are minted by the writer. */
  readonly messages: ReadonlyArray<Json>
  /** Message and part kinds this reader does not model, dropped rather than guessed at. */
  readonly skipped: number
}

const modelRef = (value: unknown): { providerID: string; id: string } | undefined => {
  if (!isRecord(value)) return undefined
  const id = text(value.id) ?? text(value.modelID)
  const providerID = text(value.providerID)
  return id !== undefined && providerID !== undefined ? { providerID, id } : undefined
}

/**
 * One assistant content part, or `undefined` when the kind is not one we model.
 *
 * The reasoning arm is the load-bearing one for encrypted traces: `providerMetadata` is copied
 * verbatim, and every field we do not recognise is preserved under `providerMetadata.imported`.
 */
const assistantPart = (raw: unknown, index: number): Json | undefined => {
  if (!isRecord(raw)) return undefined
  const kind = text(raw.type)
  if (kind === undefined) return undefined

  if (kind === "text" || kind === "content") {
    const body = text(raw.text) ?? text(raw.content)
    return body === undefined ? undefined : { type: "text", id: text(raw.id) ?? nextPartId("text"), text: body }
  }

  if (kind === "reasoning" || kind === "thinking") {
    const known = new Set(["type", "text", "id", "time", "providerMetadata", "metadata", "state"])
    const extras = Object.fromEntries(Object.entries(raw).filter(([key]) => !known.has(key)))
    const providerMetadata = {
      ...metadataRecord(raw.providerMetadata),
      ...(Object.keys(extras).length === 0 ? {} : { imported: { ...extras } }),
    }
    const time = isRecord(raw.time)
      ? {
          ...(finite(raw.time.created) === undefined && finite(raw.time.start) === undefined
            ? {}
            : { created: finite(raw.time.created) ?? finite(raw.time.start)! }),
          ...(finite(raw.time.completed) === undefined && finite(raw.time.end) === undefined
            ? {}
            : { completed: finite(raw.time.completed) ?? finite(raw.time.end)! }),
        }
      : undefined
    return {
      type: "reasoning",
      id: text(raw.id) ?? nextPartId("reasoning"),
      // A redacted thinking block has no readable text; empty is correct and must not be invented.
      text: text(raw.text) ?? "",
      ...(Object.keys(providerMetadata).length === 0 ? {} : { providerMetadata }),
      ...(time === undefined || Object.keys(time).length === 0 ? {} : { time }),
    }
  }

  if (kind === "tool" || kind === "tool-call") return toolPart(raw, index)
  return undefined
}

const toolContent = (state: Json, raw: Json): readonly Json[] => {
  const parts = list(state.content).flatMap((entry): Json[] => {
    if (!isRecord(entry)) return []
    if (entry.type === "text" && typeof entry.text === "string") return [{ type: "text", text: entry.text }]
    if (entry.type === "content" && typeof entry.content === "string") return [{ type: "text", text: entry.content }]
    if (entry.type === "file" && typeof entry.uri === "string" && typeof entry.mime === "string")
      return [{ type: "file", uri: entry.uri, mime: entry.mime, ...(typeof entry.name === "string" ? { name: entry.name } : {}) }]
    return []
  })
  if (parts.length > 0) return parts
  const output = text(state.output) ?? text(raw.output)
  return output === undefined ? [] : [{ type: "text", text: output }]
}

const toolPart = (raw: Json, index: number): Json | undefined => {
  const state = record(raw.state)
  const status = text(state.status) ?? text(raw.status) ?? "completed"
  const name = text(raw.name) ?? text(raw.tool) ?? text(raw.toolName) ?? "tool"
  const id = text(raw.id) ?? text(raw.callID) ?? nextPartId("tool")
  const inputValue = state.input ?? raw.input
  const input = isRecord(inputValue) ? inputValue : {}
  // `structured` is NovaClaw's field; a foreign export keeps the same object under `state.metadata`.
  // Reading both is what makes an export round-trip through this reader without losing it.
  const structured = record(state.structured ?? state.metadata)
  const content = toolContent(state, raw)
  const time = isRecord(raw.time) ? raw.time : {}
  const created = finite(time.created) ?? Date.now()
  const timing = {
    created,
    ...(finite(time.ran) === undefined ? {} : { ran: finite(time.ran)! }),
    ...(finite(time.completed) === undefined ? {} : { completed: finite(time.completed)! }),
  }
  const errorMessage =
    text(state.error) ??
    text(raw.error) ??
    (isRecord(state.error) ? text(state.error.message) : undefined) ??
    "Tool failed in the source harness"
  const stateNow: Json =
    status === "pending"
      ? { status: "pending", input: typeof inputValue === "string" ? inputValue : JSON.stringify(input) }
      : status === "running"
        ? { status: "running", input, structured, content }
        : status === "error"
          ? { status: "error", input, structured, content, error: { type: "unknown", message: errorMessage } }
          : { status: "completed", input, structured, content }
  // A native tool carries `provider`; a foreign export's one carries `executed`. Preserve whichever is there.
  const provider = isRecord(raw.provider) ? { provider: raw.provider } : raw.executed === true ? { provider: { executed: true } } : {}
  return { type: "tool", id, name, ...provider, state: stateNow, time: timing }
}

const assistantMessage = (raw: Json, agent: string, fallbackModel: { providerID: string; id: string }): Json => {
  const content = list(raw.content ?? raw.parts).flatMap((part, index) => {
    const mapped = assistantPart(part, index)
    return mapped === undefined ? [] : [mapped]
  })
  const model = modelRef(raw.model) ?? fallbackModel
  const time = record(raw.time)
  return {
    type: "assistant",
    agent: text(raw.agent) ?? agent,
    model,
    content,
    time: { created: finite(time.created) ?? finite(time.start) ?? Date.now() },
  }
}

const normalizeMessage = (
  raw: unknown,
  agent: string,
  model: { providerID: string; id: string },
): { message?: Json; skipped: number } => {
  if (!isRecord(raw)) return { skipped: 1 }
  const kind = text(raw.type)
  const time = record(raw.time)
  const created = finite(time.created) ?? Date.now()

  if (kind === "user" || (kind === undefined && text(raw.role) === "user"))
    return {
      message: {
        type: "user",
        text: text(raw.text) ?? text(raw.content) ?? "",
        time: { created },
        ...(isRecord(raw.metadata) ? { metadata: raw.metadata } : {}),
      },
      skipped: 0,
    }

  if (kind === "assistant" || (kind === undefined && text(raw.role) === "assistant"))
    return { message: assistantMessage(raw, agent, model), skipped: 0 }

  if (kind === "system")
    return { message: { type: "system", text: text(raw.text) ?? "", time: { created } }, skipped: 0 }

  if (kind === "shell")
    return {
      message: {
        type: "shell",
        callID: text(raw.callID) ?? nextPartId("shell"),
        command: text(raw.command) ?? "",
        output: text(raw.output) ?? "",
        time: { created, ...(finite(time.completed) === undefined ? {} : { completed: finite(time.completed)! }) },
      },
      skipped: 0,
    }

  if (kind === "model-switched" || kind === "agent-switched") {
    const ref = modelRef(raw.model)
    return {
      message:
        kind === "model-switched"
          ? { type: "model-switched", model: ref ?? null, time: { created } }
          : { type: "agent-switched", agent: text(raw.agent) ?? null, time: { created } },
      skipped: 0,
    }
  }

  // `idle`, `step-start`, `patch`, `snapshot`, `subtask`, `compaction` … are not transcript messages
  // we can stand behind, so they are counted and dropped rather than mapped into a thin imitation.
  return { skipped: 1 }
}

/**
 * Read an export from any harness we can recognise.
 *
 * Accepts a JSON string or an already-parsed value, and the document may be a bare `{info, messages}`,
 * our own enveloped export, or a bare message array. Throws a plain `Error` with a user-readable
 * sentence on input that is not a session at all — the caller turns it into an invalid-request response.
 */
export const parse = (document: unknown): Imported => {
  let value = document
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      throw new Error("That file is not valid JSON.")
    }
  }
  if (Array.isArray(value)) value = { messages: value }
  if (!isRecord(value) || !Array.isArray(value.messages))
    throw new Error("That file does not look like a session export (it has no messages array).")

  const messagesRaw = list(value.messages)
  if (messagesRaw.length === 0) throw new Error("That export contains no messages.")

  const info = record(value.info)
  const title = text(info.title) ?? text(value.title)
  const agent = text(info.agent) ?? text(value.agent)
  const directory = text(record(info.location).directory) ?? text(value.directory)
  const model = modelRef(info.model)
  const fallbackModel = model ?? { providerID: "imported", id: "unknown" }

  let skipped = 0
  const messages: Json[] = []
  for (const raw of messagesRaw) {
    const result = normalizeMessage(raw, agent ?? "build", fallbackModel)
    skipped += result.skipped
    if (result.message) messages.push(result.message)
  }
  if (messages.length === 0) throw new Error("None of the messages in that export are ones this harness can record.")

  return {
    ...(title === undefined ? {} : { title }),
    ...(agent === undefined ? {} : { agent }),
    ...(directory === undefined ? {} : { directory }),
    ...(model === undefined ? {} : { model: { providerID: model.providerID, id: model.id } }),
    messages,
    skipped,
  }
}
