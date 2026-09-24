import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("memory graph queries avoid direct id equality plans that miss restored rows", () => {
  const source = readFileSync(new URL("../src/kb-graph/wasm-engine.ts", import.meta.url), "utf8")
  const executable = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  expect(executable.match(/\bMATCH\s+[^`]*?\bMemory\s*\{\s*id\s*:\s*\$[a-z]/gi) ?? []).toEqual([])
  expect(executable.match(/\b[a-z]\.id\s*=\s*\$[a-z]/gi) ?? []).toEqual([])
})
