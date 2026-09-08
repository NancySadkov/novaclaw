export * as ShellApproval from "./shell-approval"

import path from "path"

export interface Redirect {
  readonly target: string
  readonly append: boolean
}

export type Analysis =
  | {
      readonly status: "parsed"
      readonly segments: ReadonlyArray<string>
      readonly redirects: ReadonlyArray<Redirect>
    }
  | { readonly status: "unparseable"; readonly reason: string }

type Family = "posix" | "powershell" | "cmd" | "unknown"

const familyOf = (shell: string): Family => {
  const name = path
    .basename(shell)
    .toLowerCase()
    .replace(/\.exe$/, "")
  if (name === "pwsh" || name === "powershell") return "powershell"
  if (name === "cmd") return "cmd"
  if (["bash", "sh", "ash", "dash", "zsh", "ksh"].includes(name)) return "posix"
  return "unknown"
}

/**
 * Translate a path written for the selected shell into the host spelling used by permission and
 * exclusion analysis. On Windows every accepted POSIX shell is an MSYS shell (w64devkit or Git
 * Bash), where `/c/...` means `C:/...`; Node's win32 resolver instead reads it as `C:/c/...`.
 */
export function hostPath(value: string, shell: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32" || familyOf(shell) !== "posix") return value
  const match = /^\/([A-Za-z])(?:\/(.*))?$/.exec(value)
  if (!match) return value
  return `${match[1]!.toUpperCase()}:/${match[2] ?? ""}`
}

const unquote = (value: string) => {
  const quote = value[0]
  return (quote === "'" || quote === '"') && value.at(-1) === quote ? value.slice(1, -1) : value
}

function tokenAfter(command: string, start: number, family: Family) {
  let index = start
  while (/\s/.test(command[index] ?? "")) index++
  const begin = index
  let quote: "'" | '"' | undefined
  let escaped = false
  for (; index < command.length; index++) {
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
    if (char === "'" && family !== "cmd") quote = "'"
    else if (char === '"') quote = '"'
    else if (/\s/.test(char) || ";|&<>".includes(char)) break
  }
  if (quote || escaped || index === begin) return undefined
  return { value: unquote(command.slice(begin, index)), end: index }
}

function matchingParen(command: string, open: number, family: Family): number | undefined {
  let depth = 1
  let quote: "'" | '"' | undefined
  let escaped = false
  for (let index = open + 1; index < command.length; index++) {
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
    if (char === "'" && family !== "cmd") quote = "'"
    else if (char === '"') quote = '"'
    else if (char === "(") depth++
    else if (char === ")" && --depth === 0) return index
  }
  return undefined
}

