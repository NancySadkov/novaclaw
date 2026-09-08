# ImageMagick distribution notice

NovaClaw Windows distributions embed **ImageMagick 7.1.2-29** (Q16, x64, portable), published by
ImageMagick Studio LLC: <https://imagemagick.org>.

Copyright © 1999 ImageMagick Studio LLC. Licensed under the **ImageMagick License**, a derivative of
the Apache License 2.0: <https://imagemagick.org/license/>. It permits redistribution — including in
packages you create, and for commercial purposes — and **requires** that a copy of the licence
travel with the redistribution and that clear attribution be given to ImageMagick Studio LLC. This
file and the retained upstream files are that attribution.

## What is shipped, and what is not

Only **`magick.exe`** is embedded, together with the XML configuration and colour profile it reads
from beside itself (`configure.xml`, `delegates.xml`, `policy.xml`, `type.xml`, `type-ghostscript.xml`,
`colors.xml`, `english.xml`, `locale.xml`, `log.xml`, `mime.xml`, `thresholds.xml`, `sRGB.icc`).

The upstream portable archive additionally contains `compare.exe`, `composite.exe`, `conjure.exe`,
`identify.exe`, `mogrify.exe`, `montage.exe` and `stream.exe`. On the 7.1.2-29 x64 build these are
**byte-identical 31 MB copies of the same static binary**, dispatching on `argv[0]`; in ImageMagick 7
every one of them is reachable as `magick <verb>`. Shipping them would have cost 217 MB of pure
duplication, so they are omitted. No functionality is lost and no component is modified.

Upstream's own `LICENSE.txt`, `NOTICE.txt` and `ChangeLog.md` are retained verbatim inside
`resources/third-party/imagemagick/` in the installed application — `NOTICE.txt` carries the notices
for the independently licensed libraries ImageMagick links (libpng, libjpeg-turbo, libtiff, libwebp,
freetype, zlib and others), each under its own terms.

## Trademarks

The ImageMagick name and marks are owned by ImageMagick Studio LLC. Nothing in NovaClaw's use of
them states or implies that ImageMagick Studio LLC endorses NovaClaw, or that NovaClaw's authors
created the ImageMagick software.

## Reproducible acquisition

The pinned version and SHA-256 live in `packages/desktop/scripts/prepare-imagemagick.ts`; the verified
redistributable is retained in `supply/`, and builds neither discover nor auto-update it.
Corresponding upstream source for the exact version is published in the project's official archive:
<https://download.imagemagick.org/archive/releases/>.
