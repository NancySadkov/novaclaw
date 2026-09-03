import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { QualityDetect } from "@novaclaw/core/session/runner/quality-detect"
import { QualityProvision } from "@novaclaw/core/session/runner/quality-provision"
import { tmpdir } from "./fixture/tmpdir"

/**
 * **The one manifest loader, against a real directory.**
 *
 * `quality-provision.ts`'s detection matrix is unit-tested pure, with synthetic file lists and no
 * filesystem — deliberately, and that coverage is not repeated here. What this file covers is the
 * seam that purity leaves open: the code that actually goes to disk, decides WHICH files to read,
 * and hands the scan its inputs.
 *
 * 🔴 That code had exactly one caller (the `quality_provision` tool) and was about to have two, when
 * Settings → Quality gained its "Detect from this project" button. A second copy would have drifted
 * the moment either side gained an ecosystem — silently, because a manifest the loader never reads
 * is indistinguishable from a project that does not declare one. So there is one loader, and this
 * pins the two properties a caller depends on.
 */
describe("detecting quality commands from a project's own manifests", () => {
  test("it reads the manifest and proposes what the project declares", async () => {
    const dir = await tmpdir()
    try {
      await fs.writeFile(
        path.join(dir.path, "package.json"),
        JSON.stringify({ name: "fixture", scripts: { typecheck: "tsc -b --noEmit", test: "bun test" } }),
      )
      const proposal = await Effect.runPromise(QualityDetect.detect(dir.path))

      expect(proposal.commands.typecheck, "the manifest declares a typecheck script").toBeTruthy()
      expect(proposal.commands.test, "the manifest declares a test script").toBeTruthy()
      // The trail is what lets a person CHECK the proposal instead of trusting it, and the settings
      // panel renders it under the button for exactly that reason.
      expect(proposal.evidence.length).toBeGreaterThan(0)
      expect(proposal.evidence.join("\n")).toContain("package.json")
    } finally {
      await dir[Symbol.asyncDispose]()
    }
  })

  test("an empty directory proposes nothing — it does not guess", async () => {
    const dir = await tmpdir()
    try {
      const proposal = await Effect.runPromise(QualityDetect.detect(dir.path))
      expect(Object.values(proposal.commands).filter(Boolean)).toEqual([])
      expect(proposal.evidence).toEqual([])
    } finally {
      await dir[Symbol.asyncDispose]()
    }
  })

  test("a directory that does not exist answers empty rather than failing the request", async () => {
    // The route behind the settings button is a GET on whatever location the request named. A
    // directory that has gone away must not 500 a settings panel — an empty proposal says the same
    // thing the empty-directory case says, which is "this project declares nothing I can read".
    const proposal = await Effect.runPromise(QualityDetect.detect(path.join("does", "not", "exist")))
    expect(Object.values(proposal.commands).filter(Boolean)).toEqual([])
  })

  test("it reads exactly the files the manifest table declares, and no others", async () => {
    // 🔴 The non-vacuity guard for the whole file, and the drift this loader exists to prevent. A
    // rule serves only the names it declared, so a manifest added to the table WITHOUT a `reads`
    // entry behaves identically in a unit test and on a real host — it fails loudly instead of
    // silently degrading. This pins that the loader's read set IS the table's, not a copy of it.
    const dir = await tmpdir()
    try {
      const decoy = "not-a-manifest.json"
      expect(QualityProvision.MANIFEST_READS).not.toContain(decoy)
      await fs.writeFile(path.join(dir.path, decoy), JSON.stringify({ scripts: { test: "should-not-appear" } }))
      const proposal = await Effect.runPromise(QualityDetect.detect(dir.path))
      expect(proposal.evidence.join("\n")).not.toContain("should-not-appear")
      expect(QualityProvision.MANIFEST_READS.length).toBeGreaterThan(0)
    } finally {
      await dir[Symbol.asyncDispose]()
    }
  })
})
