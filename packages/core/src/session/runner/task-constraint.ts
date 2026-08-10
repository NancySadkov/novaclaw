export * as TaskConstraint from "./task-constraint"

import { Effect } from "effect"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import type { JhBasicTools } from "../../jh/tools-basic"

type Loader = "js" | "jsx" | "ts" | "tsx"

const LOADERS = new Map<string, Loader>([
  [".js", "js"],
  [".mjs", "js"],
  [".cjs", "js"],
  [".jsx", "jsx"],
  [".ts", "ts"],
  [".mts", "ts"],
  [".cts", "ts"],
  [".tsx", "tsx"],
])

const WRITE_TOOLS = new Set(["write_file", "append_file", "edit_file", "replace_lines"])
const SKIP_DIRS = new Set([".git", "node_modules"])

/** The explicit contract this guard can prove. It deliberately does not guess from a generic task. */
export function requestsCommentOnly(task: string): boolean {
  return (
    /\b(?:do not|don't|must not)\s+(?:change|modify|alter)\s+(?:any\s+)?(?:logic|behavio(?:u)?r|functionality)\b/i.test(
      task,
    ) ||
    /\bwithout\s+(?:changing|modifying|altering)\s+(?:any\s+)?(?:logic|behavio(?:u)?r|functionality)\b/i.test(task) ||
    /\b(?:comments?|documentation|jsdoc)\s+only\b/i.test(task)
  )
}

/**
 * Executable JS/TS after Bun has parsed it and removed comments/types. Equal signatures mean the
 * source has the same runtime program; unlike a textual comment stripper, strings containing `//`
 * or `/*` cannot fool it.
 */
export function executableSignature(filename: string, source: string): string | undefined {
  const loader = LOADERS.get(path.extname(filename).toLowerCase())
  if (loader === undefined) return undefined
  try {
    if (typeof Bun !== "undefined") return new Bun.Transpiler({ loader }).transformSync(source)

    // The packaged Electron sidecar is plain Node, where touching Bun at module initialisation used
    // to crash the whole app before it could report healthy. Node 24's own TypeScript transformer
    // provides the same useful property here: comments and types disappear while executable tokens
    // remain. Load it only on the Node branch because Bun 1.3.14 does not expose this named export.
    const nodeModule = createRequire(import.meta.url)("node:module") as {
      stripTypeScriptTypes(input: string, options: { mode: "transform" }): string
    }
    return nodeModule.stripTypeScriptTypes(source, { mode: "transform" })
  } catch {
    return undefined
  }
}

interface Entry {
  /** Undefined means the task-start source did not parse; any textual change is then unprovable. */
  readonly signature: string | undefined
  allowedSource: string
}

export interface CommentOnlyGuard {
  readonly cwd: string
  readonly entries: Map<string, Entry>
}

const relative = (cwd: string, target: string): string | undefined => {
  const root = path.resolve(cwd)
  const absolute = path.resolve(cwd, target)
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return undefined
  return path.relative(root, absolute).split(path.sep).join("/")
}

const visit = (cwd: string, dir: string, entries: Map<string, Entry>): void => {
  let children: fs.Dirent[]
  try {
    children = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const child of children) {
    if (child.isSymbolicLink()) continue
    const absolute = path.join(dir, child.name)
    if (child.isDirectory()) {
      if (!SKIP_DIRS.has(child.name)) visit(cwd, absolute, entries)
      continue
    }
    if (!child.isFile() || !LOADERS.has(path.extname(child.name).toLowerCase())) continue
    try {
      const source = fs.readFileSync(absolute, "utf8")
      const signature = executableSignature(child.name, source)
      const rel = relative(cwd, absolute)
      if (rel !== undefined) entries.set(rel, { signature, allowedSource: source })
    } catch {}
  }
}

/** Capture the task-start program. Undefined means the user declared no mechanically recognised contract. */
export function capture(task: string, cwd: string): CommentOnlyGuard | undefined {
  if (!requestsCommentOnly(task)) return undefined
  const entries = new Map<string, Entry>()
  visit(cwd, cwd, entries)
  return { cwd: path.resolve(cwd), entries }
}

const restore = (guard: CommentOnlyGuard, rel: string, entry: Entry | undefined): void => {
  const absolute = path.join(guard.cwd, rel)
  if (entry === undefined) {
    try {
      fs.rmSync(absolute, { force: true })
    } catch {}
    return
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, entry.allowedSource, "utf8")
}

const inspect = (guard: CommentOnlyGuard, paths: ReadonlySet<string>): ReadonlyArray<string> => {
  const violations: string[] = []
  for (const rel of paths) {
    const entry = guard.entries.get(rel)
    const absolute = path.join(guard.cwd, rel)
    let source: string | undefined
    try {
      source = fs.readFileSync(absolute, "utf8")
    } catch {}
    const signature = source === undefined ? undefined : executableSignature(rel, source)
    const changed =
      entry === undefined ||
      source === undefined ||
      (entry.signature === undefined ? source !== entry.allowedSource : signature !== entry.signature)
    if (changed) {
      violations.push(rel)
      restore(guard, rel, entry)
      continue
    }
    // This was a permitted comment-only edit. It becomes the restore point for later actions, so a
    // bad second edit cannot erase documentation that the first action already added correctly.
    entry.allowedSource = source as string
  }
  return violations
}

/**
 * Enforce the contract after every state-changing atom and restore before returning the observation.
 * A shell command can touch any task-start source file, so `run` checks all of them. A native write
 * names its one target, which keeps the ordinary path O(1) and also catches attempts to add code.
 */
export function guardingExecutor(
  inner: JhBasicTools.Executor,
  guard: CommentOnlyGuard | undefined,
): JhBasicTools.Executor {
  if (guard === undefined) return inner
  return {
    run: (input) =>
      inner.run(input).pipe(
        Effect.map((observation) => {
          const paths = new Set<string>()
          if (input.tool === "run") {
            for (const rel of guard.entries.keys()) paths.add(rel)
            // A shell command has no declared target. Walk after it settles so creating a new source
            // file cannot bypass the same guard that a native `write_file` would hit.
            const current = new Map<string, Entry>()
            visit(guard.cwd, guard.cwd, current)
            for (const rel of current.keys()) paths.add(rel)
          } else if (WRITE_TOOLS.has(input.tool) && typeof input.args.path === "string") {
            const rel = relative(guard.cwd, input.args.path)
            if (rel !== undefined && LOADERS.has(path.extname(rel).toLowerCase())) paths.add(rel)
          }
          if (paths.size === 0) return observation
          const violations = inspect(guard, paths)
          if (violations.length === 0) return observation
          return {
            ok: false,
            output: `comment-only constraint refused and restored executable changes in: ${violations.join(", ")}. Add documentation without changing logic.`,
            artifacts: new Map(),
          }
        }),
      ),
  }
}
