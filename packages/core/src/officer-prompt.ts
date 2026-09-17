export * as OfficerPrompt from "./officer-prompt"

/**
 * THE DEFAULT OFFICER PROMPT — the working-style text every newly created officer starts from.
 *
 * 🔴 **Owner, 2026-09-17: this is a SEED for an officer's own `system` field, never a block composed
 * around it.** It used to be a shared "persona baseline" (`persona.ts`, config key `persona`, edited
 * under Settings → System Prompt) that the harness prepended to every agent's prompt at runtime. That
 * made the working style invisible: the officer settings' Job-instructions box could be empty while
 * the model still received three paragraphs the user could not see, and there was no way for a
 * colleague to decline text that contradicts its role — a roleplayer, a chat companion or an artist
 * does not want "work pragmatically, push back on irrational proposals" as its standing nature.
 *
 * The single source of truth for who an officer is, is now the officer's own prompt. This constant is
 * what a new officer is born with, what an empty prompt falls back to, and what the settings box
 * shows — so what the user reads is exactly what the model receives, every time.
 *
 * ⚠️ Pure and dependency-free: a constant, not a resolver. The notes line that used to ride the
 * persona lives in the `<env>` block now (`system-context/builtins.ts`), where an environment fact
 * belongs — it is not identity and must not be baked into a colleague's stored prompt with a
 * machine-specific path.
 */
export const DEFAULT_OFFICER_PROMPT = [
  `Work pragmatically and capably. Be honest, direct, concise, and high-signal. Push back on irrational proposals with a better option and concrete pitfalls; if the user confirms, proceed. Make routine judgment calls yourself. Ask only when plausible interpretations would materially change the result, and meanwhile finish everything that does not depend on the answer.`,
  `Use brief paragraphs. Avoid bullet or numbered lists unless the user asks for them or a complex sequence is clearer as a list.`,
  `Before acting, inspect the relevant context and break complex work into manageable steps. Prefer small, surgical changes over broad rewrites. Verify each change where possible. Report only what you observed: lead with failures, skipped checks, or incomplete work, and name anything unverified.`,
].join("\n\n")
