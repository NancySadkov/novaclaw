import fs from "node:fs"
import path from "node:path"
import ts from "typescript"

export type LogSiteKind = "keyed" | "unkeyed"

export interface LogSite {
  readonly kind: LogSiteKind
  readonly name: string
  /**
   * Does this call put a name the FORMATTER already owns onto the line a second time?
   *
   * Two ways it happens, both reproduced in `log-events.test.ts`: an attribute literally named
   * `cause`/`level`/`message`/… (see `RESERVED_ATTRIBUTES`), or a second POSITIONAL argument, which
   * the formatter maps onto `message` alongside the first. Either emits one key twice and breaks the
   * naive `grep`/`cut` mining that logging item 1 exists to deliver.
   *
   * ⚠️ Tracked on the site rather than counted by a separate scan, because a second scanner is a
   * second answer: a regex version of this shipped on 2026-08-06 and counted a `cause` mentioned in a
   * DOC COMMENT as a live defect. The AST cannot make that mistake.
   */
  readonly reserved: boolean
}

export interface LedgerEntry {
  readonly name: string
  readonly count: number
}

/** The columns `observability/logging.ts` already emits; an attribute reusing one duplicates it. */
const RESERVED_NAMES = new Set(["timestamp", "level", "run", "event", "message", "cause"])

