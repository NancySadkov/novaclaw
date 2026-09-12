const kindOf = (value: string): "windows" | "unc" | "posix" | undefined => {
  if (/^[A-Za-z]:[\\/]/.test(value)) return "windows"
  if (/^(?:\\\\|\/\/)/.test(value)) return "unc"
  if (value.startsWith("/")) return "posix"
  return undefined
}

/** Resolve a model-authored tool path against the instance host's working directory, in host style. */
export function absoluteDisplayPath(directory: string | undefined, target: unknown): string | undefined {
  if (typeof target !== "string" || target.length === 0) return undefined
  const targetKind = kindOf(target)
  const directoryKind = directory ? kindOf(directory) : undefined
  if (!targetKind && !directoryKind) return undefined

  const combined = targetKind ? target : `${directory!.replace(/[\\/]+$/, "")}/${target}`
  const kind = targetKind ?? directoryKind!
  const slash = combined.replaceAll("\\", "/")
  const drive = kind === "windows" ? slash.slice(0, 2) : ""
  const body = kind === "windows" ? slash.slice(2) : kind === "unc" ? slash.replace(/^\/+/, "") : slash.slice(1)
  const parts: string[] = []
  const floor = kind === "unc" ? 2 : 0
  for (const part of body.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (parts.length > floor) parts.pop()
      continue
    }
    parts.push(part)
  }

  const normalized =
    kind === "windows" ? `${drive}/${parts.join("/")}` : `${kind === "unc" ? "//" : "/"}${parts.join("/")}`
  return kind === "posix" ? normalized : normalized.replaceAll("/", "\\")
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined

const appliedTargets = (value: unknown): unknown[] => {
  const applied = object(value)?.applied
  if (!Array.isArray(applied)) return []
  return applied.map((entry) => object(entry)?.target ?? object(entry)?.resource)
}

const patchTargets = (patchText: unknown): string[] => {
  if (typeof patchText !== "string") return []
  return [...patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1]!.trim())
}

/** Absolute targets to put at the top of an expanded file-mutation card. */
export function fileMutationDisplayPaths(input: {
  name: string
  args: Record<string, unknown>
  result?: unknown
  structured?: unknown
  directory?: string
}): string[] {
  let targets: unknown[]
  switch (input.name) {
    case "edit":
    case "write":
      targets = [input.args.path ?? input.args.filePath]
      break
    case "write-hex":
    case "write_hex":
      targets = [input.args.filename ?? input.args.path]
      break
    case "apply_patch": {
      const settled = [...appliedTargets(input.result), ...appliedTargets(input.structured)]
      targets = settled.length > 0 ? settled : patchTargets(input.args.patchText)
      break
    }
    default:
      return []
  }

  const seen = new Set<string>()
  const paths: string[] = []
  for (const target of targets) {
    const path = absoluteDisplayPath(input.directory, target)
    if (!path) continue
    const key = kindOf(path) === "posix" ? path : path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    paths.push(path)
  }
  return paths
}
