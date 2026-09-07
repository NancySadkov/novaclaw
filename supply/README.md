# Build supply

This directory retains third-party inputs required to reproduce specific NovaClaw builds. Large
artifacts are stored with Git LFS, and build tooling must verify a pinned digest before using them.
They belong here rather than in `tmp/` or a release `dist/` directory because both are disposable.

`w64devkit-2.9.0-source.tar` is the corresponding-source archive for the Windows toolchain shipped
by NovaClaw 0.1.71. `packages/desktop/scripts/prepare-w64devkit.ts` owns its filename and SHA-256.
