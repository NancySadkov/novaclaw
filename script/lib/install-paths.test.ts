import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  bunfigFreezesLockfile,
  invocationKey,
  scanInstallInvocations,
  stripComments,
  type InstallInvocation,
} from "./install-paths"

// The invariant: **no path in this repo re-resolves dependencies.** Every install replays `bun.lock`
// and REFUSES when the lockfile and the manifests disagree.
//
// It is here because on 2026-08-04 that was the only thing between us and a live compromise. The
// `keyv`/`cacheable` maintainer's package-registry account was taken over, poisoned releases went out carrying
// valid npm provenance, and a worm reached ~444 packages. Three of the poisoned versions were INSIDE
// our declared `^` ranges — a re-resolving install would have taken them. Our lock pinned the versions
// one release below, so we were untouched. Nothing about our dependency choices saved us; the lockfile
// did, and only because every install happened to honour it.
//
// ⚠️ **"Happened to" is what this file removes.** The failure mode is not a wrong flag, it is a MISSING
// one, and a missing `--frozen-lockfile` makes builds greener rather than redder: the install quietly
// fixes whatever drifted and no test, typecheck or reviewer ever sees it. That is todo.md ruling 1's
// exact class — an invariant whose violation compiles green — so it ships with a check or it does not
// exist.

const ROOT = join(import.meta.dir, "..", "..")

/**
 * Tree-MUTATING installs — `bun add`/`npm install <pkg>` by another spelling. Shrink-only: removing an
 * entry is a good day, adding one needs an argument in the diff.
 *
 * ⚠️ These deliberately do NOT carry `--frozen-lockfile`, and adding it would be the very defect this
 * file exists to catch: a flag that is present and inert. Measured on bun 1.3.14 — `bun add` is not a
 * lockfile replay, so the flag does not govern it. Under the root bunfig's `frozenLockfile = true` it
 * succeeds when it needs no lockfile change (verified against `@parcel/watcher@2.5.1` already pinned at
 * that exact version: exit 0, 13 platform packages installed, `bun.lock` byte-identical — i.e. the
 * release build is unaffected) and refuses outright when it would add something new. So the protection
 * on these lines is the bunfig, and what this ledger buys is that a NEW one cannot appear unnoticed.
 */
const TREE_MUTATING_INSTALLS: readonly string[] = [
  // The release build re-installs an already-pinned package with `--os="*" --cpu="*"` so every
  // platform's optional binaries land in the tree before cross-target binaries are assembled. The
  // version is read out of the manifest by literal key (`todo/supply-chain.md` §4), so it cannot
  // float. `build-linux.sh` passes `--skip-install` and never reaches it.
  //
  // ⚠️ This was TWO lines until `@parcel/watcher` was replaced by `packages/host`, which is compiled
  // from our own source rather than installed — one fewer platform-binary fan-out to trust.
  'packages/novaclaw/script/build.ts :: bun install --os="*" --cpu="*" @ff-labs/fff-bun@${pkg.dependencies["@ff-labs/fff-bun"]}',
  // ⚠️ A second entry lived here until 2026-09-01 (RF-13-15's sibling, RF-24-13):
  // `http-recorder/script/verify-package.ts :: npm install "--ignore-scripts" …`, which packed the
  // package and installed the tarball into a throwaway directory. It was the tree's ONE npm
  // invocation. It went with the script, which could never run: `pack.ts` built its tarball path from
  // `pkg.version` and that manifest declares no `version`, so the name resolved to `…-undefined.tgz`
  // — and the package is `@novaclaw/http-recorder`, so `bun pm pack` would not have written that
  // filename even with one. The publication posture around it (`publishConfig`, `keywords`,
  // `homepage`, `bugs`) went too: the standing rule is that we never publish to npm.
  //
  // 🔴 **So this list is now empty of npm, and that is the STRONGER guarantee** — not a gap. The
  // scan below still runs; an entry reappearing here means someone reintroduced an npm invocation,
  // and npm runs every dependency's `postinstall` by default where bun runs them only for
  // `trustedDependencies`. Do not delete this comment to tidy an empty-looking list.
]

