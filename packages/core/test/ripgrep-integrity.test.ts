import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { RipgrepBinary } from "@novaclaw/core/ripgrep/binary"
import { stripComments } from "./lib/source-scan"

/**
 * **ripgrep is embedded from a local build-host binary and executed as this agent OS's tree-search
 * engine.** Until 2026-07-30 the only check on the old acquisition path was
 * `if (bytes.byteLength === 0)` — a swapped release asset, a poisoned trust store or an upstream
 * account compromise was arbitrary code execution inside NovaClaw (`` §1, the
 * highest-severity finding that audit produced).
 *
 * The fix is a per-triple SHA-256 pin of the executable, so an embedded or inherited `rg` is verified
 * rather than trusted
 * forever. This file is the mechanical half of it (todo.md ruling 1), and it protects five things
 * that all compile green when broken:
 *   ① a platform triple added to `PLATFORM` with no digest — verification silently skipped for it;
 *   ② `VERSION` bumped without re-pinning — the old release's digests vouching for a new download;
 *   ③ a refusal turned into a fall-through — the guard-shaped no-op this codebase keeps finding;
 *   ④ a remote acquisition path quietly reappeared;
 *   ⑤ the pre-installed binary short-circuited on `isFile` alone — the shipped shape, which returns
 *      whatever an earlier unverified build left behind.
 *
 * ④ and ⑤ are why this file reads the source. The test must prove the product has no network
 * acquisition path while both local paths remain digest-gated.
 */

const SOURCE_PATH = path.join(import.meta.dir, "..", "src", "ripgrep", "binary.ts")
const RAW_SOURCE = fs.readFileSync(SOURCE_PATH, "utf8")

/** The comment stripper the rest of the suite uses — `//` must not eat the `//` in a URL. */

/** CODE ONLY, so the assertions below answer "does it DO it", never "does it mention it". */
const SOURCE = stripComments(RAW_SOURCE)

const PLATFORM_KEYS = Object.keys(RipgrepBinary.PLATFORM) as Array<keyof typeof RipgrepBinary.PLATFORM>

interface Pin {
  readonly archive: string
  readonly executable: string
}

/** `?? {}` so a missing block fails the one test that is about it, instead of crashing the file. */
const PINNED: Record<string, Pin> =
  (RipgrepBinary.CHECKSUM as Record<string, Record<string, Pin> | undefined>)[RipgrepBinary.VERSION] ?? {}

/** A payload whose digest we control, standing in for a release archive. */
const payload = (text: string): Uint8Array => new TextEncoder().encode(text)
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

