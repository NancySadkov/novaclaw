import { getFilename } from "@novaclaw/core/util/path"
import type { FileSelection } from "@/context/file"
import { encodeFilePath } from "@/context/file/path"
import type { ImageAttachmentPart, Prompt } from "@/context/prompt"
import { formatCommentNote } from "@/utils/comment-note"

// V1-nuke slice C: the composer builds the NATIVE PromptInput ({text, files}) for
// /api/session/:id/prompt — the V1 parts array (and its optimistic mirror, which nothing ever
// consumed) is gone. Comment notes fold into the text (they were synthetic text parts before;
// the model-visible content is identical). Images ride as data: URIs; file references as
// file:// URIs with the selection range in the query, exactly as the server resolves them.

type PromptFileAttachment = {
  uri: string
  name?: string
  source?: { text: string; start: number; end: number }
}

export type NativePrompt = {
  text: string
  files?: PromptFileAttachment[]
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

export function buildPrompt(input: BuildPromptInput): NativePrompt {
  const files: PromptFileAttachment[] = []

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
  }
}
