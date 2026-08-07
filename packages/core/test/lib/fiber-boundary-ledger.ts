import fs from "node:fs"
import path from "node:path"
import ts from "typescript"

/**
 * 🔴 **Effects run inside a plain `async` callback start with DEFAULT fiber references.**
 *
 * `Effect.promise(async () => …)` is ordinary JavaScript: the fiber is gone. So an `Effect.runPromise`
 * in there begins a NEW fiber with default references, and anything the surrounding program set —
 * `References.MinimumLogLevel` being the one that got noticed — silently reverts.
 *
 * ⚠️ **The symptom is a setting that quietly stops working, which is why this needs a machine.**
 * `NOVACLAW_LOG_LEVEL=DEBUG` was a no-op on the CLI `run` path for long enough to accumulate TWO
 * withdrawn root causes before the third was proven (2026-08-07, three-way control). Nothing about the
 * call site looks wrong; the code reads correctly and behaves correctly except for the references.
 *
 * ⭐ **And the cure already existed in the tree.** `local-model/runtime.ts` captures the context
 * explicitly — one file, solved once, never generalised. The tree held both the disease and the cure
 * and nothing connected them. That is what a ledger is for.
 *
 * **The fix, and therefore what clears a site:** capture the context before the boundary
 * (`Effect.context<never>()`) and provide it at the entry (`Effect.provide(captured)`), or use a
 * `*With` runner that takes one (`Effect.runForkWith(ctx)`).
 */
export interface Crossing {
  /** Repo-relative path, forward slashes. */
  readonly file: string
  /** 1-indexed line of the offending `Effect.run*` call. */
  readonly line: number
  /** e.g. `Effect.runPromise`. */
  readonly call: string
}

const RUNNERS = /^run(Promise|Sync|Fork|Callback)$/
/** `Effect.provide(…)` anywhere in the argument, or a `*With` runner, means the author carried it. */
const CARRIES_CONTEXT = /Effect\.provide\b|Effect\.provideService\b|run\w+With\b/

const isEffectCall = (node: ts.Node, predicate: (method: string) => boolean): string | undefined => {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined
  const receiver = node.expression.expression
  if (!ts.isIdentifier(receiver) || receiver.text !== "Effect") return undefined
  const method = node.expression.name.text
  return predicate(method) ? method : undefined
}

/** Every `Effect.run*` lexically inside an `Effect.promise(async …)` body that carries no context. */
export const scanCrossings = (file: string, sourceText: string): readonly Crossing[] => {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true)
  const found: Crossing[] = []

  const walkInsideBoundary = (node: ts.Node): void => {
    const runner = isEffectCall(node, (method) => RUNNERS.test(method))
    if (runner) {
      // ⚠️ Checked on the CALL's own text, not the file's: a `Effect.provide` elsewhere in the
      // function would otherwise clear a site that never carries anything.
      if (!CARRIES_CONTEXT.test(node.getText(source))) {
        found.push({
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          call: `Effect.${runner}`,
        })
      }
    }
    ts.forEachChild(node, walkInsideBoundary)
  }

  const walk = (node: ts.Node): void => {
    const promise = isEffectCall(node, (method) => method === "promise")
    const argument = promise ? node.getChildren(source) && (node as ts.CallExpression).arguments[0] : undefined
    const isAsyncCallback =
      argument !== undefined &&
      (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) &&
      argument.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true
    if (isAsyncCallback && argument) {
      walkInsideBoundary(argument.body)
      return // the subtree is accounted for
    }
    ts.forEachChild(node, walk)
  }

  walk(source)
  return found
}

const sourceFiles = (directory: string): readonly string[] => {
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) out.push(full)
    }
  }
  walk(directory)
  return out.sort()
}

/** Every package's `src` tree — the same shipping-source boundary the log-event ledger uses. */
export const scanWorkspace = (root: string): readonly Crossing[] => {
  const packages = path.join(root, "packages")
  return fs
    .readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const sourceRoot = path.join(packages, entry.name, "src")
      if (!fs.existsSync(sourceRoot)) return []
      return sourceFiles(sourceRoot).flatMap((file) =>
        scanCrossings(path.relative(root, file).replaceAll(path.sep, "/"), fs.readFileSync(file, "utf8")),
      )
    })
}
