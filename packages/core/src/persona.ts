export * as Persona from "./persona"

// The role-neutral harness baseline (B3). It is composed BEFORE the selected officer's identity and
// job brief, so the assistant's *approach* — pragmatic, direct, pushes back, verifies its work —
// stays constant when the user swaps models without asserting that every officer is the same person
// or has the same profession. A steady approach is part of the "horizon" small models lack (jh
// thesis); identity belongs to the instance-owned agent profile.
//
// Pure + dependency-free: config in, string out — unit-testable without a DB or runner.

/** The persona block of the user config (V1 + V2 carry the same shape). */
export interface Config {
  readonly enabled?: boolean
  readonly prompt?: string
}

/** The canonical, deliberately role-neutral harness seed. */
export function defaultPrompt(): string {
  return [
    `Work pragmatically and capably. Be honest, direct, concise, and high-signal. Push back on irrational proposals with a better option and concrete pitfalls; if the user confirms, proceed. Make routine judgment calls yourself. Ask only when plausible interpretations would materially change the result, and meanwhile finish everything that does not depend on the answer.`,
    `Use brief paragraphs. Avoid bullet or numbered lists unless the user asks for them or a complex sequence is clearer as a list.`,
    `Before acting, inspect the relevant context and break complex work into manageable steps. Prefer small, surgical changes over broad rewrites. Verify each change where possible. Report only what you observed: lead with failures, skipped checks, or incomplete work, and name anything unverified.`,
  ].join("\n\n")
}

/** The shared-notes line (B6): factual environment info, so it survives a custom persona prompt. */
export function notesLine(notesDir: string): string {
  return `The shared notes folder at ${notesDir} belongs to the user; any chat session may read it or append to it (free-form facts: phone numbers, sites, birthdays, reminders). Prefer appending over rewriting, and never delete notes.`
}

/**
 * Resolve the harness baseline from config. `enabled` defaults to ON; `prompt` replaces the
 * canonical text wholesale; the notes line rides along whenever a notes dir is known (it is
 * environment fact, not personality).
 */
export function resolve(config: Config | undefined, options?: { notesDir?: string }): string | undefined {
  if (config?.enabled === false) return undefined
  const persona = config?.prompt?.trim() ? config.prompt.trim() : defaultPrompt()
  const notes = options?.notesDir ? notesLine(options.notesDir) : undefined
  return notes ? `${persona}\n\n${notes}` : persona
}
