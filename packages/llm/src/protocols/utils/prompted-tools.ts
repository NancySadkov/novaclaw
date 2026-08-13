// THE PROMPTED TOOL CHANNEL — how tools are offered to an endpoint whose native channel does not
// work, so the harness is not reduced to a chat.
//
// `tool-recovery.ts` is the reading half and has run for months: models emit tool calls as text
// unprompted, and it pulls them back out, whitelist-gated. This is the WRITING half — describing the
// tools in the prompt so a model that never sees a `tools` array can still call one.
//
// 🔴 **The format asks for BARE JSON, and that is measured rather than chosen.** Against Holo3.1 on
// a vLLM server (2026-08-13), the same JSON wrapped in `<tool_call>…</tool_call>` came back as
// `content: null` with no tool_calls: the server's own tool parser CONSUMES the block and emits
// nothing in its place. The hermes shape — the one the recovery exists for, because models emit it
// unprompted — is exactly what you must not ASK for on a server with a parser armed, because the
// client then sees an empty turn and reads it as the model having nothing to say.
//
// The general rule, worth more than the format: on this channel the SERVER is a participant, not a
// pipe. A shape it recognises is a shape it may swallow. Bare JSON is passed through and is
// recovered by `recoverBareJson`.
//
// ⚠️ This changes what we ASK for, never what we ACCEPT. The recovery still reads hermes, XML and
// call syntax, so a model that answers in one of those anyway is still understood.

import type { LLMRequest, ToolDefinition } from "../../schema/messages"

/**
 * One tool, as the model will see it.
 *
 * The schema goes in verbatim as JSON. A prose rendering would be a second description of the same
 * shape — free to drift from the one the executor validates against, and the drift would show up as
 * a model that fills in fields the tool does not have.
 */
const describe = (tool: ToolDefinition): string =>
  `- ${tool.name}: ${tool.description?.trim() || "(no description)"}\n  arguments: ${JSON.stringify(tool.inputSchema)}`

/** The header, kept separate so a test can assert the instruction without the tool list. */
export const INSTRUCTION =
  "To use a tool, reply with NOTHING but a single line of JSON — no code fence, no tags, no prose " +
  'before or after: {"name":"<tool name>","arguments":{…}}. ' +
  "Use a tool only when you need it; otherwise answer normally. Never invent a tool name: only the " +
  "tools listed below exist."

/**
 * The section to add to the system prompt when tools are offered by description.
 *
 * Returns `undefined` for an empty tool set rather than an empty section: a prompt telling a model
 * about the calling convention for zero tools is instructions it can only misapply.
 */
export const promptedToolsSection = (tools: ReadonlyArray<ToolDefinition>): string | undefined =>
  tools.length === 0 ? undefined : `# Tools\n\n${INSTRUCTION}\n\n${tools.map(describe).join("\n")}`

/**
 * Which channel this request runs on — asked in ONE place.
 *
 * 🔴 Two things decide it and the precedence matters: an explicit `request.toolChannel` is a caller
 * saying "this call, this way" (a probe, a repair, a test), and it beats the model's recorded
 * compatibility, which is the standing answer for every other turn. Re-deriving this at each site
 * would let the body omit `tools` while the prompt says nothing about them — a turn where the agent
 * cannot act, and which reads from the outside as a model refusing.
 */
export const isPrompted = (request: LLMRequest): boolean =>
  (request.toolChannel ?? request.model.compatibility?.toolChannel) === "prompted"

export * as PromptedTools from "./prompted-tools"
