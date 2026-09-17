export * as PromptCapture from "./prompt-capture"

import fs from "node:fs/promises"
import path from "node:path"
import type { Message, SystemPart } from "@novaclaw/llm"

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

export const latestFile = (input: { readonly scratchFolder: string; readonly sessionID: string }): string =>
  path.join(input.scratchFolder, DIR, `prompt-${input.sessionID}.txt`)

export const initialFile = (input: { readonly scratchFolder: string; readonly sessionID: string }): string =>
  path.join(input.scratchFolder, DIR, `prompt-${input.sessionID}.initial.txt`)

/**
 * The request EXACTLY as the harness built it, with nothing added: no headers, no counts, no
 * commentary. `system`, `messages` and `tools` are the three fields the provider adapter lowers into
 * the wire body, so a reader sees the real content and the real order.
 */
export const render = (input: {
  readonly system: ReadonlyArray<SystemPart>
  readonly messages: ReadonlyArray<Message>
  readonly tools: ReadonlyArray<unknown>
}): string => JSON.stringify({ system: input.system, messages: input.messages, tools: input.tools })

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
