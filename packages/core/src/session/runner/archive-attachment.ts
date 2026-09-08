export * as ArchiveAttachment from "./archive-attachment"

// A ZIP ATTACHED TO A CHAT (owner, 2026-08-23: *"ensure user can attach a zip file to chat for
// analysis by the agent"*).
//
// 🔴 **An archive is not media, and sending it as media is the failure.** `attachmentModality`
// cannot classify `application/zip`, which resolves to `"unknown"`, which means "send it and let the
// provider be the authority" — so a zip rode to the endpoint as a base64 media part that no model
// can read. The user attached their project and the agent answered about nothing.
//
// 🔴 **And the manifest alone is not analysis.** Telling a model "this archive contains 41 files"
// lets it describe a directory listing and nothing else. What a person means by *"analyse this zip"*
// is the CONTENTS: the source, the config, the README. So the archive is opened here and its
// readable entries are inlined as text, exactly as a `text/*` attachment already is — the same seam,
// the same budget discipline, one more container.
//
// ⚠️ **Everything elided is SAID.** A budget that silently drops half the archive teaches the model
// that it has seen the whole thing, and a model that believes it has seen the whole thing will
// answer as though it had (ruling 2 — a failed read never reports success). Every entry that was
// skipped is named with the reason, so the agent can go and read that one itself.
//
// PURE, and deliberately dependency-free: the ZIP central directory is a hundred lines of struct
// reading, and a parser we own is a parser we can make refuse a malformed archive rather than throw
// mid-turn. `node:zlib`'s raw inflate does the decompression, which is the same class of built-in
// as the `Buffer` this file's neighbour already uses to decode a data: URI.

import { inflateRawSync } from "node:zlib"

/** MIME types that are archives rather than model-readable media. */
const ARCHIVE_MIMES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/java-archive",
  "application/vnd.android.package-archive",
  "application/x-tar",
  "application/gzip",
  "application/x-gzip",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar",
  "application/x-bzip2",
  "application/zstd",
  "application/x-xz",
])

/** Extensions that mean the same thing when the browser reports `application/octet-stream`. */
const ARCHIVE_EXTS = new Set([
  "zip",
  "jar",
  "whl",
  "apk",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "tbz",
  "xz",
  "txz",
  "zst",
  "7z",
  "rar",
])

const extensionOf = (name: string | undefined): string => {
  if (!name) return ""
  const index = name.lastIndexOf(".")
  return index === -1 ? "" : name.slice(index + 1).toLowerCase()
}

export const isArchive = (file: { readonly mime: string; readonly name?: string | undefined }): boolean => {
  const mime = (file.mime.split(";")[0] ?? "").trim().toLowerCase()
  if (ARCHIVE_MIMES.has(mime)) return true
  // ⚠️ The extension is consulted only for the types a browser genuinely refuses to name. Trusting
  // it in general would let a file called `notes.zip` that is really a PNG take this path.
  if (mime === "" || mime === "application/octet-stream") return ARCHIVE_EXTS.has(extensionOf(file.name))
  return false
}

/** True for the one archive format this module can OPEN, as opposed to merely recognise. */
export const isZip = (file: { readonly mime: string; readonly name?: string | undefined }): boolean => {
  const mime = (file.mime.split(";")[0] ?? "").trim().toLowerCase()
  if (mime === "application/zip" || mime === "application/x-zip-compressed") return true
  if (mime === "application/java-archive" || mime === "application/vnd.android.package-archive") return true
  if (mime !== "" && mime !== "application/octet-stream") return false
  return ["zip", "jar", "whl", "apk"].includes(extensionOf(file.name))
}

export interface ZipEntry {
  readonly name: string
  readonly size: number
  readonly compressedSize: number
  /** 0 = stored, 8 = deflate. Anything else this module cannot open. */
  readonly method: number
  readonly offset: number
  readonly directory: boolean
}

const EOCD_SIGNATURE = 0x06054b50
const CD_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

/**
 * Hard ceiling for one expanded ZIP entry. The digest's character budgets are not a security
 * boundary: decompression happens before text detection and truncation, so the parser itself must
 * refuse an expansion that could exhaust the host.
 */
export const MAX_EXPANDED_ENTRY_BYTES = 16 * 1024 * 1024

