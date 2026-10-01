import { createHash } from "node:crypto"

export namespace RipgrepPin {
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
          `Add the digest to CHECKSUM in ripgrep/pin.ts — an unpinned artefact is never extracted or executed.`,
      )
    if (bytes.byteLength === 0) throw new Error(`refusing to install ${source}: it is empty`)
    const actual = sha256Hex(bytes)
    if (actual !== expected)
      throw new Error(
        `refusing to install ${source}: SHA-256 mismatch — pinned ${expected}, got ${actual}. ` +
          `ripgrep was not installed.`,
      )
  }
}
