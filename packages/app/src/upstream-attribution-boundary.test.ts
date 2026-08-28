import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"

/** `packages/app/src` → repository root. */
const REPO = path.resolve(import.meta.dir, "..", "..", "..")

// Keep the name out of non-legal source, including this ratchet. Constructing it also gives the
// negative control below a real search term without granting this file an exemption.
const UPSTREAM_PROJECT = ["open", "code"].join("")

/**
 * The complete legal boundary. The root license is the one narrow exception to NOTICE + licenses/:
 * it has to distinguish NovaClaw's terms from the inherited MIT-covered code. The two package
 * licenses are verbatim MIT notices retained beside the substantial package code they cover.
 */
const LEGAL_ATTRIBUTION_FILES = new Set([
  "LICENSE",
  "NOTICE",
  `licenses/${UPSTREAM_PROJECT}-LICENSE-MIT.txt`,
  "packages/http-recorder/LICENSE",
  "packages/ui/LICENSE",
])

let cachedMentions: string[] | undefined
function filesMentioningUpstream(): string[] {
  if (cachedMentions) return cachedMentions
  const proc = spawnSync("git", ["grep", "--untracked", "-i", "-I", "-l", "-F", UPSTREAM_PROJECT, "--", "."], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
  if (proc.status !== 0 && proc.status !== 1)
    throw new Error(`git grep failed (${proc.status}): ${proc.stderr || proc.error?.message}`)
  cachedMentions = proc.stdout
    .split("\n")
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter(Boolean)
    .sort()
  return cachedMentions
}

describe("upstream attribution stays inside the legal boundary", () => {
  test("no product, runtime, test, hook, or contributor source names the upstream project", () => {
    const offenders = filesMentioningUpstream().filter((file) => !LEGAL_ATTRIBUTION_FILES.has(file))
    expect(
      offenders,
      "the upstream project name belongs only in NOTICE and the explicit legal allowlist",
    ).toEqual([])
  })

  test("the legal allowlist is exact and the tracked-source sweep is not vacuous", () => {
    const mentions = filesMentioningUpstream()
    expect(mentions).toEqual([...LEGAL_ATTRIBUTION_FILES].sort())
    expect(mentions).toContain("NOTICE")
    expect(mentions.length).toBeGreaterThan(3)
  })

  test("the constructed search term still detects mixed-case input", () => {
    expect(`before ${UPSTREAM_PROJECT.toUpperCase()} after`.toLowerCase()).toContain(UPSTREAM_PROJECT)
  })
})
