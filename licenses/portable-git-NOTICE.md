# PortableGit distribution notice

Earlier NovaClaw Windows distributions embedded PortableGit 2.55.0.5 (Git for Windows), published
by the Git for Windows contributors. It supplied Bash, Git, and their supporting MSYS2 runtime files.

Those builds retained the complete upstream binary tree, including `LICENSE.txt` and its package
metadata, under `resources/third-party/portable-git/` in the installed application. The verified upstream
archive used by those builds had SHA-256
`5aa8a20f6e9abb2c755f0e73c91c687701a46b309ad84a0ca6509380fa4ae290`.

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