/**
 * Read a ZIP's central directory.
 *
 * Returns `undefined` rather than throwing for anything it cannot read — a truncated upload, a
 * password-protected archive, a zip64 with more than 65,535 entries. A malformed attachment must
 * degrade the turn's information, never fail it.
 */
export function readZipDirectory(bytes: Uint8Array): ZipEntry[] | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The EOCD is at the very end unless the archive carries a comment, which may be up to 64 KiB.
  // Scan backwards over that window only; a forward scan would match a signature that happens to
  // occur inside compressed data.
  const floor = Math.max(0, bytes.length - 0x10000 - 22)
  let eocd = -1
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i
      break
    }
  }
  if (eocd === -1) return undefined

  const count = view.getUint16(eocd + 10, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  // ⚠️ zip64 puts 0xffffffff here and the real values in a separate record. Refusing is honest;
  // pretending the directory starts at 4 GiB is not.
  if (cdOffset === 0xffffffff || count === 0xffff) return undefined
  if (cdOffset >= bytes.length) return undefined

  const entries: ZipEntry[] = []
  let cursor = cdOffset
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > bytes.length) return undefined
    if (view.getUint32(cursor, true) !== CD_SIGNATURE) return undefined
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const size = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const offset = view.getUint32(cursor + 42, true)
    const nameStart = cursor + 46
    if (nameStart + nameLength > bytes.length) return undefined
    const name = Buffer.from(bytes.subarray(nameStart, nameStart + nameLength)).toString("utf8")
    entries.push({ name, size, compressedSize, method, offset, directory: name.endsWith("/") })
    cursor = nameStart + nameLength + extraLength + commentLength
  }
  return entries
}

/** Decompress one entry, or `undefined` when its method or framing is not readable. */
export function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array | undefined {
  if (entry.directory) return undefined
  // `entry.size` came from the archive and is not trusted as proof that the payload is safe, but it
  // is still a useful cheap refusal for the common bomb shape. The zlib limit below is the authority
  // for malformed headers that under-report their expansion.
  if (entry.size > MAX_EXPANDED_ENTRY_BYTES) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (entry.offset + 30 > bytes.length) return undefined
  if (view.getUint32(entry.offset, true) !== LOCAL_SIGNATURE) return undefined
  // ⚠️ The name and extra lengths are read from the LOCAL header, not the central one. They are
  // routinely different — many writers put a zip64 or timestamp extra field in only one of the two —
  // and using the central directory's lengths here lands the read a few bytes into the payload.
  const nameLength = view.getUint16(entry.offset + 26, true)
  const extraLength = view.getUint16(entry.offset + 28, true)
  const start = entry.offset + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (end > bytes.length) return undefined
  const payload = bytes.subarray(start, end)
  if (entry.method === 0) return payload
  if (entry.method !== 8) return undefined
  try {
    return inflateRawSync(payload, { maxOutputLength: MAX_EXPANDED_ENTRY_BYTES })
  } catch {
    return undefined
  }
}

/** Does this look like text rather than a binary blob? Same 30%-control heuristic the composer uses. */
export function looksTextual(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true
  let control = 0
  const sample = bytes.subarray(0, 4096)
  for (const byte of sample) {
    if (byte === 0) return false
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1
  }
  return control / sample.length <= 0.3
}

/** Entries a source archive carries that are noise to an analysis. */
const NOISE = /(^|\/)(\.git\/|node_modules\/|__MACOSX\/|\.DS_Store$|\.venv\/|dist\/|build\/)/

export interface ArchiveDigestOptions {
  /** Total characters of inlined entry content. Beyond this, entries are listed but not opened. */
  readonly budget?: number
  /** Longest single entry to inline. One 400 KB lockfile must not consume the whole budget. */
  readonly perEntry?: number
  /** Most entries to name in the manifest. */
  readonly maxListed?: number
}

const DEFAULTS = { budget: 60_000, perEntry: 16_000, maxListed: 400 } as const

const human = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The text a model is given in place of an archive.
 *
 * The shape is: one sentence saying what this is, the manifest, then each readable text entry
 * inlined under its own path — and finally an explicit account of everything NOT inlined, with the
 * reason for each. The account is the part that keeps the model honest about what it has seen.
 */
