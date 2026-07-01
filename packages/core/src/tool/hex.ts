// Pure helpers for inspecting and patching binary files WITHOUT ever loading the whole
// file — so the same tools work on a 20-byte `.o` and a 4 GB `.iso`. Three concerns:
//
//   - detectFileType: best-effort magic-number -> format guess, for the "this is a binary
//     file" note the read tool shows instead of the bare "Cannot read binary file" error
//     that derails small models.
//   - hexDump: canonical `OFFSET  hex…  |ascii|` for one byte window, offset-labelled so
//     read-hex can page over a huge file (each window carries its own base offset).
//   - binaryNote: the model-facing message that nudges toward read-hex/write-hex.
//
// Pure + dependency-free so it is unit-tested without a filesystem.

export interface FileType {
  readonly format: string
  readonly description: string
}

// Magic numbers, checked at offset 0 unless `offset` says otherwise. Best-effort: an
// unrecognized binary is fine (the note just says "binary data" and the hex tools still work).
const MAGICS: ReadonlyArray<{ readonly magic: ReadonlyArray<number>; readonly offset?: number; readonly type: FileType }> = [
  { magic: [0x7f, 0x45, 0x4c, 0x46], type: { format: "ELF", description: "ELF executable / shared object / core" } },
  { magic: [0x4d, 0x5a], type: { format: "PE", description: "Windows PE/DOS executable (MZ)" } },
  { magic: [0xca, 0xfe, 0xba, 0xbe], type: { format: "Mach-O", description: "Mach-O universal (fat) binary" } },
  { magic: [0xcf, 0xfa, 0xed, 0xfe], type: { format: "Mach-O", description: "Mach-O 64-bit executable" } },
  { magic: [0x25, 0x50, 0x44, 0x46], type: { format: "PDF", description: "PDF document" } },
  { magic: [0x50, 0x4b, 0x03, 0x04], type: { format: "ZIP", description: "ZIP archive (also jar / docx / xlsx / apk)" } },
  { magic: [0x1f, 0x8b], type: { format: "gzip", description: "gzip-compressed data" } },
  { magic: [0x42, 0x5a, 0x68], type: { format: "bzip2", description: "bzip2-compressed data" } },
  { magic: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], type: { format: "xz", description: "xz-compressed data" } },
  { magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], type: { format: "PNG", description: "PNG image" } },
  { magic: [0xff, 0xd8, 0xff], type: { format: "JPEG", description: "JPEG image" } },
  { magic: [0x47, 0x49, 0x46, 0x38], type: { format: "GIF", description: "GIF image" } },
  { magic: [0x00, 0x61, 0x73, 0x6d], type: { format: "WASM", description: "WebAssembly module" } },
  { magic: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66], type: { format: "SQLite", description: "SQLite 3 database" } },
  { magic: [0x75, 0x73, 0x74, 0x61, 0x72], offset: 0x101, type: { format: "tar", description: "tar archive" } },
  { magic: [0x43, 0x44, 0x30, 0x30, 0x31], offset: 0x8001, type: { format: "ISO 9660", description: "ISO 9660 CD/DVD image" } },
]

function matchesAt(bytes: Uint8Array, magic: ReadonlyArray<number>, offset: number): boolean {
  if (offset + magic.length > bytes.length) return false
  for (let i = 0; i < magic.length; i++) if (bytes[offset + i] !== magic[i]) return false
  return true
}

/** Best-effort file-type guess from a leading byte sample (which may include the deep ISO/tar magic). */
export function detectFileType(bytes: Uint8Array): FileType | undefined {
  for (const entry of MAGICS) if (matchesAt(bytes, entry.magic, entry.offset ?? 0)) return entry.type
  return undefined
}

const HEX_DIGITS = "0123456789abcdef"
const hex2 = (byte: number): string => HEX_DIGITS[(byte >> 4) & 0xf] + HEX_DIGITS[byte & 0xf]
// No 32-bit truncation — a >4 GB offset simply renders more than 8 digits.
const hexOffset = (n: number): string => n.toString(16).padStart(8, "0")

/**
 * Canonical hex dump of one window: `00000010  4d 5a 90 00 …  |MZ..…|`, 16 bytes per row.
 * `baseOffset` is the file offset of `bytes[0]` so windows page correctly across a huge file.
 * Missing trailing bytes on the last row are padded with spaces so the ascii gutter aligns.
 */
export function hexDump(bytes: Uint8Array, baseOffset = 0): string {
  const lines: string[] = []
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, i + 16)
    const cells: string[] = []
    let ascii = ""
    for (let j = 0; j < 16; j++) {
      if (j < row.length) {
        const byte = row[j]
        cells.push(hex2(byte))
        ascii += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : "."
      } else {
        cells.push("  ")
      }
    }
    lines.push(`${hexOffset(baseOffset + i)}  ${cells.join(" ")}  |${ascii}|`)
  }
  return lines.join("\n")
}

/** The model-facing message that replaces the bare "Cannot read binary file". */
export function binaryNote(resource: string, size: number, type: FileType | undefined): string {
  const what = type ? `${type.format} — ${type.description}` : "unrecognized binary data"
  return (
    `"${resource}" is a binary file (${size} bytes; ${what}), not text. ` +
    `Use \`read-hex\` to inspect it in chunks (it pages, so it works even on multi-GB images) ` +
    `and \`write-hex\` to patch bytes at an offset.`
  )
}
