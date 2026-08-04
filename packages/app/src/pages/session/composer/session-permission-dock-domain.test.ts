import { expect, test } from "bun:test"
import type { PermissionV2Request } from "@novaclaw/sdk/v2"
import { permissionOtherResources, permissionTargets } from "./session-permission-dock-domain"

const request = (input: Partial<PermissionV2Request>) =>
  ({ resources: [], ...input }) as Pick<PermissionV2Request, "metadata" | "resources">

test("leads with concrete permission targets and removes their duplicate resource rows", () => {
  const input = request({
    resources: ["C:/outside/a.ts", "C:/outside/b.ts", "edit"],
    metadata: { targets: ["C:/outside/a.ts", "C:/outside/b.ts"] },
  })
  expect(permissionTargets(input)).toEqual(["C:/outside/a.ts", "C:/outside/b.ts"])
  expect(permissionOtherResources(input)).toEqual(["edit"])
})

test("keeps ordinary permission requests unchanged", () => {
  const input = request({ resources: ["src/a.ts"], metadata: { reason: "ordinary" } })
  expect(permissionTargets(input)).toEqual([])
  expect(permissionOtherResources(input)).toEqual(["src/a.ts"])
})

test("ignores malformed target metadata instead of rendering non-path values", () => {
  const input = request({ resources: ["src/a.ts"], metadata: { targets: ["", 42, null] } })
  expect(permissionTargets(input)).toEqual([])
  expect(permissionOtherResources(input)).toEqual(["src/a.ts"])
})
