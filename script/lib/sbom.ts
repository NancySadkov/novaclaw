/**
 * A CycloneDX SBOM from `bun.lock`.
 *
 * `doc/release.md` lists this as an artifact gap with a precise complaint: `NOTICE` and `licenses/`
 * are hand-maintained, which makes them a licence CLAIM rather than an inventory. This turns the
 * lockfile — the one file that actually knows what resolved — into the inventory.
 *
 * ## ⚠️ What it covers, and what it does NOT
 *
 * `bun.lock` knows the npm dependency tree and nothing else. A NovaClaw release also carries, and
 * this SBOM does not describe:
 *
 *   · **Electron** itself (fetched by electron-builder for the target arch, ~250 MB);
 *   · **w64devkit**, shipped expanded under `resources/third-party/` on Windows;
 *   · **ripgrep** and any **backend pack**, which are downloaded at runtime rather than bundled.
 *
 * Those are named in `NOTICE`/`licenses/`. An SBOM that silently omitted them while calling itself
 * complete would be worse than none — it would move a hand-maintained claim behind a machine-shaped
 * facade. So `emitSbom` writes that scope INTO the document, in `metadata.properties`, where a
 * consumer reads it rather than a maintainer remembers it.
 */

/** One entry of `bun.lock`'s `packages` map: `[ident, registry, meta, integrity]`. */
export type LockEntry = readonly [string, string, unknown, string?]

export interface Component {
  readonly name: string
  readonly version: string
  readonly purl: string
  readonly sha512?: string
}

/**
 * Split `@scope/name@1.2.3` into its parts.
 *
 * ⚠️ The leading `@` of a scope is not a separator, and neither is an `@` inside a VERSION — a git
 * spec carries both (`x@git+ssh://git@github.com/o/r#sha`). So the delimiter is the first `@` after
 * the scope's `/`, or the first `@` at all when there is no scope. A naive `split("@")` gets every
 * scoped package wrong; a `lastIndexOf("@")` gets every git spec wrong, which is the shape an SBOM
 * consumer most needs named correctly because it is the one component that is not an audited
 * registry artifact.
 */
export function parseIdent(ident: string): { readonly name: string; readonly version: string } | undefined {
  const from = ident.startsWith("@") ? ident.indexOf("/") + 1 : 0
  if (from === 0 && ident.startsWith("@")) return undefined // a scope with no name
  const at = ident.indexOf("@", from)
  if (at <= 0) return undefined
  const name = ident.slice(0, at)
  const version = ident.slice(at + 1)
  if (name.length === 0 || version.length === 0) return undefined
  return { name, version }
}

/** `github:owner/repo#ref` / `git+<url>#ref` — what bun writes in place of a registry version. */
const GIT_SPEC = /^(?:github:([^/]+)\/([^#]+)|git\+[^#]+)(?:#(.*))?$/

/**
 * `pkg:npm/@scope%2Fname@version` — the scope separator is percent-encoded, per the purl spec.
 *
 * ⚠️ A git-resolved dependency is NOT an npm component. Emitting `pkg:npm/x@github:o/r#sha` is
 * malformed twice over: `#` is the purl SUBPATH separator, so a consumer reads the ref as a subpath,
 * and the type claims npm for something npm never served. `github:` specs become `pkg:github/o/r@ref`;
 * anything else git-shaped keeps its type but has its version percent-encoded so the `#` cannot be
 * read as structure.
 *
 * ⚠️ There is currently NO git dependency in this tree (`ghostty-web` moved to the registry), so this
 * branch is exercised only by `sbom.test.ts`. That is deliberate: the bug was silent-wrong output in a
 * compliance artifact, and the next git dependency must not re-introduce it.
 */
export function purlOf(name: string, version: string): string {
  const git = GIT_SPEC.exec(version)
  if (git) {
    const [, owner, repo, ref] = git
    if (owner && repo) return `pkg:github/${owner}/${repo.replace(/\.git$/, "")}${ref ? `@${ref}` : ""}`
    return `pkg:generic/${encodeURIComponent(name)}@${encodeURIComponent(version)}`
  }
  return `pkg:npm/${name.replace("/", "%2F")}@${encodeURIComponent(version)}`
}

export function componentsFrom(packages: Readonly<Record<string, LockEntry>>): Component[] {
  const out: Component[] = []
  for (const entry of Object.values(packages)) {
    const parsed = parseIdent(entry[0])
    if (!parsed) continue
    // Workspace members are OUR code, not a third-party component. They carry no integrity and their
    // "version" is a path — including them would inflate the count and describe nothing.
    if (entry[0].includes("@workspace:")) continue
    const sha512 = entry[3]?.startsWith("sha512-") ? entry[3].slice("sha512-".length) : undefined
    out.push({ ...parsed, purl: purlOf(parsed.name, parsed.version), ...(sha512 ? { sha512 } : {}) })
  }
  return out.sort((a, b) => (a.purl < b.purl ? -1 : a.purl > b.purl ? 1 : 0))
}

export interface SbomInput {
  readonly version: string
  readonly components: readonly Component[]
  /** Stamped by the caller — `Date.now()` is not this module's to invent, and a test needs it fixed. */
  readonly timestamp: string
}

/** CycloneDX 1.5, JSON. Sorted, so two runs of one commit diff clean. */
export function emitSbom(input: SbomInput): string {
  if (input.components.length === 0)
    throw new Error("refusing to emit an SBOM with no components — an empty inventory asserts nothing")
  return (
    JSON.stringify(
      {
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        version: 1,
        metadata: {
          timestamp: input.timestamp,
          component: { type: "application", name: "novaclaw", version: input.version },
          properties: [
            {
              name: "novaclaw:scope",
              value:
                "npm dependency tree from bun.lock ONLY. Electron, w64devkit (bundled on Windows), " +
                "and runtime-downloaded binaries such as ripgrep and the backend pack are NOT " +
                "described here — see NOTICE and licenses/.",
            },
          ],
        },
        components: input.components.map((c) => ({
          type: "library",
          name: c.name,
          version: c.version,
          purl: c.purl,
          ...(c.sha512 ? { hashes: [{ alg: "SHA-512", content: c.sha512 }] } : {}),
        })),
      },
      null,
      2,
    ) + "\n"
  )
}

/**
 * Parse `bun.lock`, which is JSONC (trailing commas).
 *
 * ⚠️ `Bun.file().json()` REFUSES it, and the caller's first version claimed bun read it natively.
 * `jsonc-parser` is a dependency of `core`, not of the `script` workspace, and adding one here would
 * be a dependency bought with a short function.
 *
 * ⚠️ **A regex is NOT sufficient, and the first version of this was one.** `text.replace(/,(\s*[}\]])/g, "$1")`
 * looks right and silently corrupts any STRING containing a comma before a closer: an
 * integrity value of `"sha512-A,}B=="` came back `"sha512-A}B=="`. A wrong hash reads exactly like a
 * right one, which is the worst possible failure for a compliance artifact. Proven by the pinned
 * test rather than argued — the claim "JSON strings cannot produce that" was simply false.
 *
 * So this scans, tracking whether it is inside a string, and drops a comma only when the next
 * non-whitespace character outside a string is a closer.
 */
export function parseLock<T>(text: string): T {
  let out = ""
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (ch === "\\") {
        // An escape consumes the next character whole, so a `\"` never ends the string.
        out += text[++i] ?? ""
      } else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ",") {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j++
      if (text[j] === "}" || text[j] === "]") continue // drop the trailing comma
    }
    out += ch
  }
  return JSON.parse(out) as T
}