describe("the pin covers every platform we can download for", () => {
  test("the platform table is actually there to check", () => {
    // Without this, a renamed/emptied export turns every assertion below into a tautology over [].
    expect(PLATFORM_KEYS.length).toBeGreaterThanOrEqual(7)
    for (const key of PLATFORM_KEYS)
      expect(key, `${key} is not an <arch>-<platform> key`).toMatch(/^[a-z0-9]+-[a-z0-9]+$/)
  })

  test("VERSION has a digest block at all — bumping it without re-pinning fails here", () => {
    // ②. The type system says the same thing (`CHECKSUM[VERSION]` stops resolving), but the gate does
    // not always run tsgo, and a fail-open is not something to leave to one instrument.
    expect(
      Object.keys(RipgrepBinary.CHECKSUM),
      `no pinned digests for ripgrep ${RipgrepBinary.VERSION} — re-fetch every <asset>.sha256 for that tag`,
    ).toContain(RipgrepBinary.VERSION)
  })

  test("every platform triple has a pin, and every pin has a triple", () => {
    // ①. A platform added without a digest must not silently reach the download path.
    expect(Object.keys(PINNED).sort()).toEqual([...PLATFORM_KEYS].sort())
  })

  test("every pin carries BOTH digests, each a lowercase 64-hex SHA-256", () => {
    for (const [key, pin] of Object.entries(PINNED)) {
      expect(pin?.archive, `${key}.archive`).toMatch(/^[0-9a-f]{64}$/)
      expect(pin?.executable, `${key}.executable`).toMatch(/^[0-9a-f]{64}$/)
      // An archive and the binary inside it cannot hash the same; equal means one was pasted over
      // the other, and then that platform can never install ripgrep again.
      expect(pin.archive, `${key} archive and executable digests are identical`).not.toBe(pin.executable)
    }
  })

  test("no two triples share a digest", () => {
    // Seven different builds cannot hash the same; a repeat is a copy-paste.
    const all = Object.values(PINNED).flatMap((pin) => [pin.archive, pin.executable])
    expect(new Set(all).size, `duplicate digest in the ${RipgrepBinary.VERSION} block`).toBe(all.length)
  })

  test("the host's own triple is pinned", () => {
    const key = `${process.arch}-${process.platform}`
    if (!PLATFORM_KEYS.includes(key as keyof typeof RipgrepBinary.PLATFORM)) return
    expect(PINNED[key]?.archive, `${key} is downloadable but unpinned`).toMatch(/^[0-9a-f]{64}$/)
    expect(PINNED[key]?.executable, `${key} is downloadable but unpinned`).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("verifyDigest is fail-closed", () => {
  test("it computes a real SHA-256, not a stub", () => {
    // NIST vector for "abc". A hash function that returned a constant would pass every other test
    // in this file, because every other test hashes with the same function it is checking.
    expect(RipgrepBinary.sha256Hex(payload("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
  })

  test("it accepts bytes that match the pin", () => {
    const bytes = payload("a plausible ripgrep archive")
    expect(() => RipgrepBinary.verifyDigest(bytes, digest(bytes), "rg.tar.gz")).not.toThrow()
  })

  test("a corrupted payload is REJECTED — one flipped byte", () => {
    // ③, and the case the whole finding is about: the attacker-substituted asset.
    const bytes = payload("a plausible ripgrep archive")
    const pin = digest(bytes)
    const tampered = Uint8Array.from(bytes)
    tampered[0] = tampered[0]! ^ 0x01
    expect(() => RipgrepBinary.verifyDigest(tampered, pin, "rg.tar.gz")).toThrow(/SHA-256 mismatch/)
    // and it must name both digests, or a fault is described without being diagnosable (ruling 2)
    expect(() => RipgrepBinary.verifyDigest(tampered, pin, "rg.tar.gz")).toThrow(new RegExp(digest(tampered)))
  })

  test("a truncated payload is REJECTED", () => {
    const bytes = payload("a plausible ripgrep archive")
    expect(() => RipgrepBinary.verifyDigest(bytes.slice(0, 5), digest(bytes), "rg.tar.gz")).toThrow(/SHA-256 mismatch/)
  })

  test("an empty artefact is REJECTED, and says so rather than reporting a mismatch", () => {
    expect(() => RipgrepBinary.verifyDigest(new Uint8Array(0), digest(new Uint8Array(0)), "rg.zip")).toThrow(
      /it is empty/,
    )
  })

  test("a MISSING pin is a refusal, never a skip", () => {
    // The guard-shaped no-op `` §1 explicitly warns against: an empty hash table
    // that "verifies" by falling through. Nothing may be installed on the strength of no evidence.
    const bytes = payload("anything at all")
    for (const bad of [undefined, "", "   ", "not-a-hash"])
      expect(() => RipgrepBinary.verifyDigest(bytes, bad, "rg.zip"), `pin ${JSON.stringify(bad)}`).toThrow(
        /no pinned SHA-256/,
      )
  })

  test("a malformed pin is a refusal — wrong length, wrong case, wrong alphabet", () => {
    const bytes = payload("anything at all")
    const real = digest(bytes)
    for (const bad of [real.slice(0, 63), real + "0", real.toUpperCase(), real.replace(/^./, "g")])
      expect(() => RipgrepBinary.verifyDigest(bytes, bad, "rg.zip"), `pin ${bad}`).toThrow(/no pinned SHA-256/)
  })
})

describe("the local acquisition paths are verified and never download", () => {
  // ④/⑤. Every assertion here is on comment-stripped source: prose about verification is not proof.

  test("the source is actually loaded", () => {
    expect(SOURCE.length).toBeGreaterThan(500)
    expect(SOURCE).toContain("NOVACLAW_RIPGREP_PATH")
  })

  test("the bundled executable is verified before use", () => {
    expect(SOURCE.match(/verifyDigest\(/g)?.length, "unexpected local verifyDigest(...) call count").toBe(1)
    expect(SOURCE).toMatch(/verifyDigest\(\s*bytes\s*,\s*pin\.executable\s*,\s*embedded\s*\)/)
  })

  test("there is no remote downloader or archive extraction path", () => {
    expect(SOURCE).not.toContain("Download.toFile(")
    expect(SOURCE).not.toContain("fetch(")
    expect(SOURCE).not.toContain("extract(archive")
  })

  test("a missing bundled binary cannot fall back to a host or cached copy", () => {
    expect(SOURCE).not.toContain("which(")
    expect(SOURCE).not.toContain("Global.Path.bin")
    expect(SOURCE).not.toContain("matchesDigest")
    expect(SOURCE).toContain("NovaClaw's bundled ripgrep is missing")
  })
})

describe("the guards bite (negative control on the checkers themselves)", () => {
  test("the platform/pin comparison reports a missing pin", () => {
    // The real test asserts two sorted key lists are EQUAL, which alone cannot show that an unequal
    // pair is reachable. Exercised here on a synthetic table with a triple nobody pinned.
    const platform = ["x64-linux", "x64-win32", "riscv64-linux"].sort()
    const pinned = ["x64-linux", "x64-win32"].sort()
    expect(pinned).not.toEqual(platform)
  })

  test("an embedded path without a digest check is visibly incomplete", () => {
    const rogue = stripComments(`
      const embedded = process.env.NOVACLAW_RIPGREP_PATH
      if (embedded) return embedded
    `)
    expect(rogue).not.toContain("verifyDigest(")
  })

  test("prose about verifying does not count as verifying", () => {
    const rogue = stripComments(`
      // verifyDigest(bytes, pin.executable, embedded)
      return embedded
    `)
    expect(rogue).not.toContain("verifyDigest(")
  })
})
