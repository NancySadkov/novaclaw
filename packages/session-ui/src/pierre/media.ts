import type { FileContent } from "@novaclaw/sdk/v2"

export type MediaKind = "image" | "audio" | "svg"

const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "tif", "tiff", "heic"])
const audioExtensions = new Set(["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus"])

type MediaValue = unknown

function mediaRecord(value: unknown) {
  if (!value || typeof value !== "object") return
  return value as Partial<FileContent> & {
    content?: unknown
    encoding?: unknown
    mimeType?: unknown
    type?: unknown
  }
}

export function normalizeMimeType(type: string | undefined) {
  if (!type) return
  const mime = type.split(";", 1)[0]?.trim().toLowerCase()
  if (!mime) return
  if (mime === "audio/x-aac") return "audio/aac"
  if (mime === "audio/x-m4a") return "audio/mp4"
  return mime
}

export function fileExtension(path: string | undefined) {
  if (!path) return ""
  const idx = path.lastIndexOf(".")
  if (idx === -1) return ""
  return path.slice(idx + 1).toLowerCase()
}

export function mediaKindFromPath(path: string | undefined): MediaKind | undefined {
  const ext = fileExtension(path)
  if (ext === "svg") return "svg"
  if (imageExtensions.has(ext)) return "image"
  if (audioExtensions.has(ext)) return "audio"
}

export function isBinaryContent(value: MediaValue) {
  return mediaRecord(value)?.type === "binary"
}

function validDataUrl(value: string, kind: MediaKind) {
  if (kind === "svg") return value.startsWith("data:image/svg+xml") ? value : undefined
  if (kind === "image") return value.startsWith("data:image/") ? value : undefined
  if (value.startsWith("data:audio/x-aac;")) return value.replace("data:audio/x-aac;", "data:audio/aac;")
  if (value.startsWith("data:audio/x-m4a;")) return value.replace("data:audio/x-m4a;", "data:audio/mp4;")
  if (value.startsWith("data:audio/")) return value
}

export function dataUrlFromMediaValue(value: MediaValue, kind: MediaKind) {
  if (!value) return

  if (typeof value === "string") {
    return validDataUrl(value, kind)
  }

  const record = mediaRecord(value)
  if (!record) return

  if (typeof record.content !== "string") return

  const mime = normalizeMimeType(typeof record.mimeType === "string" ? record.mimeType : undefined)
  if (!mime) return

  if (kind === "svg") {
    if (mime !== "image/svg+xml") return
    if (record.encoding === "base64") return `data:image/svg+xml;base64,${record.content}`
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(record.content)}`
  }

  if (kind === "image" && !mime.startsWith("image/")) return
  if (kind === "audio" && !mime.startsWith("audio/")) return
  if (record.encoding !== "base64") return

  return `data:${mime};base64,${record.content}`
}

/**
 * The most CHARACTERS an inline `data:` URL may occupy.
 *
 * 🔴 **The bound is on the produced URL, not on the file, because the URL is the thing that is
 * KEPT.** A host image reaches the chat by having its bytes read through the authenticated client
 * and pasted into the rendered HTML as a `data:` URL — and that HTML is held verbatim in the
 * 200-entry markdown LRU (`components/markdown-cache.tsx`). So the file's own size is an estimate of
 * the cost and the URL's length is the cost.
 *
 * **Why 768 Ki characters.** A JS string is UTF-16, so one maximal entry costs ~1.5 MB of heap; two
 * hundred distinct maximal ones — the pathological case, not a likely one — bound the cache at
 * ~300 MB instead of at nothing. Going the other way, base64 costs 4/3, so the limit admits a file
 * of roughly 576 KiB: every SVG a colleague draws is single-digit KB and the great majority of PNG
 * plots and screenshots fit with room to spare.
 *
 * ⚠️ **An oversized file must DEGRADE, never vanish.** The caller is expected to render something
 * that still hands the file over; see `apps/agent-file-link.ts` and the image branch of
 * `@novaclaw/ui/context/marked`.
 */
export const INLINE_MEDIA_LIMIT_CHARS = 768 * 1024

export type InlineMedia =
  | { readonly ok: true; readonly src: string }
  | { readonly ok: false; readonly reason: "oversize" | "unreadable" }

/**
 * One file's content as a self-contained `data:` URL, or a NAMED refusal.
 *
 * ⚠️ The two failures are kept apart on purpose: "too big to inline" and "not an image we could
 * decode" call for different words on screen, and folding them together is how a size limit becomes
 * indistinguishable from a broken file.
 */
export function inlineMediaFromFile(
  value: MediaValue,
  path: string | undefined,
  limit: number = INLINE_MEDIA_LIMIT_CHARS,
): InlineMedia {
  const kind = mediaKindFromPath(path)
  if (kind !== "image" && kind !== "svg") return { ok: false, reason: "unreadable" }
  const src = dataUrlFromMediaValue(value, kind)
  if (!src) return { ok: false, reason: "unreadable" }
  if (src.length > limit) return { ok: false, reason: "oversize" }
  return { ok: true, src }
}

function decodeBase64Utf8(value: string) {
  if (typeof atob !== "function") return

  try {
    const raw = atob(value)
    const bytes = Uint8Array.from(raw, (x) => x.charCodeAt(0))
    if (typeof TextDecoder === "function") return new TextDecoder().decode(bytes)
    return raw
  } catch {}
}

export function svgTextFromValue(value: MediaValue) {
  const record = mediaRecord(value)
  if (!record) return
  if (typeof record.content !== "string") return

  const mime = normalizeMimeType(typeof record.mimeType === "string" ? record.mimeType : undefined)
  if (mime !== "image/svg+xml") return
  if (record.encoding === "base64") return decodeBase64Utf8(record.content)
  return record.content
}

export function hasMediaValue(value: MediaValue) {
  if (typeof value === "string") return value.length > 0
  const record = mediaRecord(value)
  if (!record) return false
  return typeof record.content === "string" && record.content.length > 0
}
