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
  /** A group exchange between colleagues. Rides on the message origin, never its own session. */
  conversation: "cnv",
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

/** IDs preserve ordering, not age; use the owning row or file timestamp for elapsed-time decisions. */
export function create(prefix: string, direction: "descending" | "ascending", timestamp?: number): string {
  return prefix + "_" + createIdentifier(direction === "descending", timestamp)
}

export * as Identifier from "./id"
