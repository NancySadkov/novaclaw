# PortableGit distribution notice

NovaClaw Windows distributions embed PortableGit 2.55.0.5 (Git for Windows), published by the
Git for Windows contributors. It supplies Bash, Git, and their supporting MSYS2 runtime files.

The complete upstream binary tree, including `LICENSE.txt` and its package metadata, is retained
under `resources/third-party/portable-git/` in the installed application. The verified upstream
archive is retained in `supply/PortableGit-2.55.0.5-64-bit.7z.exe`; its SHA-256 is pinned in
`packages/desktop/scripts/prepare-portable-git.ts`.

## Written source offer

For at least three years after distributing a NovaClaw build containing this PortableGit version,
the NovaClaw publisher offers any third party the complete corresponding source code for the
GPL-licensed components in this PortableGit binary, including the build scripts and patches, for a
charge no greater than the cost of physically performing source distribution. Request the source
through https://github.com/NancySadkov/novaclaw/issues/new and identify PortableGit 2.55.0.5.

The upstream release is https://github.com/git-for-windows/git/releases/tag/v2.55.0.windows.5.
The exact component versions are retained at
`resources/third-party/portable-git/etc/package-versions.txt`. The Git for Windows project
publishes the source-gathering recipe at
https://github.com/git-for-windows/build-extra/blob/main/get-sources.sh.
