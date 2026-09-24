# Build supply

This directory retains third-party inputs required to reproduce specific NovaClaw builds. Large
artifacts use Git LFS; the MinGit ZIP is an ordinary Git binary blob because the current Git remote
does not serve LFS objects. Build tooling verifies a pinned digest before using each input.
They belong here rather than in `tmp/` or a release `dist/` directory because both are disposable.

The current Windows baseline contains:

- `w64devkit-x64-2.9.0.7z.exe`, the prebuilt compiler/toolchain environment;
- `w64devkit-2.9.0-source.tar`, its corresponding source; and
- `MinGit-2.55.0.5-64-bit.zip`, the compact Windows Git and SSH runtime extended with Bash;
- `ImageMagick-7.1.2-29-portable-Q16-x64.7z`, the image-tool redistributable.

The preparation scripts in `packages/desktop/scripts/` own their filenames and SHA-256 digests.
Changing a baseline is an explicit source change; builds never discover or auto-update these assets.
MinGit's source offer is retained in `licenses/mingit-NOTICE.md` and copied into the
installed resource tree as `SOURCE-OFFER.txt`.
The earlier PortableGit archive and its notice remain here to support source requests for older builds.
