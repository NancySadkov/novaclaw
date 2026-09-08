import fs from "node:fs"
import path from "node:path"
import { GlobMatch } from "./glob-match"

/**
 * File-system globbing, owned. Replaces the `glob` package (2026-09-03, AGENTS.md principle 2):
 * the whole surface this tree used was `glob`/`globSync` with five options, over `node:fs`.
 *
 * ⚠️ Not `fs.glob`. Measured 2026-09-03: Bun's `fs.glob` refuses `withFileTypes` ("not supported
 * yet") and neither Bun's nor Node's exposes `dot`, `absolute`, `follow` or `nodir`, which are the
 * options every caller passes. So this walks the tree itself and filters with `GlobMatch`, which
 * is also what keeps the answer the same under bun (CLI, tests) and Node (the desktop sidecar).
 *
 * Semantics, pinned by `packages/novaclaw/test/util/glob.test.ts`:
 * - results are paths relative to `cwd` in the platform's separators, or absolute with `absolute`;
 * - `include: "file"` (the default) answers files only, `"all"` files and directories;
 * - `dot` (default false) hides dot entries from wildcards, as `GlobMatch` does; a dot directory is
 *   descended only when a literal segment of the pattern names it;
 * - `symlink` (default false) decides whether a symlinked directory is entered; a cycle is broken on
 *   the real path.
 * The walk starts at the pattern's static prefix and, for a pattern with no `**`, stops at the
 * pattern's depth, so `commands/**\/*.md` never reads a project's `node_modules`.
 */
export namespace Glob {
  export interface Options {
    cwd?: string
    absolute?: boolean
    include?: "file" | "all"
    dot?: boolean
    symlink?: boolean
  }

  export async function scan(pattern: string, options: Options = {}): Promise<string[]> {
    const plan = planFor(pattern, options)
    const out: string[] = []
    const seen = new Set<string>()
    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const step = await describe(dir, entry, plan.follow)
        if (step === undefined) continue
        const relative = rel ? `${rel}/${entry.name}` : entry.name
        emit(plan, out, relative, step, options)
        if (step.directory && descends(plan, relative, entry.name, depth) && !cycle(seen, step.real)) {
          await walk(path.join(dir, entry.name), relative, depth + 1)
        }
      }
    }
    // No existence probe: a start directory that is not there makes `readdir` fail, and the walk ends.
    await walk(plan.start, plan.prefix, plan.prefixDepth)
    return out
  }

  export function scanSync(pattern: string, options: Options = {}): string[] {
    const plan = planFor(pattern, options)
    const out: string[] = []
    const seen = new Set<string>()
    const walk = (dir: string, rel: string, depth: number): void => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const step = describeSync(dir, entry, plan.follow)
        if (step === undefined) continue
        const relative = rel ? `${rel}/${entry.name}` : entry.name
        emit(plan, out, relative, step, options)
        if (step.directory && descends(plan, relative, entry.name, depth) && !cycle(seen, step.real)) {
          walk(path.join(dir, entry.name), relative, depth + 1)
        }
      }
    }
    walk(plan.start, plan.prefix, plan.prefixDepth)
    return out
  }

  /** `dot: true` always: every caller of this is an ignore or watch list, where a dotfile is a file. */
  export function match(pattern: string, filepath: string): boolean {
    return GlobMatch.match(pattern, filepath, { dot: true })
  }

  // ─── the walk ──────────────────────────────────────────────────────────────────────────────────

  interface Plan {
    readonly root: string
    readonly start: string
    readonly prefix: string
    readonly prefixDepth: number
    readonly matcher: GlobMatch.Matcher
    readonly maxDepth: number | undefined
    readonly dot: boolean
    readonly follow: boolean
    readonly literalDotDirs: ReadonlySet<string>
  }

  interface Step {
    readonly file: boolean
    readonly directory: boolean
    readonly real: string | undefined
  }

  function planFor(pattern: string, options: Options): Plan {
    const root = path.resolve(options.cwd ?? process.cwd())
    const prefixSegments = GlobMatch.staticPrefix(pattern)
    const prefix = prefixSegments.join("/")
    const alternatives = GlobMatch.expandBraces(pattern)
    const depths = alternatives.map((alternative) => GlobMatch.splitSegments(alternative).length)
    const literalDotDirs = new Set<string>()
    for (const alternative of alternatives) {
      const segments = GlobMatch.splitSegments(alternative)
      segments.slice(0, -1).forEach((segment, index) => {
        if (segment.startsWith(".") && !GlobMatch.hasMagic(segment)) literalDotDirs.add(`${index}:${segment}`)
      })
    }
    return {
      root,
      start: prefixSegments.length ? path.join(root, ...prefixSegments) : root,
      prefix,
      prefixDepth: prefixSegments.length,
      matcher: GlobMatch.compile(pattern, { dot: options.dot === true }),
      maxDepth: GlobMatch.hasGlobstar(pattern) ? undefined : Math.max(...depths),
      dot: options.dot === true,
      follow: options.symlink === true,
      literalDotDirs,
    }
  }

  function emit(plan: Plan, out: string[], relative: string, step: Step, options: Options): void {
    const wanted = options.include === "all" ? step.file || step.directory : step.file
    if (!wanted || !plan.matcher(relative)) return
    const native = relative.split("/").join(path.sep)
    out.push(options.absolute ? path.join(plan.root, native) : native)
  }

  /** Whether the walk enters `relative` (a directory at `depth`, named `name`). */
  function descends(plan: Plan, relative: string, name: string, depth: number): boolean {
    if (plan.maxDepth !== undefined && depth + 1 >= plan.maxDepth) return false
    if (!plan.dot && name.startsWith(".") && !plan.literalDotDirs.has(`${depth}:${name}`)) return false
    void relative
    return true
  }

  function cycle(seen: Set<string>, real: string | undefined): boolean {
    if (real === undefined) return false
    if (seen.has(real)) return true
    seen.add(real)
    return false
  }

  async function describe(dir: string, entry: fs.Dirent, follow: boolean): Promise<Step | undefined> {
    if (entry.isSymbolicLink()) {
      if (!follow) return { file: false, directory: false, real: undefined }
      try {
        const full = path.join(dir, entry.name)
        const stat = await fs.promises.stat(full)
        return {
          file: stat.isFile(),
          directory: stat.isDirectory(),
          real: stat.isDirectory() ? await fs.promises.realpath(full) : undefined,
        }
      } catch {
        return undefined
      }
    }
    return { file: entry.isFile(), directory: entry.isDirectory(), real: undefined }
  }

  function describeSync(dir: string, entry: fs.Dirent, follow: boolean): Step | undefined {
    if (entry.isSymbolicLink()) {
      if (!follow) return { file: false, directory: false, real: undefined }
      try {
        const full = path.join(dir, entry.name)
        const stat = fs.statSync(full)
        return {
          file: stat.isFile(),
          directory: stat.isDirectory(),
          real: stat.isDirectory() ? fs.realpathSync(full) : undefined,
        }
      } catch {
        return undefined
      }
    }
    return { file: entry.isFile(), directory: entry.isDirectory(), real: undefined }
  }
}
