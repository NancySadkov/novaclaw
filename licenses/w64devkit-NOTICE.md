# w64devkit distribution notice

NovaClaw Windows distributions embed **w64devkit 2.9.0**, built and published by Chris Wellons and
the w64devkit contributors.

The pinned binary distribution contains GCC, Binutils, MinGW-w64, busybox-w32 and other independently
licensed open-source components. Its upstream `README.md`, `VERSION.txt`, source/build recipe, and
`COPYING.MinGW-w64-runtime.txt` are retained inside `resources/third-party/w64devkit/` in the installed
application. The verified binary redistributable is retained in `supply/`; NovaClaw's reproducible
acquisition metadata and SHA-256 pin live in `packages/desktop/scripts/prepare-w64devkit.ts`.

Corresponding upstream source for the exact version is retained as `source.tar`, SHA-256
`170941e1239faf2affd1b70be827cbe93de07943236719e12b287a43c2a73eec`. NovaClaw's production release
script accepts it only from the repository supply inputs, verifies it, and emits that exact archive plus
its checksum beside the Windows and NovaClaw-source archives.
