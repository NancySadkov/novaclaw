import { useDialog } from "@novaclaw/ui/context/dialog"
import { ImagePreview } from "@novaclaw/ui/image-preview"
import { useLanguage } from "@/context/language"
import type { ContextItem, ImageAttachmentPart } from "@/context/prompt"
import { PromptDragOverlay } from "@/components/prompt-input/drag-overlay"
import { PromptContextItems } from "@/components/prompt-input/context-items"
import { PromptImageAttachments } from "@/components/prompt-input/image-attachments"

type PromptContextItem = ContextItem & { key: string }

export type ComposerAttachmentsTrayState = {
  dragging: "image" | "@mention" | null
  contextItems: PromptContextItem[]
  isContextItemActive: (item: PromptContextItem) => boolean
  openComment: (item: PromptContextItem) => void
  removeContextItem: (item: PromptContextItem) => void
  images: ImageAttachmentPart[]
  removeImage: (id: string) => void
}

/**
 * The composer's attachment strip — drag-drop overlay, context-item chips (files/comments),
 * and image thumbnails (click opens the preview dialog). Identical in the v2 and legacy
 * composer shells; extracted so the shells stop duplicating it (ui-arch P4).
 */
export function ComposerAttachmentsTray(props: { state: ComposerAttachmentsTrayState }) {
  const language = useLanguage()
  const dialog = useDialog()
  return (
    <>
      <PromptDragOverlay
        type={props.state.dragging}
        label={language.t(
          props.state.dragging === "@mention" ? "prompt.dropzone.file.label" : "prompt.dropzone.label",
        )}
      />
      <PromptContextItems
        items={props.state.contextItems}
        active={props.state.isContextItemActive}
        openComment={props.state.openComment}
        remove={props.state.removeContextItem}
        t={(key) => language.t(key as Parameters<typeof language.t>[0])}
      />
      <PromptImageAttachments
        attachments={props.state.images}
        onOpen={(attachment) =>
          dialog.show(() => <ImagePreview src={attachment.dataUrl} alt={attachment.filename} />)
        }
        onRemove={props.state.removeImage}
        removeLabel={language.t("prompt.attachment.remove")}
      />
    </>
  )
}
