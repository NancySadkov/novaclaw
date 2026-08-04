export * as MessengerCommands from "./commands"

// The gateway-level command router's PARSER (notes/messenger-plan.md §3.2 step 3): a tiny,
// deterministic, closed set parsed BEFORE any model sees the text. `/pair` is how a stranger
// becomes somebody; everything else is operator-trust, DM-only — enforced by the GATEWAY, not
// here (this module stays pure). The model never sees these commands and can never invoke them:
// its own surface is the `messenger` tool with its own permission gates.

export type Command =
  | { readonly kind: "pair"; readonly code: string }
  | { readonly kind: "new"; readonly agent?: string }
  | { readonly kind: "sessions" }
  | { readonly kind: "use"; readonly index: number }
  | { readonly kind: "stop" }
  | { readonly kind: "status" }
  | { readonly kind: "help" }
  | { readonly kind: "unknown"; readonly name: string }

/** `undefined` = not a command at all (plain chat text — route it to the bound session).
 *  Telegram's group form `/cmd@BotName arg` is normalized (the @mention is how group members
 *  disambiguate bots); `/start` is Telegram's mandatory opener and reads as help. */
export function parse(text: string): Command | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/")) return undefined
  const [head = "", ...rest] = trimmed.slice(1).split(/\s+/)
  const name = (head.split("@")[0] ?? "").toLowerCase()
  if (name.length === 0 || !/^[a-z][a-z0-9_]*$/.test(name)) return undefined
  switch (name) {
    case "pair":
      return { kind: "pair", code: rest.join(" ").trim() }
    case "new":
      return rest[0] === undefined ? { kind: "new" } : { kind: "new", agent: rest[0] }
    case "sessions":
      return { kind: "sessions" }
    case "use": {
      const index = Number.parseInt(rest[0] ?? "", 10)
      return Number.isInteger(index) && index >= 1 ? { kind: "use", index } : { kind: "unknown", name }
    }
    case "stop":
      return { kind: "stop" }
    case "status":
      return { kind: "status" }
    case "help":
    case "start":
      return { kind: "help" }
    default:
      return { kind: "unknown", name }
  }
}
