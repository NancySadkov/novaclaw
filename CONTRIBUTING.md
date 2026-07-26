# Contributing to NovaClaw

NovaClaw is developed by Nancy Sadkov. The source is published so you can read it, audit it, build
it, and fix it — see [LICENSE](LICENSE) for what you may do with it.

## Before you write code

**Ask first.** NovaClaw has a strong architectural direction, and a patch that cuts against it gets
rejected no matter how good the code is. Describe what you want to change and why before you build
it — it costs you one message and can save you a weekend.

Two rules that decide most patches:

- **Kernel or app?** NovaClaw ships an agent OS kernel and a friendly UI, and nothing else. Developer
  services — language servers, code indexers, editor integrations — are *apps on the OS*, not kernel
  features. If your feature could be an app, build it as an app; the app registry is the seam and
  your app is yours under any license you like.
- **One UI, for humans.** The product face is the HTML UI (desktop and web). There is no interactive
  terminal UI, and patches adding one will not be merged. When a capability could live as a
  developer/terminal surface or as an app in the shell, it lives in the shell.

## The Contributor License Agreement

**Every contribution requires a signed [CLA](CLA.md), once, before it can be merged.**

This is not bureaucracy for its own sake. NovaClaw's [LICENSE](LICENSE) makes an irrevocable promise
that every release converts to Apache 2.0 after two years, and a commercial license is available for
anyone who needs one. Both require the right to relicense every line in the tree. A contribution we
cannot relicense would have to be reverted later, so it is cleaner to settle it up front.

You keep the copyright in your work. The CLA is a license, not a handover.

**To sign:** copy the signature block from [CLA.md](CLA.md), fill it in, and email it as plain text.
A typed name sent from your own email address is a valid signature. You only do this once.

## Sending a patch

NovaClaw is not developed on a public forge. Contributions arrive by email, in the classic style:

```bash
git format-patch origin/main --stdout > my-change.patch
```

Send the patch file, plus a short description of what it does and how you tested it.

Sign off each commit, certifying that you wrote it and may submit it:

```bash
git commit -s -m "fix(session): stop the drain loop leaking a fiber"
```

That adds a `Signed-off-by:` line. It is the per-commit companion to the CLA, not a replacement for
it.

**Contact:** through [novaclaw.app](https://novaclaw.app).

## What a good patch looks like

The verification standard here is high, because there is no second reviewer:

- **Tests, always.** Every change ships with unit tests over the logic it adds. Extract pure logic
  into testable modules and cover the cases.
- **The suite is green before and after.** `bun run test` — one command, the fast hermetic tier.
  Say in your description what you ran and what it printed.
- **Runner and session changes need a live model.** Unit tests never execute `runner/llm.ts`. If you
  touch the session runtime, verify against a real local model and report what you observed.
- **Report what you actually ran**, not what should work. If something is unverified, say so plainly.
  An honest "I could not test the Windows path" is worth more than a confident guess.
- **Match the surrounding code.** Its naming, its comment density, its idiom.
- **One change per patch.** A patch that fixes a bug and reorganises three files is two patches.

## Build and test

```bash
bun install          # requires Bun 1.3.14, Node 24+
bun run test         # fast hermetic suite — the day-to-day gate
bun run dev:desktop  # the Electron app
bun run dev:web      # the web UI in a browser
```

See [README.md](README.md) for the full build matrix and the packaged-build steps.

## Reporting bugs and security issues

**Bugs:** tell us what you did, what happened, what you expected, and your platform and version.
A NovaClaw session export (Chats → export as Markdown) is the most useful attachment there is.

**Security issues:** report privately through [novaclaw.app](https://novaclaw.app) — not in public.
Give us a reasonable window to ship a fix before disclosing. NovaClaw handles people's chats, code,
and credentials; a quiet fix protects users who have not updated yet.

## Things that are welcome

- Bug fixes with a test that fails before and passes after.
- Platform support — macOS and Linux packaging, and the Agent Jail backends for those hosts.
- Driver work behind existing seams (messengers, providers, devices).
- Documentation and UI copy that makes NovaClaw legible to a non-expert. The product teaches as it
  works; if something confused you, that is a bug worth reporting.
- Translations.

## Things that are not

- An interactive terminal UI.
- Branded provider integrations in the kernel. External APIs go through generic channels; a
  user-wanted provider is configured, not compiled in.
- Anything that makes the data plane egress. Chats, code, and knowledge stay on the user's machine.
- Dependencies added for convenience. Every one is a supply-chain surface and a startup-time cost.
