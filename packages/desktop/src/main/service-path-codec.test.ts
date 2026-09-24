import { expect, test } from "bun:test"
import { isAbsolute, join } from "node:path"
import { resolveServicePath, storeServicePath } from "./service-path-codec"

test("paths inside a copied instance home rebase while external paths remain absolute", () => {
  const source = join(process.cwd(), "source-home")
  const destination = join(process.cwd(), "destination-home")
  const owned = join(source, "tmp", "control.sock")
  const external = join(process.cwd(), "project", "main.ts")
  const stored = storeServicePath(source, owned)

  expect(isAbsolute(source)).toBe(true)
  expect(stored).toBe("novaclaw-home:/tmp/control.sock")
  expect(resolveServicePath(destination, stored)).toBe(join(destination, "tmp", "control.sock"))
  expect(storeServicePath(source, external)).toBe(external)
  expect(resolveServicePath(destination, external)).toBe(external)
  expect(() => resolveServicePath(destination, "novaclaw-home:/../escape")).toThrow()
  expect(() => resolveServicePath(destination, "novaclaw-home:/..\\escape")).toThrow()
})
