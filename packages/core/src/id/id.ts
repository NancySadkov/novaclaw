import { create as createIdentifier } from "@novaclaw/schema/identifier"

const prefixes = {
  job: "job",
  event: "evt",
  session: "ses",
  message: "msg",
  permission: "per",
  question: "que",
  part: "prt",
  pty: "pty",
  tool: "tool",
  workspace: "wrk",
  observation: "obs",
  answered: "ans",
} as const

export function ascending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "ascending", given)
}

export function descending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "descending", given)
}

function generateID(prefix: keyof typeof prefixes, direction: "descending" | "ascending", given?: string): string {
  if (!given) {
    return create(prefixes[prefix], direction)
  }

  if (!given.startsWith(prefixes[prefix])) {
    throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
  }
  return given
}

export function create(prefix: string, direction: "descending" | "ascending", timestamp?: number): string {
  return prefix + "_" + createIdentifier(direction === "descending", timestamp)
}

/**
 * Extract a timestamp from an ascending ID. Does not work with descending IDs.
 *
 * 🔴 **IT WRAPS, and the value is NOT comparable across a wrap.** `create` packs
 * `timestamp * 4096 + counter` into 48 bits, and that value needs 53 — so the five high bits are
 * dropped and what comes back is the real time modulo 2^36 ms, about **795 days**.
 *
 * ⚠️ Measured 2026-08-17, sitting just past a wrap: "now" decoded to 919,495 while "seven days
 * ago" decoded to 68,374,796,231. `Truncate.cleanup` compared two of these and deleted every file it
 * was written to preserve. It now reads the file's mtime instead, and this function has **no callers
 * left**.
 *
 * ⚠️ Before using it, ask what you actually want. For ORDER, compare the ids themselves — that is
 * what an ascending id is for. For AGE, ask whatever holds the thing (a file's mtime, a row's
 * `time_created`). This is only safe for a difference between two ids known to be close together, and
 * even then it is wrong across a boundary nobody can see coming.
 */
export function timestamp(id: string): number {
  const prefix = id.split("_")[0]
  const hex = id.slice(prefix.length + 1, prefix.length + 13)
  const encoded = BigInt("0x" + hex)
  return Number(encoded / BigInt(0x1000))
}

export * as Identifier from "./id"
