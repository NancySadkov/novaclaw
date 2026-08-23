import { ACCEPTED_ARCHIVE_TYPES, ACCEPTED_FILE_TYPES, ACCEPTED_IMAGE_TYPES } from "@/constants/file-picker"

export { ACCEPTED_FILE_TYPES }

type AttachmentPicker = (
  options: {
    defaultPath?: string
    multiple?: boolean
    accept?: string[]
  },
  onFile: (file: File) => Promise<unknown>,
) => Promise<void>

export function pickAttachmentFiles(input: {
  picker?: AttachmentPicker
  directory: () => string
  fallback: () => void
  onFile: (file: File) => Promise<unknown>
  onError: (error: unknown) => void
}) {
  if (!input.picker) {
    input.fallback()
    return
  }
  void input
    .picker(
      {
        defaultPath: input.directory(),
        multiple: true,
        accept: ACCEPTED_FILE_TYPES,
      },
      input.onFile,
    )
    .catch(input.onError)
}

const IMAGE_MIMES = new Set(ACCEPTED_IMAGE_TYPES)
const IMAGE_EXTS = new Map([
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
])
const TEXT_MIMES = new Set([
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
])

/**
 * Archives, and the extensions a browser refuses to name (owner, 2026-08-23).
 *
 * ⚠️ These must be recognised BEFORE the textual sniff below, not after. A zip's first 4 KB are
 * compressed bytes, so `textBytes` rejects them and `attachmentMime` returned `undefined` — which
 * the composer renders as "that file type is not supported". The user's project was refused at the
 * picker, and nothing downstream ever got the chance to open it.
 */
const ARCHIVE_MIMES = new Set(ACCEPTED_ARCHIVE_TYPES.filter((item) => !item.startsWith(".")))
const ARCHIVE_EXTS = new Map([
  ["zip", "application/zip"],
  ["jar", "application/java-archive"],
  ["whl", "application/zip"],
  ["apk", "application/zip"],
  ["tar", "application/x-tar"],
  ["gz", "application/gzip"],
  ["tgz", "application/gzip"],
  ["xz", "application/x-xz"],
  ["zst", "application/zstd"],
  ["7z", "application/x-7z-compressed"],
])

const SAMPLE = 4096

function kind(type: string) {
  return type.split(";", 1)[0]?.trim().toLowerCase() ?? ""
}

function ext(name: string) {
  const idx = name.lastIndexOf(".")
  if (idx === -1) return ""
  return name.slice(idx + 1).toLowerCase()
}

function textMime(type: string) {
  if (!type) return false
  if (type.startsWith("text/")) return true
  if (TEXT_MIMES.has(type)) return true
  if (type.endsWith("+json")) return true
  return type.endsWith("+xml")
}

function textBytes(bytes: Uint8Array) {
  if (bytes.length === 0) return true
  let count = 0
  for (const byte of bytes) {
    if (byte === 0) return false
    if (byte < 9 || (byte > 13 && byte < 32)) count += 1
  }
  return count / bytes.length <= 0.3
}

export async function attachmentMime(file: File) {
  const type = kind(file.type)
  if (IMAGE_MIMES.has(type)) return type
  if (type === "application/pdf") return type
  if (ARCHIVE_MIMES.has(type)) return type

  const suffix = ext(file.name)
  const fallback = IMAGE_EXTS.get(suffix) ?? (suffix === "pdf" ? "application/pdf" : undefined)
  if ((!type || type === "application/octet-stream") && fallback) return fallback
  // The archive fallback is second, and only for an unnamed type: a browser that says `image/png`
  // for a file called `notes.zip` is describing the BYTES, and it is right.
  const archive = ARCHIVE_EXTS.get(suffix)
  if ((!type || type === "application/octet-stream") && archive) return archive

  if (textMime(type)) return "text/plain"
  const bytes = new Uint8Array(await file.slice(0, SAMPLE).arrayBuffer())
  if (!textBytes(bytes)) return
  return "text/plain"
}
