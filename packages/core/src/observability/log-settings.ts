export * as LogSettings from "./log-settings"

import { SUBSYSTEMS, subsystemOf } from "@novaclaw/schema/log-events"
import { Logger, type LogLevel } from "effect"
import { MAX_AGE_MS } from "./log-bounds"
import type { ConfigLog } from "../config/log"

const DAY_MS = 24 * 60 * 60 * 1000
const RANK: Record<ConfigLog.Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const EFFECT_RANK: Partial<Record<LogLevel.LogLevel, number>> = {
  Debug: RANK.debug,
  Info: RANK.info,
  Warn: RANK.warn,
  Error: RANK.error,
  Fatal: 50,
}

const envLevel = (): ConfigLog.Level => {
  const value = process.env.NOVACLAW_LOG_LEVEL?.toLowerCase()
  return value && value in RANK ? (value as ConfigLog.Level) : "info"
}

let current: Readonly<ConfigLog.Info> = {}

/** Refresh the synchronous hot-path projection after a SQLite read or write. */
export function apply(value: unknown): void {
  current = value && typeof value === "object" && !Array.isArray(value) ? (value as ConfigLog.Info) : {}
}

export function get(): Readonly<ConfigLog.Info> {
  return current
}

export function level(): ConfigLog.Level {
  return current.level ?? envLevel()
}

export function maxAgeMs(): number {
  // Clamped to a day: `apply` takes the stored value without decoding (the 1–365 bound in
  // `config/log.ts` is applied on the WRITE path only), and a stored `0` would make every flush
  // rotate, gzip and sweep. Whichever door wrote it, the writer cannot be driven into that loop.
  return Math.max(1, current.retention_days ?? MAX_AGE_MS / DAY_MS) * DAY_MS
}

function eventFrom(message: unknown): string | undefined {
  const parts = Array.isArray(message) ? message : [message]
  for (const part of parts)
    if (part && typeof part === "object" && "event" in part && typeof part.event === "string") return part.event
  return undefined
}

export function allows(options: Logger.Options<unknown>): boolean {
  const actual = EFFECT_RANK[options.logLevel]
  if (actual === undefined) return true
  const event = eventFrom(options.message)
  const subsystem = event ? subsystemOf(event) : undefined
  const configured = subsystem
    ? (current.subsystems as Record<string, ConfigLog.Level | undefined> | undefined)?.[subsystem]
    : undefined
  return actual >= RANK[configured ?? level()]
}

/** Wrap every local sink so one live policy governs every destination. */
export function filter<Output>(logger: Logger.Logger<unknown, Output>): Logger.Logger<unknown, Output | undefined> {
  return Logger.make((options) => (allows(options) ? logger.log(options) : undefined))
}

export const subsystems = SUBSYSTEMS
