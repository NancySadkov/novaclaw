#!/usr/bin/env bun
/**
 * Build the host module.
 *
 * ⭐ Owner ruling 2026-08-12: NovaClaw builds its own native host layer so a segfault is debuggable.
 * That means this script, not node-gyp — one compiler invocation, flags we chose, symbols we keep.
 *
 * ⚠️ `-g` is NOT optional and is kept in the shipped artifact. The crash that started this module
 * came from a binary whose PDB lived on somebody else's CI runner, so there was no route from a
 * faulting address to a line. Stripping our own symbols to save a few hundred kilobytes would
 * reproduce exactly that, on purpose.
 *
 * 🔴 **Toolchain, owner ruling 2026-08-19: on Windows NovaClaw's C/C++ is built by the EXACT
 * w64devkit NovaClaw ships — the same pinned tree, not merely one of the same name.** The path is
 * imported from the provisioner rather than written here, so there is one definition of where the
 * kit is and it cannot drift again; a hand-installed `C:\w64devkit` is deliberately NOT accepted,
 * because "a w64devkit" is not "our w64devkit" and a different version is a different runtime.
 * Elsewhere the system g++ is the platform's own toolchain and the right answer. No new dependency
 * is introduced by this file.
 *
 * (This header used to name `third-party/w64devkit` — a path that has never existed in this layout.
 * That literal is what silently disabled the native watcher; see `compiler()` for the full cost.)
 */
import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"

// ⚠️ A build script reaching from `host` into `desktop` is an inversion, and it is the deliberate
// price of a SINGLE source of truth for the kit's location: the kit lives in the desktop package
// because that is the package electron-builder ships it from. The alternative — repeating the path
// here — is precisely the bug this import removes. Nothing at module scope runs on import; the
// provisioner's CLI is `import.meta.main`-guarded.
import { prepareW64devkit, W64DEVKIT_RESOURCE, W64DEVKIT_VERSION } from "../desktop/scripts/prepare-w64devkit"

const root = path.dirname(Bun.fileURLToPath(import.meta.url))
const out = path.join(root, "build")
mkdirSync(out, { recursive: true })

/**
 * Where the compiler is.
 *
 * 🔴 **On Windows it is the SHIPPED w64devkit or nothing** (owner, 2026-08-19). A system g++ —
 * MSYS2, a MinGW install, the one Strawberry Perl drags in — links the DLL against *its own*
 * `libstdc++-6.dll` and `libwinpthread-1.dll`, so the artifact loads on the machine that built it
 * and on no other. That is the whole reason for the `-static*` flags below, and a silent fallback to
 * another compiler defeats them just as completely as dropping the flags would. There is no hardship
 * in refusing: `prepare-w64devkit.ts` downloads and SHA-256 verifies the pinned kit, `prebuild.ts`
 * awaits it immediately before invoking this script, and `electron-builder.config.ts` then ships the
 * same 594 MB tree as an extraResource — the toolchain is present by construction, so its absence is
 * a broken checkout to be reported, never a condition to route around.
 *
 * `HOST_CXX` still wins, because an explicit operator choice is not a silent fallback — but it is
 * expected to name another copy of the kit, and it gets the same PATH treatment for the reason below.
 *
 * Returns the `bin` directory alongside, because g++ is a DRIVER: it executes `as` and `ld` as
 * separate programs and finds them on PATH, so naming g++ by absolute path is only half a toolchain.
 * Measured 2026-08-19, immediately after fixing the lookup: `g++.exe: fatal error: cannot execute 'as'`.
 */
