import { describe, expect, test } from "bun:test"
import { componentsFrom, emitSbom, parseIdent, parseLock, purlOf, type LockEntry } from "./sbom"

const STAMP = "2026-08-11T00:00:00.000Z"

describe("SBOM from bun.lock", () => {
  // ⚠️ The one that matters. A naive `split("@")` reads the SCOPE's leading @ as the delimiter and
  // gets every scoped package wrong — which is most of this tree.
  test("splits on the LAST @, so scoped names survive", () => {
    expect(parseIdent("@adobe/css-tools@4.5.0")).toEqual({ name: "@adobe/css-tools", version: "4.5.0" })
    expect(parseIdent("typescript@5.9.2")).toEqual({ name: "typescript", version: "5.9.2" })
    expect(parseIdent("@scope/n@1.0.0-beta.1")).toEqual({ name: "@scope/n", version: "1.0.0-beta.1" })
    expect(parseIdent("nonsense")).toBeUndefined()
    expect(parseIdent("@only-a-scope")).toBeUndefined()
  })

  // ⚠️ The shape a `lastIndexOf("@")` gets wrong. A git spec carries an `@` INSIDE the version, so
  // splitting on the last one names the package `ghostty-web@git+ssh://git` — and a git dependency is
  // the one component in an SBOM that is not an audited registry artifact, so it is the one a consumer
  // most needs named correctly. There is no git dependency in the tree today; that is exactly why this
  // lives in the test rather than waiting for the next one.
  test("splits a GIT ident on the version delimiter, not on an @ inside the version", () => {
    expect(parseIdent("ghostty-web@github:anomalyco/ghostty-web#513463a")).toEqual({
      name: "ghostty-web",
      version: "github:anomalyco/ghostty-web#513463a",
    })
    expect(parseIdent("@scope/n@git+ssh://git@github.com/o/r.git#abc123")).toEqual({
      name: "@scope/n",
      version: "git+ssh://git@github.com/o/r.git#abc123",
    })
  })

  test("percent-encodes the scope separator, per the purl spec", () => {
    expect(purlOf("@adobe/css-tools", "4.5.0")).toBe("pkg:npm/@adobe%2Fcss-tools@4.5.0")
    expect(purlOf("typescript", "5.9.2")).toBe("pkg:npm/typescript@5.9.2")
    expect(purlOf("@scope/n", "1.0.0-beta.1")).toBe("pkg:npm/@scope%2Fn@1.0.0-beta.1")
  })

  // ⚠️ `#` is the purl SUBPATH separator, so `pkg:npm/x@github:o/r#sha` parses as version
  // "github:o/r" with subpath "sha", under a type that claims npm served it. It did not.
  test("a git version does not become a malformed pkg:npm purl", () => {
    expect(purlOf("ghostty-web", "github:anomalyco/ghostty-web#513463a")).toBe(
      "pkg:github/anomalyco/ghostty-web@513463a",
    )
    const ssh = purlOf("@scope/n", "git+ssh://git@github.com/o/r.git#abc123")
    expect(ssh.startsWith("pkg:generic/")).toBe(true)
    expect(ssh).not.toContain("#")
    expect(ssh).not.toContain("pkg:npm/")
  })

  test("carries the sha512 integrity and drops its prefix", () => {
    const packages: Record<string, LockEntry> = {
      a: ["a@1.0.0", "", {}, "sha512-ABC=="],
      b: ["b@2.0.0", "", {}],
    }
    const [a, b] = componentsFrom(packages)
    expect(a).toMatchObject({ name: "a", version: "1.0.0", sha512: "ABC==" })
    expect(b!.sha512).toBeUndefined()
  })

  test("excludes workspace members — they are our code, not an inventory entry", () => {
    const packages: Record<string, LockEntry> = {
      "@novaclaw/core": ["@novaclaw/core@workspace:packages/core", "", {}],
      real: ["real@1.0.0", "", {}, "sha512-Z=="],
    }
    expect(componentsFrom(packages).map((c) => c.name)).toEqual(["real"])
  })

  test("is sorted, so two runs of one commit diff clean", () => {
    const packages: Record<string, LockEntry> = {
      z: ["z@1.0.0", "", {}],
      a: ["a@1.0.0", "", {}],
    }
    expect(componentsFrom(packages).map((c) => c.name)).toEqual(["a", "z"])
  })

  // The same vacuity rule as the digest manifest: an empty inventory asserts nothing while looking
  // like a completed compliance step.
  test("REFUSES an empty component list", () => {
    expect(() => emitSbom({ version: "0.1.59", components: [], timestamp: STAMP })).toThrow(/asserts nothing/)
  })

  // ⚠️ Load-bearing. The lockfile cannot see Electron, w64devkit or the downloaded binaries, so a
  // document that did not SAY so would move a hand-maintained claim behind a machine-shaped facade.
  test("states its own scope in the document, not in a comment someone must remember", () => {
    const out = JSON.parse(
      emitSbom({
        version: "0.1.59",
        components: [{ name: "a", version: "1", purl: purlOf("a", "1") }],
        timestamp: STAMP,
      }),
    )
    const scope = out.metadata.properties.find((p: { name: string }) => p.name === "novaclaw:scope")
    expect(scope.value).toContain("Electron")
    expect(scope.value).toContain("w64devkit")
    expect(scope.value).toContain("ripgrep")
    expect(out.bomFormat).toBe("CycloneDX")
    expect(out.metadata.component.version).toBe("0.1.59")
  })

  // ⚠️ The regression that made this a scanner instead of a regex. `,(\s*[}\]])` corrupted any
  // string containing a comma before a closer — an integrity of "sha512-A,}B==" came back
  // "sha512-A}B==", and a wrong hash reads exactly like a right one.
  test("strips trailing commas WITHOUT touching a string that contains one", () => {
    const parsed = parseLock<{ a: unknown[] }>('{"a": ["x@1", "", {}, "sha512-A,}B=="],}')
    expect(parsed.a[3]).toBe("sha512-A,}B==")
  })

  test("an escaped quote does not end the string", () => {
    expect(parseLock<{ k: string }>('{"k":"a\\",}b",}').k).toBe('a",}b')
  })

  test("still removes the trailing commas it is there for", () => {
    expect(parseLock<{ a: number[]; b: number }>('{"a":[1,2,],"b":3,}')).toEqual({ a: [1, 2], b: 3 })
  })
})
