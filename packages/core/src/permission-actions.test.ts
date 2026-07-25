import { describe, expect, test } from "bun:test"
import { PermissionV2 } from "./permission"
import { LocationMutation } from "./location-mutation"

// 1I + 1J pure-logic coverage: the split action granularity (read-class external access never
// authorizes write-class) and the denial-as-observation message lowering.

const auth = { directory: "C:/soft/w64devkit", resource: "C:/soft/w64devkit/*", save: "C:/soft/w64devkit/*" }

describe("externalDirectoryPermission — classed access (1I)", () => {
  test("read access maps to external_directory_read", () => {
    expect(LocationMutation.externalDirectoryPermission(auth, "read")).toEqual({
      action: "external_directory_read",
      resources: ["C:/soft/w64devkit/*"],
      save: ["C:/soft/w64devkit/*"],
    })
  })

  test("write access maps to external_directory_write", () => {
    expect(LocationMutation.externalDirectoryPermission(auth, "write").action).toBe("external_directory_write")
  })

  test("a saved READ grant does not satisfy a WRITE check (the w64devkit case)", () => {
    const savedReadGrant = [{ action: "external_directory_read", resource: "C:/soft/w64devkit/*", effect: "allow" as const }]
    const read = PermissionV2.evaluate("external_directory_read", "C:/soft/w64devkit/bin", savedReadGrant)
    const write = PermissionV2.evaluate("external_directory_write", "C:/soft/w64devkit/bin", savedReadGrant)
    expect(read.effect).toBe("allow")
    expect(write.effect).toBe("ask") // falls through to the default — never silently allowed
  })

  test("write and create are independent grants from edit", () => {
    const editGrant = [{ action: "edit", resource: "*", effect: "allow" as const }]
    expect(PermissionV2.evaluate("edit", "src/x.ts", editGrant).effect).toBe("allow")
    expect(PermissionV2.evaluate("write", "src/x.ts", editGrant).effect).toBe("ask")
    expect(PermissionV2.evaluate("create", "src/x.ts", editGrant).effect).toBe("ask")
  })
})

describe("denialMessage — denial as observation (1J)", () => {
  test("DeniedError surfaces the denying action + resource", () => {
    const error = new PermissionV2.DeniedError({
      rules: [
        { action: "write", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ],
    })
    const message = PermissionV2.denialMessage(error)!
    expect(message).toContain("'write'")
    expect(message).toContain("denied by policy")
    expect(message).toContain("Do not retry")
    expect(message).not.toContain("'read'") // only the denying rules are named
  })

  // Deny-fast: what the agent SEES when the unattended confinement stance refuses it. The generic
  // wording ends in "ask the user to adjust permissions" — the one instruction that hangs an
  // unattended run — so the tagged reason must swap it for a way forward inside the work folder.
  test("an unattended-confined denial tells the agent to work in its folder, NEVER to ask/wait", () => {
    const error = new PermissionV2.DeniedError({
      rules: [{ action: "external_directory_write", resource: "*", effect: "deny" }],
      reason: "unattended-confined",
    })
    const message = PermissionV2.denialMessage(error)!
    expect(message).toContain("UNATTENDED")
    expect(message).toContain("working folder")
    expect(message).toContain("external_directory_write")
    expect(message).toContain("waiting or retrying will change nothing")
    expect(message).not.toContain("ask the user")
  })

  test("an untagged denial keeps the generic policy wording (attended sessions unchanged)", () => {
    const message = PermissionV2.denialMessage(
      new PermissionV2.DeniedError({ rules: [{ action: "write", resource: "*", effect: "deny" }] }),
    )!
    expect(message).toContain("denied by policy")
    expect(message).toContain("ask the user to adjust permissions")
    expect(message).not.toContain("UNATTENDED")
  })

  test("CorrectedError carries the user's reason verbatim", () => {
    const message = PermissionV2.denialMessage(
      new PermissionV2.CorrectedError({ feedback: "w64devkit is a read-only toolchain — write under the project" }),
    )!
    expect(message).toContain("w64devkit is a read-only toolchain — write under the project")
    expect(message).toContain("declined")
  })

  test("RejectedError becomes a redirect, not a dead end", () => {
    const message = PermissionV2.denialMessage(new PermissionV2.RejectedError())!
    expect(message).toContain("declined")
    expect(message).toContain("Do not retry")
  })

  test("non-permission errors pass through untouched", () => {
    expect(PermissionV2.denialMessage(new Error("ENOENT"))).toBeUndefined()
    expect(PermissionV2.denialMessage("string")).toBeUndefined()
    expect(PermissionV2.denialMessage(undefined)).toBeUndefined()
  })
})
