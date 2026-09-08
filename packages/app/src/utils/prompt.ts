import type { SessionMessageUser } from "@novaclaw/sdk/v2/client"
import type { AgentPart, FileAttachmentPart, ImageAttachmentPart, Prompt } from "@/context/prompt"

type Inline =
  | {
      type: "file"
      start: number
      end: number
      value: string
      path: string
      selection?: {
        startLine: number
        endLine: number
        startChar: number
        endChar: number
      }
    }
  | {
      type: "agent"
      start: number
      end: number
      value: string
      name: string
    }

function selectionFromFileUrl(url: string): Extract<Inline, { type: "file" }>["selection"] {
  const queryIndex = url.indexOf("?")
  if (queryIndex === -1) return undefined
  const params = new URLSearchParams(url.slice(queryIndex + 1))
  const startLine = Number(params.get("start"))
  const endLine = Number(params.get("end"))
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return undefined
  return {
    startLine,
    endLine,
    startChar: 0,
    endChar: 0,
  }
}

function makeToRelative(directory?: string) {
  return (path: string) => {
    if (!directory) return path

    const prefix = directory.endsWith("/") ? directory : directory + "/"
    if (path.startsWith(prefix)) return path.slice(prefix.length)

    if (path.startsWith(directory)) {
      const next = path.slice(directory.length)
      if (next.startsWith("/")) return next.slice(1)
      return next
    }

    return path
  }
}

// Weave the plain prompt text and its inline file/agent mentions (with images
// appended) back into the editor's ContentPart[] shape, consumed by the native
// promptFromUserMessage reconstructor below.
function weavePrompt(text: string, inline: Inline[], images: ImageAttachmentPart[]): Prompt {
  inline.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    return a.end - b.end
  })

  const result: Prompt = []
  let position = 0
  let cursor = 0

  const pushText = (content: string) => {
    if (!content) return
    result.push({
      type: "text",
      content,
      start: position,
      end: position + content.length,
    })
    position += content.length
  }

  const pushFile = (item: Extract<Inline, { type: "file" }>) => {
    const content = item.value
    const attachment: FileAttachmentPart = {
      type: "file",
      path: item.path,
      content,
      start: position,
      end: position + content.length,
      selection: item.selection,
    }
    result.push(attachment)
    position += content.length
  }

  const pushAgent = (item: Extract<Inline, { type: "agent" }>) => {
    const content = item.value
    const mention: AgentPart = {
      type: "agent",
      name: item.name,
      content,
      start: position,
      end: position + content.length,
    }
    result.push(mention)
    position += content.length
  }

  for (const item of inline) {
    if (item.start < 0 || item.end < item.start) continue

    const expected = item.value
    if (!expected) continue

    const mismatch = item.end > text.length || item.start < cursor || text.slice(item.start, item.end) !== expected
    const start = mismatch ? text.indexOf(expected, cursor) : item.start
    if (start === -1) continue
    const end = mismatch ? start + expected.length : item.end

    pushText(text.slice(cursor, start))

    if (item.type === "file") pushFile(item)
    if (item.type === "agent") pushAgent(item)

    cursor = end
  }

  pushText(text.slice(cursor))

  if (result.length === 0) {
    result.push({ type: "text", content: "", start: 0, end: 0 })
  }

  if (images.length === 0) return result
  return [...result, ...images]
}

/**
 * Reconstruct the editor Prompt from a NATIVE user message (SessionMessage.User).
 * The native V2 render/data path holds a flat SessionMessage[] instead of V1
 * message + parts; a user message carries `text`, `files[]` (uri/mime/source), and
 * `agents[]` (name/source). The inline @-mention `source` ({start,end,text}) is
 * preserved end-to-end (toV2Prompt → resolvePrompt → message-updater), so this
 * restores fork/undo/command at V1 parity. `data:` file uris are image attachments.
 */
export function promptFromUserMessage(
  message: SessionMessageUser,
  opts?: { directory?: string; attachmentName?: string },
): Prompt {
  const text = message.text ?? ""
  const attachmentName = opts?.attachmentName ?? "attachment"
  const toRelative = makeToRelative(opts?.directory)

  const inline: Inline[] = []
  const images: ImageAttachmentPart[] = []

  let imageIndex = 0
  for (const file of message.files ?? []) {
    if (file.source) {
      const value = file.source.text
      const path = value.startsWith("@") ? value.slice(1) : value
      inline.push({
        type: "file",
        start: file.source.start,
        end: file.source.end,
        value,
        path: toRelative(path),
        selection: selectionFromFileUrl(file.uri),
      })
      continue
    }

    if (file.uri.startsWith("data:")) {
      images.push({
        type: "image",
        id: `${message.id}:image:${imageIndex++}`,
        filename: file.name ?? attachmentName,
        mime: file.mime,
        dataUrl: file.uri,
      })
    }
  }

  for (const agent of message.agents ?? []) {
    if (!agent.source) continue
    inline.push({
      type: "agent",
      start: agent.source.start,
      end: agent.source.end,
      value: agent.source.text,
      name: agent.name,
    })
  }

  return weavePrompt(text, inline, images)
}