const compiler = async (): Promise<{ cxx: string; bin?: string }> => {
  const explicit = process.env["HOST_CXX"]
  // An explicit operator choice is not a silent fallback, so it still wins — but it is expected to
  // name the SAME pinned kit at another location (the copy inside a packaged app, say), never a
  // system compiler. Absolute paths get the PATH scrub below for the `as`/`ld` reason.
  if (explicit) return path.isAbsolute(explicit) ? { cxx: explicit, bin: path.dirname(explicit) } : { cxx: explicit }
  // Elsewhere the system toolchain IS the platform's own, and there is no w64devkit to speak of.
  if (process.platform !== "win32") return { cxx: "g++" }

  // Provision on demand — the same idempotent, SHA-256-verified downloader `prebuild.ts` awaits, and
  // a no-op when the kit is already valid. It is called here so that EVERY route to this script ends
  // at the shipped kit: `bun packages/host/build.ts` on a fresh clone now fetches the pinned tree
  // instead of failing, and no caller has to remember an ordering rule.
  await prepareW64devkit()
  const bin = path.join(W64DEVKIT_RESOURCE, "bin")
  const cxx = path.join(bin, "g++.exe")
  if (existsSync(cxx)) return { cxx, bin }
  // ⚠️ REFUSE — never fall back to a bare "g++". Reaching here means provisioning itself failed
  // (offline, or a hash mismatch), and the fallback's output would be a DLL bound to this machine's
  // runtime DLLs that fails at LOAD time on the user's, far from anything that could explain it.
  throw new Error(
    `host: the shipped w64devkit ${W64DEVKIT_VERSION} is not at ${bin}, and a system g++ is not an ` +
      "acceptable substitute — it would link against runtime DLLs that exist only on this machine. " +
      "Provisioning runs automatically here, so this means it failed: check the network and rerun, " +
      "or set HOST_CXX to another copy of the same kit.",
  )
}

const { cxx, bin } = await compiler()

/**
 * The kit's own `bin`, and NOTHING else, when we resolved a kit — the same scrub
 * `packages/desktop/scripts/smoke-artifact.ts` applies to its packaged-toolchain check, for the same
 * reason: with the developer's PATH still present, a stray MinGW/MSYS2/Strawberry-Perl `as` or `ld`
 * can satisfy an assembly or link the SHIPPED kit cannot, so an incomplete kit builds green on any
 * machine that has ever installed a compiler and fails only on the clean guest. Windows resolves
 * kernel32 and friends from the system directory regardless of PATH, so this costs a complete kit
 * nothing. A bare "g++" (Linux, or the HOST_CXX override) keeps the inherited environment — there
 * the toolchain IS the system's.
 */
const env = (() => {
  if (!bin) return undefined
  const scrubbed = { ...process.env }
  for (const key of Object.keys(scrubbed)) if (key.toLowerCase() === "path") delete scrubbed[key]
  scrubbed["PATH"] = bin
  return scrubbed
})()

const sources = [path.join(root, "src", process.platform === "win32" ? "watch_win32.cc" : "watch_linux.cc")]
// ⚠️ The NAME is part of the contract, and it was WRONG on Linux. `host.bun.ts` resolves
// `host.${suffix}` from `bun:ffi` — host.dll / host.so / host.dylib — so emitting `libhost.so` meant
// the loader looked for a file this script never writes. `available()` then answers false with no
// error anywhere: the watcher is simply absent, which is the silent-death shape the header of
// `host.bun.ts` exists to warn about.
const target = path.join(out, `host.${process.platform === "win32" ? "dll" : process.platform === "darwin" ? "dylib" : "so"}`)

const argv = [
  cxx,
  "-shared",
  "-std=c++17",
  "-O2",
  // Symbols, deliberately — see the header note above.
  "-g",
  "-fno-omit-frame-pointer",
  // Warnings are not decoration in a file that owns raw handles and a thread.
  "-Wall",
  "-Wextra",
  `-I${path.join(root, "include")}`,
  ...sources,
  "-o",
  target,
]
if (process.platform !== "win32") argv.push("-fPIC", "-pthread")
// ⚠️ Statically linked runtime on Windows: the DLL must not depend on a libstdc++/libwinpthread that
// only exists inside w64devkit's own bin directory, or it loads on the build machine and nowhere else.
else argv.push("-static", "-static-libgcc", "-static-libstdc++")

console.log(argv.join(" "))
const result = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit", env })
if (result.exitCode !== 0) {
  console.error(`\nhost: build FAILED (exit ${result.exitCode})`)
  process.exit(result.exitCode ?? 1)
}
console.log(`host: built ${target}`)
