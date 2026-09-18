import type { SessionMessageUser } from "@novaclaw/sdk/v2/client"
import type { ImageAttachmentPart, Prompt } from "@/context/prompt"

/**
 * Reconstruct the editor Prompt from a NATIVE user message (SessionMessage.User).
 * The native V2 render/data path holds a flat SessionMessage[]; a user message carries
 * `text` and `files[]` (uri/mime). `data:` file uris are image attachments.
 */
export function promptFromUserMessage(
  message: SessionMessageUser,
  opts?: { directory?: string; attachmentName?: string },
): Prompt {
  const text = message.text ?? ""
  const attachmentName = opts?.attachmentName ?? "attachment"

  const result: Prompt = [{ type: "text", content: text, start: 0, end: text.length }]

  const images: ImageAttachmentPart[] = []
  let imageIndex = 0
  for (const file of message.files ?? []) {
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

  if (images.length === 0) return result
  return [...result, ...images]
}
