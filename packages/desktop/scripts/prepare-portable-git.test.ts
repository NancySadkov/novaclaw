import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { refreshSourceOffer, removeCredentialManager } from "./prepare-portable-git"

test("missing or stale source offers are restored without re-extracting the toolchain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "novaclaw-source-offer-"))
  try {
    const offer = Buffer.from("Complete corresponding source is available on request.\n")
    const file = path.join(root, "SOURCE-OFFER.txt")
    await refreshSourceOffer(root, offer)
    expect(await readFile(file)).toEqual(offer)
    await writeFile(file, "obsolete offer")
    await refreshSourceOffer(root, offer)
    expect(await readFile(file)).toEqual(offer)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("removes the optional graphical credential stack while retaining Git's native libraries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "novaclaw-mingit-trim-"))
  try {
    const bin = path.join(root, "mingw64", "bin")
    await mkdir(bin, { recursive: true })
    await mkdir(path.join(root, "etc"))
    for (const name of [
      "Avalonia.OpenGL.dll",
      "libSkiaSharp.dll",
      "git-credential-manager.exe",
      "git-credential-helper-selector.exe",
      "git-askpass.exe",
      "git-askyesno.exe",
      "git.exe",
      "libcrypto-3-x64.dll",
    ])
      await writeFile(path.join(bin, name), name)
    for (const name of [
      "mingw64/libexec/git-core/git-credential-wincred.exe",
      "mingw64/share/git/edit-git-bash.exe",
      "mingw64/share/git/git-wrapper.exe",
      "mingw64/share/doc/git-doc/gitk.html",
      "mingw64/share/doc/git-doc/gitk.adoc",
    ]) {
      const file = path.join(root, name)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, name)
    }
    await writeFile(
      path.join(root, "etc", "gitconfig"),
      "[credential]\n\thelper = manager\n[core]\n\tsymlinks = false\n",
    )
    await writeFile(
      path.join(root, "etc", "package-versions.txt"),
      "git 2.55.0.5\nmingw-w64-x86_64-git-credential-manager 2.9.1-1\n",
    )
    await removeCredentialManager(root)
    for (const name of [
      "Avalonia.OpenGL.dll",
      "libSkiaSharp.dll",
      "git-credential-manager.exe",
      "git-credential-helper-selector.exe",
      "git-askpass.exe",
      "git-askyesno.exe",
    ])
      expect(
        await stat(path.join(bin, name)).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
    for (const name of ["git.exe", "libcrypto-3-x64.dll"])
      expect(
        await stat(path.join(bin, name)).then(
          () => true,
          () => false,
        ),
      ).toBe(true)
    for (const name of [
      "mingw64/libexec/git-core/git-credential-wincred.exe",
      "mingw64/share/git",
      "mingw64/share/doc/git-doc/gitk.html",
      "mingw64/share/doc/git-doc/gitk.adoc",
    ])
      expect(
        await stat(path.join(root, name)).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
    expect(await readFile(path.join(root, "etc", "gitconfig"), "utf8")).toBe("[core]\n\tsymlinks = false\n")
    expect(await readFile(path.join(root, "etc", "package-versions.txt"), "utf8")).toBe("git 2.55.0.5\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
