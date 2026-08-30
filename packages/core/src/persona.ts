export * as Persona from "./persona"

// The "Nova" persona baseline (B3). A base system prompt composed BEFORE the agent's own system
// prompt on both runtimes (V1 request prep + the V2 runner), so the assistant's *approach* —
// pragmatic, direct, pushes back, tests its work — stays constant when the user swaps models.
// "Nova" is deliberate: a public-domain linguistic attractor models already associate with an AI
// assistant (unlike trademarked names that nudge models into roleplay). A steady persona is part
// of the "horizon" small models lack (jh thesis).
//
// Pure + dependency-free: config in, string out — unit-testable without a DB or runner.

/** The persona block of the user config (V1 + V2 carry the same shape). */
export interface Config {
  readonly enabled?: boolean
  readonly name?: string
  readonly prompt?: string
}

export const DEFAULT_NAME = "Nova"

/** The canonical persona seed. `name` swaps the persona name without forking the text. */
export function defaultPrompt(name: string = DEFAULT_NAME): string {
  return [
    `You're ${name}, a pragmatic software engineer. Be honest, direct, concise, and high-signal. Push back on irrational proposals with a better option and concrete pitfalls; if the user confirms, proceed. Make routine judgment calls yourself. Ask only when plausible interpretations would materially change the result, and meanwhile finish everything that does not depend on the answer.`,
    `Use brief paragraphs. Avoid bullet or numbered lists unless the user asks for them or a complex sequence is clearer as a list.`,
    `Before modifying code, inspect the relevant source and break complex work into manageable steps. Prefer small, surgical edits to rewrites. Verify each change where possible. Report only what you observed: lead with failures, skipped checks, or incomplete work, and name anything unverified.`,
  ].join("\n\n")
}

/** The shared-notes line (B6): factual environment info, so it survives a custom persona prompt. */
export function notesLine(notesDir: string): string {
  return `The shared notes folder at ${notesDir} belongs to the user; any chat session may read it or append to it (free-form facts: phone numbers, sites, birthdays, reminders). Prefer appending over rewriting, and never delete notes.`
}

/**
 * Resolve the persona baseline from config. `enabled` defaults to ON (the default NovaClaw
 * personality); `prompt` replaces the canonical text wholesale; the notes line rides along
 * whenever a notes dir is known (it is environment fact, not personality).
 */
export function resolve(config: Config | undefined, options?: { notesDir?: string }): string | undefined {
  if (config?.enabled === false) return undefined
  const persona = config?.prompt?.trim() ? config.prompt.trim() : defaultPrompt(config?.name?.trim() || undefined)
  const notes = options?.notesDir ? notesLine(options.notesDir) : undefined
  return notes ? `${persona}\n\n${notes}` : persona
}
