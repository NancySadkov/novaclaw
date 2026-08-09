export * as ShellApproval from "./shell-approval"

import path from "path"

export type Analysis =
  | { readonly status: "parsed"; readonly segments: ReadonlyArray<string> }
  | { readonly status: "unparseable"; readonly reason: string }

type Family = "posix" | "powershell" | "cmd" | "unknown"

const familyOf = (shell: string): Family => {
  const name = path.basename(shell).toLowerCase().replace(/\.exe$/, "")
  if (name === "pwsh" || name === "powershell") return "powershell"
  if (name === "cmd") return "cmd"
  if (["bash", "sh", "ash", "dash", "zsh", "ksh"].includes(name)) return "posix"
  return "unknown"
}

/**
 * Split only syntax whose meaning is stable for the selected shell. This is approval reduction,
 * not containment: anything ambiguous becomes an attended ask instead of a guessed allow.
 */
export function analyze(command: string, shell: string): Analysis {
  const family = familyOf(shell)
  if (family === "unknown") return { status: "unparseable", reason: "unrecognised-shell" }

  const segments: string[] = []
  let start = 0
  let quote: "'" | '"' | undefined
  let escaped = false

  const push = (end: number) => {
    const segment = command.slice(start, end).trim()
    if (!segment) return false
    segments.push(segment)
    return true
  }

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (escaped) {
      escaped = false
      continue
    }
    const escape = family === "powershell" ? "`" : family === "cmd" ? "^" : "\\"
    if (char === escape && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" && family !== "cmd") {
      quote = "'"
      continue
    }
    if (char === '"') {
      quote = '"'
      continue
    }

    // Subshells, substitutions and redirects need an AST to attribute safely. Asking is honest;
    // pretending a lexical split understood them would turn this reduction into a fake boundary.
    if (char === "(" || char === ")" || char === "`" || char === ">" || char === "<")
      return { status: "unparseable", reason: "structured-shell-syntax" }

    const two = command.slice(index, index + 2)
    const separator =
      two === "&&" || two === "||"
        ? two
        : char === ";" || char === "|" || char === "\n" || (char === "&" && family !== "powershell")
          ? char
          : undefined
    if (!separator || (family === "cmd" && separator === ";")) continue
    if (!push(index)) return { status: "unparseable", reason: "empty-chain-segment" }
    index += separator.length - 1
    start = index + 1
  }

  if (quote || escaped) return { status: "unparseable", reason: "unterminated-quote-or-escape" }
  if (!push(command.length)) return { status: "unparseable", reason: "empty-chain-segment" }
  return { status: "parsed", segments }
}
