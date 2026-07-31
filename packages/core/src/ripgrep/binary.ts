import { createHash } from "node:crypto"
import path from "path"
import { Context, Effect, Layer, Stream } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "../cross-spawn-spawner"
import { Download } from "../download"
import { makeGlobalNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { which } from "../util/which"

export namespace RipgrepBinary {
  export const VERSION = "15.1.0"
  export const PLATFORM = {
    "arm64-darwin": { platform: "aarch64-apple-darwin", extension: "tar.gz" },
    "arm64-linux": { platform: "aarch64-unknown-linux-gnu", extension: "tar.gz" },
    "x64-darwin": { platform: "x86_64-apple-darwin", extension: "tar.gz" },
    "x64-linux": { platform: "x86_64-unknown-linux-musl", extension: "tar.gz" },
    "arm64-win32": { platform: "aarch64-pc-windows-msvc", extension: "zip" },
    "ia32-win32": { platform: "i686-pc-windows-msvc", extension: "zip" },
    "x64-win32": { platform: "x86_64-pc-windows-msvc", extension: "zip" },
  } as const

  /**
   * ─── the integrity pin ─────────────────────────────────────────────────────────────────────────
   *
   * SHA-256 of the release **archive** we fetch and of the **executable** it must yield, keyed
   * *version → platform triple*. Until 2026-07-30 the only check on this path was
   * `bytes.byteLength === 0`: whatever the network handed back was written to `Global.Path.bin`,
   * extracted, `chmod 0755`'d and executed as the tree-search engine of an agent OS. A swapped
   * release asset, a box with a poisoned trust store, or an upstream account compromise was
   * therefore arbitrary code execution inside NovaClaw — the same "one-key arbitrary-code-execution
   * path" ruling 12 refused to create for the update feed, except already shipped and with no key at
   * all (`todo/supply-chain.md` §1).
   *
   * **Why two digests and not one.** The archive digest alone protects a *fresh install only*:
   * `target` carries no version in its name, so an `rg` left behind by a pre-pin build — i.e. every
   * existing user — is short-circuited to forever, unverified, and the fix would protect nobody who
   * already has one. The executable digest is what makes the real invariant true: **the path
   * `filepath` returns has always hashed to a pinned digest**, whether it was downloaded now or
   * inherited from an earlier build. It also fixes a latent bug — bumping `VERSION` never replaced
   * an already-installed rg — and keeps an *offline* box working, since an inherited-but-genuine
   * binary verifies in place with no network at all.
   *
   * **Provenance (2026-07-30).** Archive digests: two independent derivations agreeing on all seven
   * — each asset's sibling `<asset>.sha256` published by the release, fetched raw over HTTPS, and
   * the asset downloaded and hashed locally with `sha256sum`. Executable digests: extracted from
   * those verified archives and hashed locally; `x64-win32` additionally matches the `rg.exe` winget
   * had installed on the author's machine from a separate download. Recording them *after review* is
   * the actual security property — the pin turns "whatever GitHub serves today" into "the exact
   * bytes a human vetted once", which a digest fetched at install time could never do, since
   * anything able to swap the asset can swap its sibling.
   *
   * ⚠️ **A missing digest is a REFUSAL, never a skip.** The guard-shaped no-op — fall through to
   * `extract` when the table has no entry — leaves the download unverified while *reading* as
   * verified, which is ruling 2's *a fault is never described falsely* broken on the exact path this
   * finding is about. `verifyDigest` throws on absent-or-malformed before it looks at any bytes.
   *
   * ⚠️ **To bump `VERSION`:** re-fetch every `<asset>.sha256` for the new tag, re-extract for the
   * executable digests, and add a whole new block here. `CHECKSUM[VERSION]` below is the mechanical
   * half of that instruction — the index stops typechecking the moment `VERSION` names a release
   * this table has never heard of, and the `Record<keyof typeof PLATFORM, …>` shape means a block
   * covering six of seven triples, or one missing an `executable`, does not compile either. The
   * runtime twin of every one of those checks lives in `test/ripgrep-integrity.test.ts`, so they
   * still bite where `tsgo` is not run.
   */
  export const CHECKSUM = {
    "15.1.0": {
      "arm64-darwin": {
        archive: "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
        executable: "4fdf1d8365af224bc70e3c1490d8461d859c37cc70e739a11e987af0215f3e94",
      },
      "arm64-linux": {
        archive: "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e",
        executable: "968cabe8efed72fd8fd482cb76b6084fcb695fc5293af7fb62296b02f487fb69",
      },
      "x64-darwin": {
        archive: "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
        executable: "3bafa7e6ee51ba3ac4ed065883484a309be09b26ea6dad561ae4049bfe049c50",
      },
      "x64-linux": {
        archive: "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
        executable: "ebeaf56f8a25e102e9419933423738b3a2a613a444fd749d695e15eba53f71f2",
      },
      "arm64-win32": {
        archive: "00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e",
        executable: "f7799d737b520e00b10dfa72def23904fe66fb03315636a7b78549845ee9609c",
      },
      "ia32-win32": {
        archive: "725be85a1e8f92878a548f40ee4f6df64bc93b809586462b3c6d884e1de1e83a",
        executable: "7773ca1c74315c188a84937adbfa3af5b2fa8ef12be0249d66a6ce372f67e82e",
      },
      "x64-win32": {
        archive: "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
        executable: "decdd4992f3f1b9a5ef9898f1b40ab16886d579d6516b4efd3d5eaa19364e408",
      },
    },
  } satisfies Record<string, Record<keyof typeof PLATFORM, { archive: string; executable: string }>>

  /** The digest set for the release `VERSION` actually asks the network for. See the ⚠️ above. */
  const PINNED: Record<keyof typeof PLATFORM, { archive: string; executable: string }> = CHECKSUM[VERSION]

  const HEX_SHA256 = /^[0-9a-f]{64}$/

  export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

  /**
   * Fail-closed integrity gate. Returns normally **only** when `bytes` is byte-identical to the
   * reviewed artefact; every other outcome throws. There is deliberately no third branch —
   * "unknown, therefore allow" is the shape this whole pin exists to delete.
   *
   * Pure and exported so every refusal is unit-testable without a network download.
   */
  export const verifyDigest = (bytes: Uint8Array, expected: string | undefined, source: string): void => {
    if (expected === undefined || !HEX_SHA256.test(expected))
      throw new Error(
        `refusing to install ${source}: no pinned SHA-256 for it (ripgrep ${VERSION}). ` +
          `Add the digest to CHECKSUM in ripgrep/binary.ts — an unpinned artefact is never extracted or executed.`,
      )
    if (bytes.byteLength === 0) throw new Error(`refusing to install ${source}: it is empty`)
    const actual = sha256Hex(bytes)
    if (actual !== expected)
      throw new Error(
        `refusing to install ${source}: SHA-256 mismatch — pinned ${expected}, got ${actual}. ` +
          `ripgrep was not installed.`,
      )
  }

  /**
   * The non-throwing twin, for the one question that is a *decision* rather than a fault: is the
   * binary already on disk one of ours, or must it be re-downloaded? Delegating to `verifyDigest`
   * rather than re-implementing the comparison is deliberate — two copies of a fail-closed check are
   * two chances for one of them to drift open.
   *
   * ⚠️ The parameter is `candidate`, not `bytes`, on purpose: `ripgrep-integrity.test.ts` locates the
   * archive gate by the literal `verifyDigest(bytes`, and a second call spelled that way would make
   * its ordering assertion match *this* line instead — a guard quietly checking the wrong thing.
   */
  export const matchesDigest = (candidate: Uint8Array, expected: string | undefined): boolean => {
    try {
      verifyDigest(candidate, expected, "the installed ripgrep")
      return true
    } catch {
      return false
    }
  }

  interface Interface {
    readonly filepath: Effect.Effect<string, Error>
  }

  export class Service extends Context.Service<Service, Interface>()("@novaclaw/RipgrepBinary") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const http = yield* HttpClient.HttpClient
      const spawner = yield* ChildProcessSpawner

      const run = Effect.fnUntraced(function* (command: string, args: string[]) {
        const handle = yield* spawner.spawn(ChildProcess.make(command, args, { extendEnv: true, stdin: "ignore" }))
        const [stdout, stderr, code] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        )
        return { stdout, stderr, code }
      }, Effect.scoped)

      const extract = Effect.fnUntraced(function* (
        archive: string,
        config: (typeof PLATFORM)[keyof typeof PLATFORM],
        target: string,
      ) {
        const dir = yield* fs.makeTempDirectoryScoped({ directory: Global.Path.bin, prefix: "ripgrep-" })

        if (config.extension === "zip") {
          const shell = (yield* Effect.sync(() => which("powershell.exe") ?? which("pwsh.exe"))) ?? "powershell.exe"
          const result = yield* run(shell, [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${dir.replaceAll("'", "''")}' -Force`,
          ])
          if (result.code !== 0)
            throw new Error(
              result.stderr.trim() || result.stdout.trim() || `ripgrep extraction failed with code ${result.code}`,
            )
        }

        if (config.extension === "tar.gz") {
          const result = yield* run("tar", ["-xzf", archive, "-C", dir])
          if (result.code !== 0)
            throw new Error(
              result.stderr.trim() || result.stdout.trim() || `ripgrep extraction failed with code ${result.code}`,
            )
        }

        const extracted = path.join(
          dir,
          `ripgrep-${VERSION}-${config.platform}`,
          process.platform === "win32" ? "rg.exe" : "rg",
        )
        if (!(yield* fs.isFile(extracted))) throw new Error(`ripgrep archive did not contain executable: ${extracted}`)

        yield* fs.copyFile(extracted, target)
        if (process.platform !== "win32") yield* fs.chmod(target, 0o755)
      }, Effect.scoped)

      return Service.of({
        filepath: yield* Effect.cached(
          Effect.gen(function* () {
            // A system rg is the user's own OS package (winget/apt/brew), not an artefact NovaClaw
            // downloaded. The pin below governs only our acquisition path; refusing a user-selected
            // system version would turn supply-chain verification into package-manager policy.
            const system = yield* Effect.sync(() => which(process.platform === "win32" ? "rg.exe" : "rg"))
            if (system && (yield* fs.isFile(system).pipe(Effect.orDie))) return system

            const platformKey = `${process.arch}-${process.platform}` as keyof typeof PLATFORM
            const config = PLATFORM[platformKey]
            if (!config) throw new Error(`unsupported platform for ripgrep: ${platformKey}`)
            const pin: { archive: string; executable: string } | undefined = PINNED[platformKey]

            // An already-installed copy is ours to trust only when it hashes to the pinned executable.
            // A bare `isFile(target)` — what this used to be — re-executes forever whatever an
            // unverified earlier build left on disk, so the archive pin alone would have protected
            // fresh installs and nobody else. A genuine inherited binary passes here with no network,
            // which is what keeps an offline box working; anything else falls through and re-downloads.
            const target = path.join(Global.Path.bin, `rg${process.platform === "win32" ? ".exe" : ""}`)
            if (yield* fs.isFile(target).pipe(Effect.orDie)) {
              const existing = yield* fs.readFile(target).pipe(Effect.orElseSucceed(() => undefined))
              if (existing !== undefined && matchesDigest(existing, pin?.executable)) return target
            }

            const filename = `ripgrep-${VERSION}-${config.platform}.${config.extension}`
            const url = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${filename}`
            const archive = path.join(Global.Path.bin, filename)

            yield* Effect.logInfo("downloading ripgrep", { url })
            yield* fs.ensureDir(Global.Path.bin).pipe(Effect.orDie)
            yield* Download.toFile({
              url,
              destination: archive,
              integrity: { sha256: pin?.archive ?? "" },
            }).pipe(Effect.provideService(FSUtil.Service, fs), Effect.provideService(HttpClient.HttpClient, http))
            yield* extract(archive, config, target)
            yield* fs.remove(archive, { force: true }).pipe(Effect.ignore)

            // The post-condition that makes the invariant unconditional: every path out of this
            // Effect returns a file that hashed to a pinned digest. Implied by the archive digest, and
            // asserted anyway so `extract` cannot quietly become the weak link (it shells out to
            // PowerShell/tar and copies out of a temp directory).
            const installed = yield* fs.readFile(target)
            verifyDigest(installed, pin?.executable, target)
            return target
          }),
        ),
      })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
  )

  export const node = makeGlobalNode({
    service: Service,
    layer: layer,
    deps: [FSUtil.node, httpClient, CrossSpawnSpawner.node],
  })
}