/** Does any argument reuse a formatter-owned name, or add a second positional message part? */
const reusesReservedName = (node: ts.CallExpression): boolean => {
  const [, ...rest] = node.arguments
  for (const argument of rest) {
    if (!ts.isObjectLiteralExpression(argument)) return true
    for (const property of argument.properties) {
      const name =
        property.name === undefined
          ? undefined
          : ts.isIdentifier(property.name)
            ? property.name.text
            : ts.isStringLiteralLike(property.name)
              ? property.name.text
              : undefined
      if (name !== undefined && RESERVED_NAMES.has(name)) return true
    }
  }
  return false
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
    // 🔴 **A REFERENCE to `Effect.log*` counts, not just a call.** `const write = Effect.logDebug`
    // followed by `write(message)` is a direct log by any honest reading, and it was invisible here
    // until 2026-08-07 because the check below only matched call expressions. That is not theoretical:
    // `httpapi/handlers/control.ts` selects a level that way, so a live site sat inside the blind spot
    // of a ledger whose own comment claims no direct call survives ANYWHERE in shipping source.
    // ⚠️ A guard that can be stepped around by assigning the function to a variable is a guard whose
    // scope is "authors who did not think of that".
    if (
      ts.isPropertyAccessExpression(node) &&
      !ts.isCallExpression(node.parent) &&
      node.expression.getText(source) === "Effect" &&
      /^log[A-Z]/.test(node.name.text)
    ) {
      sites.push({
        kind: "unkeyed",
        name: `${file} :: Effect.${node.name.text} (referenced, not called)`,
        reserved: false,
      })
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression.getText(source)
      const method = node.expression.name.text
      if (receiver === "Effect" && /^log[A-Z]/.test(method)) {
        sites.push({
          kind: "unkeyed",
          name: `${file} :: Effect.${method}(${normalizedArgument(node.arguments[0], source)})`,
          reserved: reusesReservedName(node),
        })
      } else if (receiver === "Log" && method === "event") {
        sites.push({
          // A keyed call cannot collide: `log-events.ts` refuses a reserved attribute name at the
          // declaration, and `log-events.test.ts` is the mechanical check for that.
          kind: "keyed",
          name: `${file} :: Log.event(${normalizedArgument(node.arguments[0], source)})`,
          reserved: false,
        })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return sites
}

// ── the attribute half ( 1h) ─────────────────────────────────────────────────────

/** One `name: <expression>` assignment inside a `Log.event(key, { … })` call. */
export interface AttributeSite {
  readonly file: string
  readonly key: string
  readonly name: string
  /** The value expression, with the *contents* of balanced parens collapsed to `(…)`. */
  readonly shape: string
  /** The value expression as written, whitespace-collapsed. For the failure message. */
  readonly expression: string
}

/**
 * Collapse the CONTENTS of a call's parentheses, so the ledger keys on the normalization SHAPE
 * (`String(…)`, `Cause.pretty(…)`) rather than on the local variable somebody happened to name.
 * A rename must not churn the ledger; a change of shape must.
 */
export const valueShape = (expression: string): string => expression.replace(/\((?:[^()]|\([^()]*\))*\)/g, "(…)")

/** Every attribute assignment at every `Log.event` call in one source text. */
export const scanAttributeSource = (file: string, sourceText: string): readonly AttributeSite[] => {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true)
  const sites: AttributeSite[] = []

  const propertyName = (property: ts.ObjectLiteralElementLike): string | undefined =>
    property.name === undefined
      ? undefined
      : ts.isIdentifier(property.name)
        ? property.name.text
        : ts.isStringLiteralLike(property.name)
          ? property.name.text
          : undefined

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(source) === "Log" &&
      node.expression.name.text === "event"
    ) {
      const [keyArgument, attributeArgument] = node.arguments
      if (keyArgument !== undefined && ts.isStringLiteralLike(keyArgument) && attributeArgument !== undefined) {
        const key = keyArgument.text
        if (ts.isObjectLiteralExpression(attributeArgument)) {
          for (const property of attributeArgument.properties) {
            if (!ts.isPropertyAssignment(property)) continue // shorthand / spread carry no expression
            const name = propertyName(property)
            if (name === undefined) continue
            const expression = property.initializer.getText(source).replace(/\s+/g, " ").trim()
            sites.push({ file, key, name, expression, shape: valueShape(expression) })
          }
        }
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

/**
 * 🔴 **The ONE file that may touch `Effect.log*`: the keyed logger's own implementation.**
 *
 * `schema/log.ts` IS `Log.event` — it dispatches through a `LOG_AT[level]` table of Effect's loggers.
 * Something has to call Effect eventually, and that something is not a "caller" in the sense this
 * ledger polices; excluding it DEFINES the boundary rather than weakening the rule. Everything else
 * in every package's `src` is held to the absolute rule.
 *
 * ⚠️ **This is one FILE, named explicitly — not a list that accepts additions.** An allowance array
 * was deliberately deleted when the migration hit zero, because an empty array reads as "add your
 * entry here"; a single named path keeps that property. Adding a second entry should require arguing
 * that a second file implements the logger.
 *
 * ⚠️ An earlier note claimed this file "does not call `Effect.log*`, so it needs no carve-out". That
 * was accidentally true and substantively wrong: it REFERENCES them in the dispatch table, which the
 * scanner could not see until references were added to it on 2026-08-07.
 */
const LOGGER_IMPLEMENTATION = "packages/schema/src/log.ts"

/** Walk the shipping source boundary named by ``: every package's `src` tree. */
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
        if (relative === LOGGER_IMPLEMENTATION) return []
        return scanLogSource(relative, fs.readFileSync(file, "utf8"))
      })
    })
}

/** The same walk as {@link scanPackageSources}, for attribute assignments. */
export const scanPackageAttributes = (root: string): readonly AttributeSite[] => {
  const packages = path.join(root, "packages")
  return fs
    .readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const sourceRoot = path.join(packages, entry.name, "src")
      if (!fs.existsSync(sourceRoot)) return []
      return sourceFiles(sourceRoot).flatMap((file) => {
        const text = fs.readFileSync(file, "utf8")
        if (!text.includes("Log.event(")) return []
        return scanAttributeSource(path.relative(root, file).replaceAll(path.sep, "/"), text)
      })
    })
}

/** Roll attribute sites up into the ledger's `{name, count}` shape. */
export const countAttributes = (sites: readonly AttributeSite[]): readonly LedgerEntry[] => {
  const counts = new Map<string, number>()
  for (const site of sites) {
    const name = `${site.file} :: ${site.key}.${site.name} = ${site.shape}`
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => left.name.localeCompare(right.name))
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
