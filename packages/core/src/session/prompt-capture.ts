export * as PromptCapture from "./prompt-capture"

import fs from "node:fs/promises"
import path from "node:path"
import type { Message, SystemPart } from "@novaclaw/llm"
import { OldContext } from "./old-context"

/**
 * The EXACT provider request, written where a person can read it.
 *
 * The composed prompt is not otherwise stored: `session.effective` returns the override, not the
 * composed system prompt, and the runner lives in its own process, so the server cannot see it in
 * memory. Debugging an officer's behaviour therefore needs the harness to keep what it actually sent.
 *
 * Two files live beside the agent's other throwaway work (the same `tmp/` `OldContext` uses):
 *
 *   · `prompt-<sessionID>.txt`          — the LATEST request, replaced every turn.
 *   · `prompt-<sessionID>.initial.txt`  — the FIRST request, written once (`wx`, so a later turn can
 *     never overwrite it). This is the init prompt the officer's Work tab exports: it ends at the
 *     first user message, because that is where the first request ends.
 *
 * ⚠️ **Best-effort, never load-bearing.** A debug artifact that can fail a turn is worse than no
 * artifact, so `capture` swallows every error and is bounded, matching `OldContext.save`'s "the
 * caller names what this function did" discipline.
 */

/** Inside the agent's scratch folder, beside its other throwaway work. */
export const DIR = "tmp"

/** A cap so one enormous request cannot fill the disk; the tail is dropped with a visible marker. */
export const MAX_CHARS = 4_000_000

export const latestFile = (input: { readonly scratchFolder: string; readonly sessionID: string }): string =>
  path.join(input.scratchFolder, DIR, `prompt-${input.sessionID}.txt`)

export const initialFile = (input: { readonly scratchFolder: string; readonly sessionID: string }): string =>
  path.join(input.scratchFolder, DIR, `prompt-${input.sessionID}.initial.txt`)

/**
 * Render a request as readable text — the system parts verbatim, the provider messages through the
 * SAME renderer the folded-context artifact uses (so both files read in one vocabulary), and the tool
 * definitions as JSON.
 */
export const render = (input: {
  readonly sessionID: string
  readonly model?: string
  readonly at: Date
  readonly system: ReadonlyArray<SystemPart>
  readonly messages: ReadonlyArray<Message>
  readonly tools: ReadonlyArray<unknown>
}): string => {
  const header = [
    "===== NOVACLAW PROVIDER REQUEST =====",
    `session: ${input.sessionID}`,
    ...(input.model === undefined ? [] : [`model: ${input.model}`]),
    `captured: ${input.at.toISOString()}`,
    "",
  ].join("\n")
  const system = [`===== SYSTEM (${input.system.length}) =====`, input.system.map((part) => part.text).join("\n\n")]
  const messages = [`===== MESSAGES (${input.messages.length}) =====`, OldContext.render(input.messages)]
  const tools = [
    `===== TOOLS (${input.tools.length}) =====`,
    input.tools.map((tool) => JSON.stringify(tool, undefined, 2)).join("\n\n"),
  ]
  const text = [header, ...system, "", ...messages, "", ...tools].join("\n")
  if (text.length <= MAX_CHARS) return text
  return `${text.slice(0, MAX_CHARS)}\n\n[truncated at ${MAX_CHARS} characters of ${text.length}]`
}

/**
 * Write the latest request, and the first one only if it is not there yet.
 *
 * `wx` for the initial file is the whole reason the two writes cannot be one: a turn that replaced
 * `initial` would silently turn the officer's init prompt into the latest one. A rejected `wx` means
 * the file already exists — the outcome we want — so it is ignored.
 */
export const capture = async (input: {
  readonly scratchFolder: string
  readonly sessionID: string
  readonly text: string
}): Promise<void> => {
  try {
    await fs.mkdir(path.join(input.scratchFolder, DIR), { recursive: true })
    await fs.writeFile(latestFile(input), input.text, { encoding: "utf8", flag: "w" })
    try {
      await fs.writeFile(initialFile(input), input.text, { encoding: "utf8", flag: "wx" })
    } catch {
      /* exists: the first request is the init prompt, and it stays that one */
    }
  } catch {
    /* a debug artifact never fails a turn */
  }
}

/** The two captured files, or `undefined` where one is absent. */
export const read = async (input: {
  readonly scratchFolder: string
  readonly sessionID: string
}): Promise<{ readonly initial?: string; readonly latest?: string }> => {
  const readOne = async (file: string) => {
    try {
      return await fs.readFile(file, "utf8")
    } catch {
      return undefined
    }
  }
  const [initial, latest] = await Promise.all([readOne(initialFile(input)), readOne(latestFile(input))])
  return {
    ...(initial === undefined ? {} : { initial }),
    ...(latest === undefined ? {} : { latest }),
  }
}
