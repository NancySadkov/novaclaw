import { SessionSchema } from "@novaclaw/core/session/schema"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionRead } from "@novaclaw/core/session/read"
import { Database } from "@novaclaw/core/database/database"
import { SessionMessage } from "@novaclaw/core/session/message"
import { SessionMessageRead } from "@novaclaw/core/session/message-read"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionID } from "../../session/schema"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { EOL } from "os"
import { DateTime, Effect, Schema } from "effect"

// F1c-0 — export serves the NATIVE transcript (`session_message`, the F1e wire vocabulary);
// the legacy message/part shape is no longer read here (pre-F0 legacy-only transcripts export
// empty per decision ①). The sanitizer below is the redaction walk over the flat
// `SessionMessage` union, replacing the V1 part walk.

function redact(kind: string, id: string, value: string) {
  return value.trim() ? `[redacted:${kind}:${id}]` : value
}

function data(kind: string, id: string, value: Record<string, unknown> | undefined) {
  if (!value) return value
  return Object.keys(value).length ? { redacted: `${kind}:${id}` } : value
}

function diff<T extends { readonly file?: string; readonly patch?: string }>(
  kind: string,
  diffs: readonly T[] | undefined,
) {
  return diffs?.map((item, i) => ({
    ...item,
    file: item.file === undefined ? undefined : redact(`${kind}-file`, String(i), item.file),
    patch: item.patch === undefined ? undefined : redact(`${kind}-patch`, String(i), item.patch),
  }))
}

type Attachment = NonNullable<SessionMessage.User["files"]>[number]
type ToolContentItem = SessionMessage.ToolStateCompleted["content"][number]

function attachment(kind: string, id: string, file: Attachment): Attachment {
  return {
    ...file,
    uri: redact(`${kind}-uri`, id, file.uri),
    name: file.name === undefined ? undefined : redact(`${kind}-name`, id, file.name),
    description: file.description === undefined ? undefined : redact(`${kind}-description`, id, file.description),
    source:
      file.source === undefined ? undefined : { ...file.source, text: redact(`${kind}-text`, id, file.source.text) },
  }
}

function toolContent(id: string, item: ToolContentItem): ToolContentItem {
  if (item.type === "text") return { ...item, text: redact("tool-content", id, item.text) }
  return {
    ...item,
    uri: redact("tool-content-uri", id, item.uri),
    name: item.name === undefined ? undefined : redact("tool-content-name", id, item.name),
  }
}

function toolState(id: string, state: SessionMessage.ToolState): SessionMessage.ToolState {
  switch (state.status) {
    case "pending":
      return { ...state, input: redact("tool-input", id, state.input) }
    case "running":
      return {
        ...state,
        input: data("tool-input", id, state.input) ?? state.input,
        structured: data("tool-structured", id, state.structured) ?? state.structured,
        content: state.content.map((item) => toolContent(id, item)),
      }
    case "completed":
      return {
        ...state,
        input: data("tool-input", id, state.input) ?? state.input,
        structured: data("tool-structured", id, state.structured) ?? state.structured,
        content: state.content.map((item) => toolContent(id, item)),
        attachments: state.attachments?.map((file) => attachment("tool-attachment", id, file)),
        outputPaths: state.outputPaths?.map((item, i) => redact("tool-output-path", `${id}-${i}`, item)),
        result: state.result === undefined ? undefined : { redacted: `tool-result:${id}` },
      }
    case "error":
      return {
        ...state,
        input: data("tool-input", id, state.input) ?? state.input,
        structured: data("tool-structured", id, state.structured) ?? state.structured,
        content: state.content.map((item) => toolContent(id, item)),
        error: { ...state.error, message: redact("tool-error", id, state.error.message) },
        result: state.result === undefined ? undefined : { redacted: `tool-result:${id}` },
      }
  }
}

function assistantContent(item: SessionMessage.AssistantContent): SessionMessage.AssistantContent {
  switch (item.type) {
    case "text":
      return { ...item, text: redact("text", item.id, item.text) }
    case "reasoning":
      return { ...item, text: redact("reasoning", item.id, item.text) }
    case "tool":
      return { ...item, state: toolState(item.id, item.state) }
  }
}