export function archiveDigest(input: {
  readonly bytes: Uint8Array | undefined
  readonly name: string | undefined
  readonly mime: string
  /** Where the archive lives on THIS host, when the attachment carries a path rather than bytes. */
  readonly path?: string | undefined
  readonly options?: ArchiveDigestOptions
}): string {
  const label = input.name ? ` ${input.name}` : ""
  const options = { ...DEFAULTS, ...input.options }

  if (input.bytes === undefined) {
    // ⚠️ A path is worth more than an apology. An attachment that rode as a `file://` URI is a real
    // file on this host, and the agent has a shell — so name it and hand the job over rather than
    // reporting that the archive is unknowable.
    if (input.path) {
      return (
        `[Archive${label} (${input.mime}) is attached and lives on this host at ${input.path}. Its ` +
        `contents have NOT been shown to you — open it with your own tools if you need them, and do ` +
        `not describe or guess what is inside until you have.]`
      )
    }
    return (
      `[Archive${label} (${input.mime}) is attached, but its bytes did not reach this turn, so its ` +
      `contents are unknown to you. Say so rather than guessing what is inside.]`
    )
  }

  const total = input.bytes.length
  if (!isZip({ mime: input.mime, name: input.name })) {
    // 🔴 An honest refusal, not a silent one. We can recognise a `.tar.gz` and cannot open it here,
    // and the agent has a shell — so the useful answer is to say what it is and hand the job over
    // rather than to describe an archive nobody opened.
    return (
      `[Archive${label} (${input.mime}, ${human(total)}) is attached. This kernel can only read ZIP ` +
      `containers, so its contents have NOT been shown to you. You have not seen inside it — do not ` +
      `describe or guess its contents. Ask the user to re-attach it as a .zip, or to place it in your ` +
      `working folder so you can extract it with your own tools.]`
    )
  }

  const entries = readZipDirectory(input.bytes)
  if (entries === undefined) {
    return (
      `[Archive${label} (${human(total)}) is attached but could not be opened — it is truncated, ` +
      `encrypted, or in a ZIP variant this kernel does not read. You have not seen inside it; say so ` +
      `rather than describing its contents.]`
    )
  }

  const files = entries.filter((entry) => !entry.directory)
  const listed = files.slice(0, options.maxListed)
  const lines: string[] = []
  lines.push(
    `[Attached archive${label} — ${files.length} file${files.length === 1 ? "" : "s"}, ${human(total)} on disk.` +
      ` Its readable text contents are inlined below.]`,
  )
  lines.push("")
  lines.push("## Contents")
  for (const entry of listed) lines.push(`- ${entry.name} (${human(entry.size)})`)
  if (files.length > listed.length) lines.push(`- …and ${files.length - listed.length} more, not listed.`)

  const skipped: string[] = []
  let spent = 0
  const bodies: string[] = []
  for (const entry of files) {
    if (NOISE.test(entry.name)) {
      skipped.push(`${entry.name} — build or VCS noise`)
      continue
    }
    if (spent >= options.budget) {
      skipped.push(`${entry.name} — the inline budget was already spent`)
      continue
    }
    const raw = readZipEntry(input.bytes, entry)
    if (raw === undefined) {
      skipped.push(`${entry.name} — compression method ${entry.method} could not be read`)
      continue
    }
    if (!looksTextual(raw)) {
      skipped.push(`${entry.name} — binary`)
      continue
    }
    let text = Buffer.from(raw).toString("utf8")
    let note = ""
    if (text.length > options.perEntry) {
      text = text.slice(0, options.perEntry)
      note = `\n… truncated at ${options.perEntry} characters; ${human(entry.size)} in the archive.`
    }
    const remaining = options.budget - spent
    if (text.length > remaining) {
      text = text.slice(0, remaining)
      note = `\n… truncated: the archive's inline budget ran out here.`
    }
    spent += text.length
    bodies.push(`### ${entry.name}\n\`\`\`\n${text}${note}\n\`\`\``)
  }

  if (bodies.length > 0) {
    lines.push("")
    lines.push("## Files")
    lines.push(...bodies)
  }
  if (skipped.length > 0) {
    lines.push("")
    // ⚠️ Named individually, not counted. "12 files were skipped" is a number a model will round to
    // "I read the archive"; a list is something it can act on.
    lines.push("## NOT shown to you")
    lines.push("You have not seen these. Do not describe or guess their contents.")
    for (const line of skipped.slice(0, options.maxListed)) lines.push(`- ${line}`)
    if (skipped.length > options.maxListed) {
      lines.push(`- …and ${skipped.length - options.maxListed} more, also not shown.`)
    }
  }
  return lines.join("\n")
}
