import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { basename } from "node:path"

/**
 * The digest manifest for a release drop.
 *
 * `doc/release.md` lists four artifact gaps and puts hashes first, for one reason: it is the only one
 * a stranger cannot work around. Someone who distrusts a 1.15 GB download can rebuild an SBOM's
 * conclusions by reading `licenses/`, and can live without an update channel — but without a
 * published digest there is nothing they can check the bytes against, and "download it again" is not
 * an answer to "did this arrive intact".
 *
 * ## Format, and why exactly this one
 *
 * `<64-hex>  <basename>` — two spaces, sorted by name, LF, trailing newline. That is coreutils'
 * format, so the file a user already knows how to use works unmodified:
 *
 *     sha256sum -c SHA256SUMS          # Linux/macOS
 *     Get-FileHash NovaClaw-*.7z       # Windows, compare by eye
 *
 * **Basename, never a path.** The manifest is verified in the directory the artifacts were
 * downloaded to, which is never the directory they were built in. A path here makes the file
 * unusable for the only audience it has.
 *
 * **Sorted.** Two builds of the same drop must produce byte-identical manifests, so the manifest
 * itself can be diffed across a rebuild. Directory order is not a stable input.
 */
export interface Digest {
  readonly name: string
  readonly sha256: string
  readonly bytes: number
}

/** Stream rather than read: these are ~1 GB artifacts and a Buffer of one is a needless spike. */
export async function digestOf(path: string): Promise<Digest> {
  const hash = createHash("sha256")
  let bytes = 0
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on("data", (chunk) => {
      bytes += chunk.length
      hash.update(chunk)
    })
    stream.on("error", reject)
    stream.on("end", resolve)
  })
  return { name: basename(path), sha256: hash.digest("hex"), bytes }
}

/**
 * Render the manifest. Pure, so the format is testable without touching a disk.
 *
 * ⚠️ **Throws on an empty set rather than writing an empty file.** A zero-artifact manifest is the
 * failure this whole session kept meeting in other guises: it looks exactly like success, publishes
 * without complaint, and verifies vacuously — `sha256sum -c` on an empty file exits 0. A glob that
 * matched nothing is the likeliest way to get here, and it must be loud.
 */
export function renderManifest(digests: readonly Digest[]): string {
  if (digests.length === 0)
    throw new Error("refusing to write an empty SHA256SUMS — a manifest of nothing verifies vacuously")
  const seen = new Set<string>()
  for (const digest of digests) {
    // Two artifacts with one basename would produce a manifest where the second silently shadows the
    // first on verification. Different directories, same name, is exactly how a multi-platform drop
    // is assembled, so this is a real case rather than a defensive one.
    if (seen.has(digest.name)) throw new Error(`duplicate artifact name in the drop: ${digest.name}`)
    seen.add(digest.name)
  }
  return (
    [...digests]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((d) => `${d.sha256}  ${d.name}`)
      .join("\n") + "\n"
  )
}

/**
 * Split `--out <file>` from the artifact list.
 *
 * ⚠️ Lives here, tested, because the first inline version SILENTLY DROPPED THE FIRST ARTIFACT: it
 * filtered with `i !== outFlag + 1`, and with no `--out` present `outFlag` is `-1`, so the predicate
 * became `i !== 0`. It printed "1 artifact(s)" for two inputs and wrote a manifest that verified
 * clean — the exact failure this module's own comment calls worse than no manifest, because it looks
 * complete. Found by running it on two files rather than by reading it.
 */
export function parseArgs(argv: readonly string[]): { readonly out?: string; readonly inputs: string[] } {
  const inputs: string[] = []
  let out: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") {
      out = argv[++i]
      continue
    }
    inputs.push(argv[i]!)
  }
  return out === undefined ? { inputs } : { out, inputs }
}

/**
 * Split `--manifest <file>` off an argv, leaving the artifacts.
 *
 * 🔴 **This exists because the inline version dropped an artifact whenever the flag was ABSENT.**
 * It read `const flag = argv.indexOf("--manifest")` and then filtered out indices `flag` and
 * `flag + 1` — and a missing flag is `-1`, so `flag + 1` is `0` and the FIRST artifact was quietly
 * removed. Cutting 0.1.67 recorded two of the three files it shipped, and the one it lost was the
 * Windows binary: the exact entry a stuck user needs, missing from the manifest whose whole purpose
 * is to hold it. Nothing failed, nothing warned — the count in the success line was simply one short.
 *
 * ⚠️ The lesson generalises past this call site: `indexOf` answers "not found" with a number that is
 * still valid arithmetic. Any `found + 1` reached without checking `found >= 0` is the same bug
 * wearing different variable names.
 */
export function splitManifestArg(argv: readonly string[]): {
  readonly manifest?: string
  readonly rest: readonly string[]
} {
  const flag = argv.indexOf("--manifest")
  if (flag < 0) return { rest: argv }
  const manifest = argv[flag + 1]
  const rest = argv.filter((_, index) => index !== flag && index !== flag + 1)
  return manifest === undefined ? { rest } : { manifest, rest }
}