export function sanitizeMessage(msg: SessionMessage.Message): SessionMessage.Message {
  const metadata = data("message-metadata", msg.id, msg.metadata)
  switch (msg.type) {
    case "user":
      return {
        ...msg,
        metadata,
        text: redact("text", msg.id, msg.text),
        files: msg.files?.map((file) => attachment("file", msg.id, file)),
        agents: msg.agents?.map((agent) => ({
          ...agent,
          source:
            agent.source === undefined
              ? undefined
              : { ...agent.source, text: redact("agent-source", msg.id, agent.source.text) },
        })),
      }
    case "synthetic":
    case "system":
      return { ...msg, metadata, text: redact("text", msg.id, msg.text) }
    case "shell":
      return {
        ...msg,
        metadata,
        command: redact("shell-command", msg.id, msg.command),
        output: redact("shell-output", msg.id, msg.output),
      }
    case "assistant":
      return {
        ...msg,
        metadata,
        content: msg.content.map(assistantContent),
        error: msg.error === undefined ? undefined : { ...msg.error, message: redact("error", msg.id, msg.error.message) },
      }
    case "compaction":
      return {
        ...msg,
        metadata,
        summary: redact("compaction-summary", msg.id, msg.summary),
        recent: redact("compaction-recent", msg.id, msg.recent),
      }
    case "agent-switched":
    case "model-switched":
      return { ...msg, metadata }
  }
}

export function sanitizeInfo(info: SessionSchema.Info) {
  return {
    ...info,
    title: redact("session-title", info.id, info.title),
    location: {
      ...info.location,
      // A brand without a filter — safe to stamp onto the redaction token.
      directory: AbsolutePath.make(redact("session-directory", info.id, info.location.directory)),
    },
    summary: !info.summary
      ? info.summary
      : {
          ...info.summary,
          diffs: diff("session-diff", info.summary.diffs),
        },
    revert: !info.revert
      ? info.revert
      : {
          ...info.revert,
          snapshot:
            info.revert.snapshot === undefined ? undefined : redact("revert-snapshot", info.id, info.revert.snapshot),
          diff: info.revert.diff === undefined ? undefined : redact("revert-diff", info.id, info.revert.diff),
        },
  }
}

export const ExportCommand = effectCmd({
  command: "export [sessionID]",
  describe: "export session data as JSON",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session id to export",
        type: "string",
      })
      .option("sanitize", {
        describe: "redact sensitive transcript and file data",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.export")(function* (args) {
    return yield* run(args)
  }),
})

// The export wire shape: the native message encoding (millis timestamps), the same vocabulary
// the HTTP transcript route serves.
const encodeMessages = Schema.encodeSync(Schema.Array(SessionMessage.Message))
const encodeInfo = Schema.encodeSync(SessionSchema.Info)

const run = Effect.fn("Cli.export.body")(function* (args: { sessionID?: string; sanitize?: boolean }) {
  const { db } = yield* Database.Service
  let sessionID = args.sessionID ? SessionID.make(args.sessionID) : undefined
  process.stderr.write(`Exporting session: ${sessionID ?? "latest"}\n`)

  if (!sessionID) {
    const ctx = yield* InstanceRef
    if (!ctx) return
    UI.empty()
    prompts.intro("Export session", { output: process.stderr })

    const sessions = [...(yield* SessionRead.list(db, { under: AbsolutePath.make(ctx.worktree) }))]

    if (sessions.length === 0) {
      prompts.log.error("No sessions found", { output: process.stderr })
      prompts.outro("Done", { output: process.stderr })
      return
    }

    sessions.sort((a, b) => DateTime.toEpochMillis(b.time.updated) - DateTime.toEpochMillis(a.time.updated))

    const selectedSession = yield* Effect.promise(() =>
      prompts.autocomplete({
        message: "Select session to export",
        maxItems: 10,
        options: sessions.map((session) => ({
          label: session.title,
          value: session.id,
          hint: `${new Date(DateTime.toEpochMillis(session.time.updated)).toLocaleString()} • ${session.id.slice(-8)}`,
        })),
        output: process.stderr,
      }),
    )

    if (prompts.isCancel(selectedSession)) {
      return yield* Effect.die(new UI.CancelledError())
    }

    sessionID = selectedSession

    prompts.outro("Exporting session...", { output: process.stderr })
  }

  const sessionInfo = yield* SessionRead.get(db, sessionID)
  if (!sessionInfo) return yield* fail(`Session not found: ${sessionID}`)
  const messages = yield* SessionMessageRead.list(db, { sessionID: sessionInfo.id, order: "asc" }).pipe(
    Effect.catchTag("Session.MessageDecodeError", (error) =>
      fail(`Failed to decode message ${error.messageID} in session ${error.sessionID}`),
    ),
  )

  // Encode through the schema so the envelope is wire-faithful (time as epoch millis, not
  // DateTime object dumps) — mirrors the messages half.
  const exportData = {
    info: encodeInfo(args.sanitize ? sanitizeInfo(sessionInfo) : sessionInfo),
    messages: encodeMessages(args.sanitize ? messages.map(sanitizeMessage) : messages),
  }

  process.stdout.write(JSON.stringify(exportData, null, 2))
  process.stdout.write(EOL)
})
