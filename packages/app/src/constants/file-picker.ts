export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]

/**
 * Containers a chat may carry (owner, 2026-08-23: *"ensure user can attach a zip file to chat for
 * analysis by the agent"*).
 *
 * ⚠️ Only ZIP is OPENED — `core/session/runner/archive-attachment.ts` reads its central directory
 * and inlines the readable entries. The others are accepted anyway and refused with a sentence that
 * names the format and hands the job to the agent's own shell, because a picker that silently
 * rejects a `.tar.gz` teaches the user the product cannot take archives at all, which is a worse
 * lesson than "that one I have to unpack for you".
 */
export const ACCEPTED_ARCHIVE_TYPES = [
  "application/zip",
  "application/x-zip-compressed",
  "application/java-archive",
  "application/x-tar",
  "application/gzip",
  "application/x-7z-compressed",
  "application/zstd",
  "application/x-xz",
  ".zip",
  ".jar",
  ".whl",
  ".tar",
  ".tgz",
  ".gz",
  ".xz",
  ".zst",
  ".7z",
]

export const ACCEPTED_FILE_TYPES = [
  ...ACCEPTED_IMAGE_TYPES,
  ...ACCEPTED_ARCHIVE_TYPES,
  "application/pdf",
  "text/*",
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
  ".c",
  ".cc",
  ".cjs",
  ".conf",
  ".cpp",
  ".css",
  ".csv",
  ".cts",
  ".env",
  ".go",
  ".gql",
  ".graphql",
  ".h",
  ".hh",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".py",
  ".rb",
  ".rs",
  ".sass",
  ".scss",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]

const MIME_EXT = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["application/pdf", "pdf"],
  ["application/json", "json"],
  ["application/ld+json", "jsonld"],
  ["application/toml", "toml"],
  ["application/x-toml", "toml"],
  ["application/x-yaml", "yaml"],
  ["application/xml", "xml"],
  ["application/yaml", "yaml"],
])

const TEXT_EXT = ["txt", "text", "md", "markdown", "log", "csv"]

const ARCHIVE_EXT = new Map([
  ["application/zip", "zip"],
  ["application/x-zip-compressed", "zip"],
  ["application/java-archive", "jar"],
  ["application/x-tar", "tar"],
  ["application/gzip", "gz"],
  ["application/x-7z-compressed", "7z"],
  ["application/zstd", "zst"],
  ["application/x-xz", "xz"],
])

export const ACCEPTED_FILE_EXTENSIONS = Array.from(
  new Set(
    ACCEPTED_FILE_TYPES.flatMap((item) => {
      if (item.startsWith(".")) return [item.slice(1)]
      if (item === "text/*") return TEXT_EXT
      const out = MIME_EXT.get(item) ?? ARCHIVE_EXT.get(item)
      return out ? [out] : []
    }),
  ),
).sort()

export function filePickerFilters(ext?: string[]) {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}
