/**
 * The transcript row for the `colleague` tool — the agent turning aside to talk to ANOTHER agent.
 *
 * 🔴 Owner, 2026-08-21: *"the user who reads the chat should clearly see that the agent got
 * distracted and answered another agent."* Before this the tool fell through to `toolMeta`'s default
 * arm and rendered as the bare word `colleague` — the one row where the tool's NAME is the least
 * interesting thing about it, and the fact the reader needs (their agent is working for someone else
 * right now) was the part left out.
 *
 * ⚠️ Lives in its own PLAIN module, not inside `native-transcript.tsx`, for a boring reason with a
 * real cost: that file imports a Vite worker, so `bun test` cannot load it and every rule inside it
 * can only ever be pinned by reading the source. A rule about what the user SEES deserves a test that
 * runs the code.
 */

/** What a transcript row shows for one tool call. Structurally `ToolMeta` in `native-transcript`. */
export interface Row {
  readonly title: string
  readonly subtitle?: string
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined)

export const colleagueRow = (input: Record<string, unknown>): Row => {
  const who = text(input.colleague)
  switch (text(input.op)) {
    case "hire":
      return { title: "Hired a colleague", ...(text(input.title) ? { subtitle: text(input.title)! } : {}) }
    case "retire":
      return { title: "Retired a colleague", ...(who ? { subtitle: who } : {}) }
    case "list":
      return { title: "Looked up colleagues" }
    default:
      // ⚠️ "Messaged", never "Asked": the same op carries a question AND its answer (the reply
      // travels back the way the question came — `core/session/colleague-note.ts`), so a title
      // claiming one would misdescribe the other half of every exchange.
      return {
        title: who ? `Messaged ${who}` : "Messaged a colleague",
        ...(text(input.message) ? { subtitle: text(input.message)! } : {}),
      }
  }
}
