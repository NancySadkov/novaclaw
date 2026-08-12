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
 * Toolchain: the w64devkit g++ NovaClaw already ships on Windows (`third-party/w64devkit`), and the
 * system g++ elsewhere. No new dependency is introduced by this file.
 */
import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"

const root = path.dirname(Bun.fileURLToPath(import.meta.url))
const out = path.join(root, "build")
mkdirSync(out, { recursive: true })

/** Where the compiler is. An explicit override wins so a packaged build can point at its own copy. */
const compiler = () => {
  const explicit = process.env["HOST_CXX"]
  if (explicit) return explicit
  if (process.platform !== "win32") return "g++"
  for (const candidate of [
    "C:/w64devkit/bin/g++.exe",
    path.join(root, "..", "..", "third-party", "w64devkit", "bin", "g++.exe"),
  ])
    if (existsSync(candidate)) return candidate
  return "g++"
}

const sources = [path.join(root, "src", process.platform === "win32" ? "watch_win32.cc" : "watch_linux.cc")]
const target = path.join(out, process.platform === "win32" ? "host.dll" : "libhost.so")

const argv = [
  compiler(),
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
const result = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" })
if (result.exitCode !== 0) {
  console.error(`\nhost: build FAILED (exit ${result.exitCode})`)
  process.exit(result.exitCode ?? 1)
}
console.log(`host: built ${target}`)
