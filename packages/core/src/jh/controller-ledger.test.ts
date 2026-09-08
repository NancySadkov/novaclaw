import { expect, test } from "bun:test"
import fs from "node:fs"
import ts from "typescript"

// Controller fields must join the snapshot owner. This guard catches a new mutable closure local,
// the shape that originally let many individually correct guards disappear together on resume.
const outsideController = (source: string): string[] => {
  const file = ts.createSourceFile("engine.ts", source, ts.ScriptTarget.Latest, true)
  const run = file.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "runTask",
  )
  if (!run?.body) throw new Error("runTask is missing")
  const covered = new Set(["tree", "telemetry", "logArr", "seq", "completionVerified"])
  const result: string[] = []
  for (const statement of run.body.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const variable of statement.declarationList.declarations) {
      if (!ts.isIdentifier(variable.name)) continue
      const name = variable.name.text
      if (covered.has(name)) continue
      const mutable = !(statement.declarationList.flags & ts.NodeFlags.Const)
      const collection =
        variable.initializer &&
        ts.isNewExpression(variable.initializer) &&
        ["Map", "Set"].includes(variable.initializer.expression.getText(file))
      const container =
        variable.initializer &&
        (ts.isObjectLiteralExpression(variable.initializer) || ts.isArrayLiteralExpression(variable.initializer))
      if (mutable || container || (collection && name !== "SOURCE_EDIT_TOOLS")) result.push(name)
    }
  }
  return result
}

test("engine closure state belongs to the persisted controller or an explicit snapshot owner", () => {
  const source = fs.readFileSync(new URL("./engine.ts", import.meta.url), "utf8")
  expect(outsideController(source)).toEqual([])
  const mutated = source.replace(
    "  const workspaceBudget =",
    "  let forgottenBudget = 0\n  const forgottenTests = new Map()\n  const workspaceBudget =",
  )
  expect(outsideController(mutated)).toEqual(["forgottenBudget", "forgottenTests"])
})
