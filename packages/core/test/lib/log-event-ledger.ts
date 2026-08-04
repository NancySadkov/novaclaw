import fs from "node:fs"
import path from "node:path"
import ts from "typescript"

export type LogSiteKind = "keyed" | "unkeyed"

export interface LogSite {
  readonly kind: LogSiteKind
  readonly name: string
}

export interface LedgerEntry {
  readonly name: string
  readonly count: number
}

const SOURCE_EXTENSIONS = new Set([".cts", ".js", ".jsx", ".mts", ".ts", ".tsx"])

const normalizedArgument = (node: ts.Expression | undefined, source: ts.SourceFile): string => {
  if (node === undefined) return "<no argument>"
  if (ts.isStringLiteralLike(node)) return JSON.stringify(node.text)
  return node.getText(source).replace(/\s+/g, " ").trim()
}

/** Parse calls rather than grepping text: comments and wrapped/multiline arguments are not sites. */
export const scanLogSource = (file: string, sourceText: string): readonly LogSite[] => {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true)
  const sites: LogSite[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression.getText(source)
      const method = node.expression.name.text
      if (receiver === "Effect" && /^log[A-Z]/.test(method)) {
        sites.push({
          kind: "unkeyed",
          name: `${file} :: Effect.${method}(${normalizedArgument(node.arguments[0], source)})`,
        })
      } else if (receiver === "Log" && method === "event") {
        sites.push({
          kind: "keyed",
          name: `${file} :: Log.event(${normalizedArgument(node.arguments[0], source)})`,
        })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return sites
}

const sourceFiles = (directory: string): readonly string[] => {
  const found: string[] = []
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) found.push(full)
    }
  }
  walk(directory)
  return found.sort()
}

/** Walk the shipping source boundary named by `todo/logging.md`: every package's `src` tree. */
export const scanPackageSources = (root: string): readonly LogSite[] => {
  const packages = path.join(root, "packages")
  return fs
    .readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const sourceRoot = path.join(packages, entry.name, "src")
      if (!fs.existsSync(sourceRoot)) return []
      return sourceFiles(sourceRoot).flatMap((file) => {
        const relative = path.relative(root, file).replaceAll(path.sep, "/")
        return scanLogSource(relative, fs.readFileSync(file, "utf8"))
      })
    })
}

export const countSites = (sites: readonly LogSite[], kind: LogSiteKind): readonly LedgerEntry[] => {
  const counts = new Map<string, number>()
  for (const site of sites) {
    if (site.kind === kind) counts.set(site.name, (counts.get(site.name) ?? 0) + 1)
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** Two-way ratchet: new bare calls and already-migrated ledger entries are different failures. */
export const ledgerFaults = (
  actual: readonly LedgerEntry[],
  ledger: readonly LedgerEntry[],
): { readonly unlisted: readonly string[]; readonly stale: readonly string[] } => {
  const actualCounts = new Map(actual.map((entry) => [entry.name, entry.count]))
  const ledgerCounts = new Map(ledger.map((entry) => [entry.name, entry.count]))
  const names = new Set([...actualCounts.keys(), ...ledgerCounts.keys()])
  const unlisted: string[] = []
  const stale: string[] = []

  for (const name of [...names].sort()) {
    const found = actualCounts.get(name) ?? 0
    const allowed = ledgerCounts.get(name) ?? 0
    if (found > allowed) unlisted.push(name + " (+" + (found - allowed) + " unledgered)")
    if (allowed > found) stale.push(name + " (-" + (allowed - found) + "; drop or decrement the ledger entry)")
  }
  return { unlisted, stale }
}
