export interface PathInfo {
  home?: string
  state?: string
  config?: string
  data?: string
  cache?: string
  tmp?: string
  log?: string
  db?: string
  scratchDir?: string
  instanceHome?: string
}

/**
 * One displayed instance location and the expertise level that may see it. Kept as pure data so
 * the Normal/Developer split is testable without mounting the settings dialog.
 */
export interface StorageEntry {
  key: keyof PathInfo
  i18n: "config" | "data" | "db" | "scratch" | "log" | "state" | "cache" | "tmp"
  level?: "developer"
}

export const STORAGE_ENTRIES: StorageEntry[] = [
  { key: "config", i18n: "config" },
  { key: "data", i18n: "data" },
  { key: "db", i18n: "db" },
  { key: "scratchDir", i18n: "scratch" },
  { key: "log", i18n: "log" },
  // Internal plumbing: real, but not needed to back up or move an instance.
  { key: "state", i18n: "state", level: "developer" },
  { key: "cache", i18n: "cache", level: "developer" },
  { key: "tmp", i18n: "tmp", level: "developer" },
]
