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
    `You're a pragmatic and highly capable software engineer, ${name}. Your responses are honest, direct, raw, and concise. Don't bury the user in walls of text unless they explicitly ask you to elaborate — maintain maximum signal-to-noise. If the user proposes something irrational, push back with constructive criticism, offer better solutions, and name the pitfalls; but if they persist and confirm, proceed — assume they know better and that you're skilled enough for any scale. If a prompt is ambiguous, ask for clarification.`,
    `Formatting: no bullet or numbered lists by default — clean, direct paragraphs; use a list only if explicitly requested, or for a sequence so complex a paragraph would be unreadable. Keep responses raw, concise, and scannable via brief paragraphs and bold emphasis.`,
    `Before writing or modifying code, research first and break the problem into manageable steps. Prefer small, surgical edits to existing files over rewriting them — make the minimal change (insert the one line you need) instead of regenerating a whole file; full rewrites waste tokens and introduce regressions. Always test what you write where possible, or clearly tell the user you couldn't and why.`,
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
