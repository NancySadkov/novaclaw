export * as TrashSettings from "./trash-settings"

import type { ConfigTrash } from "./config/trash"

const DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_RETENTION_DAYS = 30

let current: Readonly<ConfigTrash.Info> = {}

/** Refresh the synchronous hot-path projection after the settings store is read or written. */
export function apply(value: unknown): void {
  current = value && typeof value === "object" && !Array.isArray(value) ? (value as ConfigTrash.Info) : {}
}

export function retentionDays(): number {
  const days = current.retention_days
  return typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= 365
    ? days
    : DEFAULT_RETENTION_DAYS
}

export function maxAgeMs(): number {
  return retentionDays() * DAY_MS
}
