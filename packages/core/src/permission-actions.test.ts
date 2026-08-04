import { describe, expect, test } from "bun:test"
import { PermissionV2 } from "./permission"
import { LocationMutation } from "./location-mutation"

// 1I + 1J pure-logic coverage: the split action granularity (read-class external access never
// authorizes write-class) and the denial-as-observation message lowering.

const auth = {
  directory: "C:/soft/w64devkit",
  resource: "C:/soft/w64devkit/bin/gcc.exe",
  save: "C:/soft/w64devkit/*",
}

describe("externalDirectoryPermission — classed access (1I)", () => {
  test("read access maps to external_directory_read", () => {
    expect(LocationMutation.externalDirectoryPermission(auth, "read")).toEqual({
      action: "external_directory_read",
      resources: ["C:/soft/w64devkit/bin/gcc.exe"],
      save: ["C:/soft/w64devkit/*"],
      metadata: { targets: ["C:/soft/w64devkit/bin/gcc.exe"] },
    })
  })

  test("file scope persists concrete targets while always persists the directory wildcard", () => {
    const request = LocationMutation.externalDirectoryPermission(auth, "write")
    expect(PermissionV2.savedResources(request, "file")).toEqual(["C:/soft/w64devkit/bin/gcc.exe"])
    expect(PermissionV2.savedResources(request, "always")).toEqual(["C:/soft/w64devkit/*"])
  })

  test("write access maps to external_directory_write", () => {
    expect(LocationMutation.externalDirectoryPermission(auth, "write").action).toBe("external_directory_write")
  })

  test("a saved READ grant does not satisfy a WRITE check (the w64devkit case)", () => {
    const savedReadGrant = [
      { action: "external_directory_read", resource: "C:/soft/w64devkit/*", effect: "allow" as const },
    ]
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

// Attached-source protection, ported from https://github.com/NancySadkov/novaclaw/pull/9 by
// @DassaultFalconKing. The pure half: which mutation, against which canonical identity, is protected.
// The evaluator half — placement against the mode overlay and saved rules, and deny-fast for an
// unattended root — is driven end to end in `test/permission.test.ts`, because those are the parts
// that decide whether the protection exists at all on a default install.
describe("protectedAttachment — canonical attachment identity", () => {
  const target = (canonical: string, resource = canonical) => ({ resource, canonical })

  test("protects the three actions that can destroy an attached file", () => {
    const attached = ["/project/task.md"]
    for (const action of ["edit", "write", "trash"])
      expect(PermissionV2.protectedAttachment(action, [target("/project/task.md")], attached)).toEqual(
        target("/project/task.md"),
      )
  })

  test("leaves reads, unrelated outputs and same-basename files in other directories alone", () => {
    const attached = ["/project/spec/task.md"]
    // A read of the attachment is the whole point of attaching it.
    expect(PermissionV2.protectedAttachment("read", [target("/project/spec/task.md")], attached)).toBeUndefined()
    expect(PermissionV2.protectedAttachment("write", [target("/project/result.md")], attached)).toBeUndefined()
    // NEGATIVE CONTROL for the basename-matching approach this port deliberately does NOT use:
    // same filename, different directory, therefore a different file.
    expect(PermissionV2.protectedAttachment("write", [target("/project/output/task.md")], attached)).toBeUndefined()
  })

  test("finds the attachment among several targets, and returns the PAIR so the caller cannot mis-index", () => {
    // The upstream version returned only the path and recovered the permission resource by index
    // into a separately-deduped array. Returning the pair is what makes that class of bug
    // unrepresentable — the resource travels with the path it belongs to.
    const found = PermissionV2.protectedAttachment(
      "edit",
      [
        target("/project/a.ts", "a.ts"),
        target("/project/spec/task.md", "spec/task.md"),
        target("/project/b.ts", "b.ts"),
      ],
      ["/project/spec/task.md"],
    )
    expect(found).toEqual({ resource: "spec/task.md", canonical: "/project/spec/task.md" })
  })

  test("an empty attachment set protects nothing, in every mutating action", () => {
    // Guards the ?? [] defaults on the assert path: a turn with no attachments must be untouched.
    for (const action of ["edit", "write", "trash"])
      expect(PermissionV2.protectedAttachment(action, [target("/project/task.md")], [])).toBeUndefined()
  })
})

describe("denialMessage — the attached-source refusal names the file and the way out", () => {
  test("tells an unattended agent to write elsewhere instead of to ask a user who is not there", () => {
    const message = PermissionV2.denialMessage(
      new PermissionV2.DeniedError({
        rules: [{ action: "edit", resource: "spec/task.md", effect: "deny" }],
        reason: "attachment-protected",
      }),
    )
    expect(message).toContain("spec/task.md")
    expect(message).toContain("ATTACHED")
    expect(message).toContain("NEW file")
    // The generic wording tells the model to "ask the user to adjust permissions" — the exact advice
    // that hangs an unattended run, which is why this reason exists at all.
    expect(message).not.toContain("ask the user to adjust permissions")
  })

  test("NEGATIVE CONTROL: without the reason the generic policy wording is still what comes back", () => {
    const message = PermissionV2.denialMessage(
      new PermissionV2.DeniedError({ rules: [{ action: "edit", resource: "spec/task.md", effect: "deny" }] }),
    )
    expect(message).toContain("ask the user to adjust permissions")
    expect(message).not.toContain("ATTACHED")
  })
})