const dynamicTarget = (target: string) => /[$%`*?\[]/.test(target) || target.startsWith("~")

const sinkTarget = (target: string, family: Exclude<Family, "unknown">) =>
  (family === "posix" && /^\/dev\/(?:null|stdout|stderr|fd\/\d+)$/.test(target)) ||
  (family === "powershell" && target.toLowerCase() === "$null") ||
  (family === "cmd" && /^(?:nul|con|prn|aux)$/i.test(target))

function words(command: string, family: Exclude<Family, "unknown">): ReadonlyArray<string> | undefined {
  const result: string[] = []
  let index = 0
  while (index < command.length) {
    while (/\s/.test(command[index] ?? "") || ";|&<>()".includes(command[index] ?? "")) index++
    if (index >= command.length) break
    const token = tokenAfter(command, index, family)
    if (!token) return undefined
    result.push(token.value)
    index = token.end
  }
  return result
}

function commandRedirects(command: string, family: Exclude<Family, "unknown">): ReadonlyArray<Redirect> | "dynamic" {
  const tokens = words(command, family)
  if (!tokens?.length) return []
  const executable = path
    .basename(tokens[0]!)
    .toLowerCase()
    .replace(/\.exe$/, "")
  const targets: Array<{ target: string; append: boolean }> = []
  if (executable === "tee") {
    const append = tokens.includes("-a") || tokens.includes("--append")
    for (const token of tokens.slice(1)) if (!token.startsWith("-")) targets.push({ target: token, append })
  } else if (executable === "dd") {
    for (const token of tokens.slice(1))
      if (token.startsWith("of=")) targets.push({ target: unquote(token.slice(3)), append: false })
  } else if (["tee-object", "out-file", "set-content", "add-content"].includes(executable)) {
    const append = executable === "add-content" || tokens.some((token) => token.toLowerCase() === "-append")
    const named = tokens.findIndex((token) => ["-filepath", "-literalpath", "-path"].includes(token.toLowerCase()))
    const target = named >= 0 ? tokens[named + 1] : tokens[1]
    if (target && !target.startsWith("-")) targets.push({ target, append })
  }
  const realTargets = targets.filter((item) => !sinkTarget(item.target, family))
  return realTargets.some((item) => !item.target || dynamicTarget(item.target)) ? "dynamic" : realTargets
}

/**
 * Parse only syntax whose meaning is stable for the selected shell. This is approval reduction,
 * not containment: anything ambiguous becomes an attended ask instead of a guessed allow.
 */
export function analyze(command: string, shell: string): Analysis {
  const family = familyOf(shell)
  if (family === "unknown") return { status: "unparseable", reason: "unrecognised-shell" }
  return analyzeFamily(command, family, shell)
}

function analyzeFamily(command: string, family: Exclude<Family, "unknown">, shell: string): Analysis {
  const segments: string[] = []
  const nestedSegments: string[] = []
  const redirects: Redirect[] = []
  let start = 0
  let quote: "'" | '"' | undefined
  let escaped = false

  const push = (end: number) => {
    const segment = command.slice(start, end).trim()
    if (!segment) return false
    segments.push(segment)
    return true
  }
  const mergeNested = (inner: string): Analysis | undefined => {
    const parsed = analyzeFamily(inner, family, shell)
    if (parsed.status === "unparseable") return parsed
    nestedSegments.push(...parsed.segments)
    redirects.push(...parsed.redirects)
    return undefined
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

    if (char === "`" && family === "posix") {
      let close = index + 1
      for (; close < command.length && command[close] !== "`"; close++) if (command[close] === "\\") close++
      if (close >= command.length) return { status: "unparseable", reason: "unterminated-substitution" }
      const failed = mergeNested(command.slice(index + 1, close))
      if (failed) return failed
      index = close
      continue
    }
    if (char === "(") {
      const close = matchingParen(command, index, family)
      if (close === undefined) return { status: "unparseable", reason: "unterminated-substitution" }
      const failed = mergeNested(command.slice(index + 1, close))
      if (failed) return failed
      index = close
      continue
    }
    if (char === ")") return { status: "unparseable", reason: "unexpected-close-paren" }

    if (char === "&" && command[index + 1] === ">") {
      const append = command[index + 2] === ">"
      const target = tokenAfter(command, index + (append ? 3 : 2), family)
      if (!target || (!sinkTarget(target.value, family) && dynamicTarget(target.value)))
        return { status: "unparseable", reason: "dynamic-redirect-target" }
      if (!sinkTarget(target.value, family)) redirects.push({ target: target.value, append })
      index = target.end - 1
      continue
    }
    if (char === ">") {
      const append = command[index + 1] === ">"
      const afterOperator = index + (append ? 2 : 1)
      // `2>&1`/`>&2` duplicates a descriptor; it does not name a filesystem mutation.
      if (command[afterOperator] === "&") {
        const descriptor = tokenAfter(command, afterOperator + 1, family)
        if (!descriptor || !/^\d+$/.test(descriptor.value))
          return { status: "unparseable", reason: "dynamic-redirect-target" }
        index = descriptor.end - 1
        continue
      }
      const target = tokenAfter(command, afterOperator, family)
      if (!target || (!sinkTarget(target.value, family) && dynamicTarget(target.value)))
        return { status: "unparseable", reason: "dynamic-redirect-target" }
      if (!sinkTarget(target.value, family)) redirects.push({ target: target.value, append })
      index = target.end - 1
      continue
    }
    if (char === "<") {
      if (command[index + 1] === "<" || command[index + 1] === ">")
        return { status: "unparseable", reason: "structured-redirect" }
      const target = tokenAfter(command, index + 1, family)
      if (!target) return { status: "unparseable", reason: "dynamic-redirect-target" }
      index = target.end - 1
      continue
    }

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
  for (const segment of [...segments, ...nestedSegments]) {
    const commandWrites = commandRedirects(segment, family)
    if (commandWrites === "dynamic") return { status: "unparseable", reason: "dynamic-redirect-target" }
    redirects.push(...commandWrites)
  }
  return {
    status: "parsed",
    segments: [...new Set([...segments, ...nestedSegments])],
    redirects: [...new Map(redirects.map((item) => [item.target, item])).values()],
  }
}
