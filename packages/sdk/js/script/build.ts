#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { emit } from "./emitter"

// `packages/sdk/openapi.json` is the one committed wire contract. The root regeneration script
// refreshes it before calling this emitter; there is no private second spec that can lag by one run.
const openapi = path.resolve(dir, "../openapi.json")
const document = (await Bun.file(openapi).json()) as any
const schemas = document.components?.schemas
if (schemas) {
  const reachable = new Set<string>()
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/components/schemas/")) {
        const name = child.slice("#/components/schemas/".length)
        if (reachable.has(name)) continue
        reachable.add(name)
        visit(schemas[name])
      } else {
        visit(child)
      }
    }
  }
  visit({ ...document, components: { ...document.components, schemas: undefined } })
  for (const name of Object.keys(schemas)) {
    if (/^SessionNext\w+1$/.test(name) && !reachable.has(name)) delete schemas[name]
  }
}

await emit(document, path.join(dir, "src/v2/gen"))

await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
