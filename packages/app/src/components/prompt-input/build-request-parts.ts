import { getFilename } from "@novaclaw/core/util/path"
import type { FileSelection } from "@/context/file"
import { encodeFilePath } from "@/context/file/path"
import type { AgentPart, FileAttachmentPart, ImageAttachmentPart, Prompt } from "@/context/prompt"
import { formatCommentNote } from "@/utils/comment-note"

// V1-nuke slice C: the composer builds the NATIVE PromptInput ({text, files, agents}) for
// /api/session/:id/prompt — the V1 parts array (and its optimistic mirror, which nothing ever
// consumed) is gone. Comment notes fold into the text (they were synthetic text parts before;
// the model-visible content is identical). Images ride as data: URIs; file references as
// file:// URIs with the selection range in the query, exactly as the server resolves them.

type PromptFileAttachment = {
  uri: string
  name?: string
  source?: { text: string; start: number; end: number }
}

type PromptAgentAttachment = {
  name: string
  source?: { text: string; start: number; end: number }
}

export type NativePrompt = {
  text: string
  files?: PromptFileAttachment[]
  agents?: PromptAgentAttachment[]
}

type ContextFile = {
  key: string
  type: "file"
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

type BuildPromptInput = {
  prompt: Prompt
  context: ContextFile[]
  images: ImageAttachmentPart[]
  text: string
  sessionDirectory: string
}

const absolute = (directory: string, path: string) => {
  if (path.startsWith("/")) return path
  if (/^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:$/.test(path)) return path
  if (path.startsWith("\\\\") || path.startsWith("//")) return path
  return `${directory.replace(/[\\/]+$/, "")}/${path}`
}

const fileQuery = (selection: FileSelection | undefined) =>
  selection ? `?start=${selection.startLine}&end=${selection.endLine}` : ""

const mention = /(^|[\s([{"'])@(\S+)/g

const parseCommentMentions = (comment: string) => {
  return Array.from(comment.matchAll(mention)).flatMap((match) => {
    const path = (match[2] ?? "").replace(/[.,!?;:)}\]"']+$/, "")
    if (!path) return []
    return [path]
  })
}

const isFileAttachment = (part: Prompt[number]): part is FileAttachmentPart => part.type === "file"
const isAgentAttachment = (part: Prompt[number]): part is AgentPart => part.type === "agent"

export function buildPrompt(input: BuildPromptInput): NativePrompt {
  const files: PromptFileAttachment[] = input.prompt.filter(isFileAttachment).map((attachment) => {
    const path = absolute(input.sessionDirectory, attachment.path)
    return {
      uri: `file://${encodeFilePath(path)}${fileQuery(attachment.selection)}`,
      name: getFilename(attachment.path),
      source: {
        text: attachment.content,
        start: attachment.start,
        end: attachment.end,
      },
    }
  })

  const agents: PromptAgentAttachment[] = input.prompt.filter(isAgentAttachment).map((attachment) => ({
    name: attachment.name,
    source: {
      text: attachment.content,
      start: attachment.start,
      end: attachment.end,
    },
  }))

  // Context files + comment notes. A commented file always attaches; its note text folds into the
  // prompt (V1 sent the note as a synthetic text part — same model-visible content, flat shape).
  const notes: string[] = []
  const used = new Set(files.map((file) => file.uri))
  for (const item of input.context) {
    const path = absolute(input.sessionDirectory, item.path)
    const uri = `file://${encodeFilePath(path)}${fileQuery(item.selection)}`
    const comment = item.comment?.trim()
    if (!comment && used.has(uri)) continue
    if (!used.has(uri)) {
      used.add(uri)
      files.push({ uri, name: getFilename(item.path) })
    }
    if (!comment) continue
    notes.push(formatCommentNote({ path: item.path, selection: item.selection, comment }))
    for (const mentioned of parseCommentMentions(comment)) {
      const mentionedUri = `file://${encodeFilePath(absolute(input.sessionDirectory, mentioned))}`
      if (used.has(mentionedUri)) continue
      used.add(mentionedUri)
      files.push({ uri: mentionedUri, name: getFilename(mentioned) })
    }
  }

  for (const attachment of input.images) {
    files.push({
      uri: attachment.dataUrl,
      name: attachment.sourcePath ?? attachment.filename,
    })
  }

  const text = [input.text, ...notes].filter((value) => value.trim().length > 0).join("\n\n")

  return {
    text,
    ...(files.length > 0 ? { files } : {}),
    ...(agents.length > 0 ? { agents } : {}),
  }
}
