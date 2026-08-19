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
 * Toolchain: the w64devkit g++ NovaClaw already ships on Windows — provisioned into
 * `packages/desktop/resources/third-party/w64devkit` — and the system g++ elsewhere. No new
 * dependency is introduced by this file. (This line used to name `third-party/w64devkit`, a path
 * that has never existed in this layout; see the lookup below for what that cost.)
 */
import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"

const root = path.dirname(Bun.fileURLToPath(import.meta.url))
const out = path.join(root, "build")
mkdirSync(out, { recursive: true })

/**
 * Where the compiler is. An explicit override wins so a packaged build can point at its own copy.
 *
 * Returns the `bin` directory too when the compiler came from a w64devkit kit, because g++ is a
 * DRIVER: it executes `as` and `ld` as separate programs and finds them on PATH, so naming g++ by
 * absolute path is only half a toolchain. Measured 2026-08-19, immediately after fixing the lookup
 * below: `g++.exe: fatal error: cannot execute 'as'`.
 */
const compiler = (): { cxx: string; bin?: string } => {
  const explicit = process.env["HOST_CXX"]
  if (explicit) return { cxx: explicit }
  if (process.platform !== "win32") return { cxx: "g++" }
  for (const candidate of [
    // 🔴 The kit this repo ACTUALLY provisions, and the reason it is first: it is version-pinned and
    // SHA-256 verified by `packages/desktop/scripts/prepare-w64devkit.ts`, which `prebuild.ts` awaits
    // before invoking this script — so on a Windows build machine it is present and reproducible,
    // while a machine-local toolchain is neither. The two paths below never existed in this layout:
    // measured 2026-08-19 during the 0.1.63 release build, where the lookup fell through to a bare
    // "g++", died with ENOENT, and the non-fatal catch in `prebuild.ts` packaged whatever stale
    // host.dll happened to be in build/ — and on a clean clone would have packaged NONE, shipping an
    // app with file watching silently absent. A soft-failing compile needs a lookup that cannot miss.
    path.join(root, "..", "desktop", "resources", "third-party", "w64devkit", "bin", "g++.exe"),
    "C:/w64devkit/bin/g++.exe",
    path.join(root, "..", "..", "third-party", "w64devkit", "bin", "g++.exe"),
  ])
    if (existsSync(candidate)) return { cxx: candidate, bin: path.dirname(candidate) }
  return { cxx: "g++" }
}

const { cxx, bin } = compiler()

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
const target = path.join(out, process.platform === "win32" ? "host.dll" : "libhost.so")

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