const fixtures: string[] = []
function fixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "install-paths-"))
  fixtures.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative)
    mkdirSync(join(absolute, ".."), { recursive: true })
    writeFileSync(absolute, content)
  }
  return root
}

describe("the repo's install paths", () => {
  const invocations = scanInstallInvocations(ROOT)

  // A ledger over an empty scan is a ledger that proves nothing — this is the vacuous-pass guard.
  // ⚠️ It is a FLOOR, so it moves down only when an install path is deleted, and the deletion is the
  // thing to justify — not the number. Lowered 5 → 4 on 2026-08-07 when `packages/desktop`'s
  // `native:build` went: it installed into `packages/desktop/native/`, a directory never tracked in
  // any commit, and running it produced `failed to change directory to "native": ENOENT`.
  test("the scan actually finds this repo's install paths", () => {
    // ⚠️ A FLOOR on the scanner, not on the repo: it exists so a scan that silently matches nothing
    // cannot make every other test in this file vacuously green. Lowered 4 → 3 when `@parcel/watcher`
    // was replaced by `packages/host`, which is compiled rather than installed. Lower it only with
    // the removed invocation named, and never to zero.
    //
    // Lowered 3 → 2 on 2026-09-01 (RF-24-13). The removed invocation, named as this comment requires:
    // `packages/http-recorder/script/verify-package.ts :: npm install "--ignore-scripts" …`. The
    // deletion is what is justified, not the number — that script packed the package and installed
    // the tarball to prove it resolves, and it could never run: `pack.ts` built the tarball path from
    // `pkg.version`, which that manifest does not declare, so it resolved to `…-undefined.tgz`. It
    // was also the tree's only npm invocation, for a package our standing rule forbids publishing.
    expect(invocations.length).toBeGreaterThanOrEqual(2)
    expect(invocations.map((item) => item.file)).toContain("build-linux.sh")
  })

  test("every lockfile-replaying install refuses rather than re-resolves", () => {
    const offenders = invocations.filter((item) => item.kind === "bare" && !item.frozen).map(invocationKey)
    expect(offenders).toEqual([])
  })

  test("tree-mutating installs are pinned by name (shrink-only)", () => {
    const found = invocations
      .filter((item) => item.kind === "specifier")
      .map(invocationKey)
      .sort()
    expect(found).toEqual([...TREE_MUTATING_INSTALLS].sort())
  })

  test("the root bunfig freezes the lockfile for every install, including from a subdirectory", () => {
    // Measured 2026-08-07 on bun 1.3.14: with this set, `bun install` against a perturbed manifest
    // refuses from the workspace root, from a package subdirectory, via `--cwd <subdir>`, and even when
    // that subdirectory carries its own bunfig with no `[install]` section. It is what covers the
    // install paths nobody has written yet — the ones a per-call-site flag can never reach.
    expect(bunfigFreezesLockfile(join(ROOT, "bunfig.toml"))).toBe(true)
  })

  test("bun.lock exists and is tracked — without it the freeze is inert", () => {
    // ⚠️ NOT decoration. `frozenLockfile` in a directory with no lockfile does not refuse: it resolves
    // freely and writes one (measured). So "the lockfile is committed" is a load-bearing half of the
    // control, not a separate hygiene rule.
    expect(existsSync(join(ROOT, "bun.lock"))).toBe(true)
    const tracked = Bun.spawnSync(["git", "ls-files", "--error-unmatch", "bun.lock"], { cwd: ROOT })
    expect({ exitCode: tracked.exitCode, stderr: tracked.stderr.toString().trim() }).toEqual({
      exitCode: 0,
      stderr: "",
    })
  })
})

