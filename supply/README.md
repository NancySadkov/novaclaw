# Build supply

This directory retains third-party inputs required to reproduce specific NovaClaw builds. Large
artifacts are stored with Git LFS, and build tooling must verify a pinned digest before using them.
They belong here rather than in `tmp/` or a release `dist/` directory because both are disposable.

The current Windows baseline contains:

- `w64devkit-x64-2.9.0.7z.exe`, the prebuilt compiler/toolchain environment;
- `w64devkit-2.9.0-source.tar`, its corresponding source; and
- `ImageMagick-7.1.2-29-portable-Q16-x64.7z`, the image-tool redistributable.

The preparation scripts in `packages/desktop/scripts/` own their filenames and SHA-256 digests.
Changing a baseline is an explicit source change; builds never discover or auto-update these assets.
