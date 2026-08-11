import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { digestOf, parseArgs, renderManifest } from "./release-hashes"

const dir = mkdtempSync(join(tmpdir(), "novaclaw-hashes-"))

describe("release digests", () => {
  test("hashes a file and reports its size", async () => {
    const path = join(dir, "artifact.7z")
    writeFileSync(path, "novaclaw")
    const digest = await digestOf(path)
    // sha256("novaclaw"), computed independently of the implementation under test.
    expect(digest.sha256).toBe(new Bun.CryptoHasher("sha256").update("novaclaw").digest("hex"))
    expect(digest.bytes).toBe(8)
    // The BASENAME, never the path — the manifest is verified where the artifact was downloaded to.
    expect(digest.name).toBe("artifact.7z")
  })

  test("renders coreutils format: two spaces, sorted, trailing newline", () => {
    const out = renderManifest([
      { name: "z.7z", sha256: "b".repeat(64), bytes: 1 },
      { name: "a.dmg", sha256: "a".repeat(64), bytes: 1 },
    ])
    expect(out).toBe(`${"a".repeat(64)}  a.dmg\n${"b".repeat(64)}  z.7z\n`)
  })

  // ⚠️ The assertion this file exists for. `sha256sum -c` on an empty manifest EXITS 0 — it verified
  // everything it was asked to, which was nothing. A glob that matched no artifacts would otherwise
  // publish a green, meaningless file.
  test("REFUSES an empty manifest instead of writing one that verifies vacuously", () => {
    expect(() => renderManifest([])).toThrow(/verifies vacuously/)
  })

  // A multi-platform drop is assembled from several build directories, so two artifacts can arrive
  // with one basename. On verification the second silently shadows the first.
  test("refuses two artifacts sharing a basename", () => {
    expect(() =>
      renderManifest([
        { name: "same.7z", sha256: "a".repeat(64), bytes: 1 },
        { name: "same.7z", sha256: "b".repeat(64), bytes: 2 },
      ]),
    ).toThrow(/duplicate artifact name/)
  })

  test("the rendered manifest is stable across input order — a rebuild must diff clean", () => {
    const one = { name: "one.7z", sha256: "1".repeat(64), bytes: 1 }
    const two = { name: "two.dmg", sha256: "2".repeat(64), bytes: 2 }
    expect(renderManifest([one, two])).toBe(renderManifest([two, one]))
  })

  // The regression this function was extracted for.
  test("keeps EVERY artifact when --out is absent", () => {
    expect(parseArgs(["a.7z", "b.dmg"])).toEqual({ inputs: ["a.7z", "b.dmg"] })
  })

  test("takes --out's value and nothing else", () => {
    expect(parseArgs(["--out", "S", "a.7z"])).toEqual({ out: "S", inputs: ["a.7z"] })
    expect(parseArgs(["a.7z", "--out", "S", "b.dmg"])).toEqual({ out: "S", inputs: ["a.7z", "b.dmg"] })
  })
})