describe("the scanner itself", () => {
  // Negative controls. A source scanner that cannot be shown to FAIL is indistinguishable from one that
  // returns [] — and an all-green ledger backed by a scanner that matches nothing is the failure this
  // repo has already shipped once.

  test("an unfrozen bare install is caught, in every shape it can be written", () => {
    const root = fixtureRepo({
      "release.sh": "#!/usr/bin/env bash\nbun install\n",
      "package.json": JSON.stringify({ scripts: { setup: "bun install --cwd packages/x" } }),
      "script/deploy.ts": "await $`pnpm install`\n",
    })
    const offenders = scanInstallInvocations(root)
      .filter((item) => item.kind === "bare" && !item.frozen)
      .map((item) => item.file)
      .sort()
    expect(offenders).toEqual(["package.json", "release.sh", "script/deploy.ts"])
  })

  test("a frozen bare install is not reported", () => {
    const root = fixtureRepo({
      "release.sh": "bun install --frozen-lockfile\n",
      "package.json": JSON.stringify({ scripts: { setup: "npm ci" } }),
    })
    expect(scanInstallInvocations(root).filter((item) => !item.frozen)).toEqual([])
  })

  test("PROSE is not an install path — comments and message strings are stripped", () => {
    // Both halves have a live instance in this tree, which is why both are asserted. `build-linux.sh`
    // has `# bun install is ~800 MB` in a comment AND `progress "… (bun install --frozen-lockfile)"`
    // as a user-facing string; `packages/core/src/agent-jail.ts` says "would kill `npm install`". An
    // earlier draft of this scanner reported the two shell strings as invocations — one of them as a
    // violation whose only "fix" was to make the progress message worse.
    const root = fixtureRepo({
      "release.sh": '# bun install is ~800 MB of disk\necho "run bun install first"\nprogress "bun install"\n',
      "script/note.ts": "// npm install would be wrong here\n/* bun install */\n",
    })
    expect(scanInstallInvocations(root)).toEqual([])
  })

  test("a package specifier makes it an add, not a replay", () => {
    const root = fixtureRepo({ "script/build.ts": 'await $`bun install --os="*" some-pkg@1.2.3`\n' })
    const found = scanInstallInvocations(root)
    expect(found.map((item) => item.kind)).toEqual(["specifier"])
    // `--cwd <dir>` takes a VALUE — mistaking it for a package specifier would silently move a real
    // bare install into the exempt bucket, which is how this check would go quiet without going red.
    const withCwd = fixtureRepo({ "release.sh": "bun install --cwd packages/desktop/native\n" })
    expect(scanInstallInvocations(withCwd).map((item) => item.kind)).toEqual(["bare"])
  })

  test("the argv-array form is found too", () => {
    const root = fixtureRepo({ "script/verify.ts": 'await run(["npm", "install", archive], directory)\n' })
    const found = scanInstallInvocations(root)
    expect(found.map((item) => ({ kind: item.kind, manager: item.manager }))).toEqual([
      { kind: "specifier", manager: "npm" },
    ])
  })

  test("bunfigFreezesLockfile reads the setting, not the word", () => {
    const root = fixtureRepo({
      "commented.toml": "[install]\n# frozenLockfile = true\nexact = true\n",
      "wrong-section.toml": "[install]\nexact = true\n\n[test]\nfrozenLockfile = true\n",
      "off.toml": "[install]\nfrozenLockfile = false\n",
      "on.toml": "[install]\nexact = true\nfrozenLockfile = true\n",
    })
    expect({
      commented: bunfigFreezesLockfile(join(root, "commented.toml")),
      wrongSection: bunfigFreezesLockfile(join(root, "wrong-section.toml")),
      off: bunfigFreezesLockfile(join(root, "off.toml")),
      on: bunfigFreezesLockfile(join(root, "on.toml")),
    }).toEqual({ commented: false, wrongSection: false, off: false, on: true })
  })

  test("stripComments blanks rather than deletes, so line numbers survive", () => {
    const stripped = stripComments("a\n/* x\n y */\nb // c\n", "ts")
    expect(stripped.split("\n").length).toBe(5)
    expect(stripped.split("\n")[3]).toBe("b ")
  })
})

process.on("exit", () => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true })
})

// Keeps the type import honest — `InstallInvocation` is the shape every assertion above reads.
const _shape: (invocation: InstallInvocation) => string = invocationKey
void _shape
