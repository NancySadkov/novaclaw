# NovaClaw

**A local-first, model-agnostic AI agent OS.**

NovaClaw runs AI coding/agent sessions against **local models** (e.g. a vLLM server on a DGX Spark) or
any OpenAI-compatible endpoint — no paid APIs required. It ships a desktop app (Electron), a TUI, and a
server, and treats agent **sessions as OS-like threads** (spawn / exit / wait, an inheritable per-session
system prompt, and a shell-style home with apps).

## Status

Proprietary software, © Nancy Sadkov. Version 0.0.1, in active development. See [`LICENSE`](LICENSE).

## Models

NovaClaw is designed for **local, open-weight models** served over an OpenAI-compatible API
(`/v1/chat/completions` + `/v1/models`). Configure any endpoint via the built-in `openai-compatible`
provider; a few well-known providers (Anthropic, OpenAI, Google) are bundled only to help you bootstrap
with an existing key. Provider/model config lives in `novaclaw.jsonc`.

## Build

Requires Bun 1.3.14, Node 24+, and a Rust toolchain for some native deps.

```sh
bun install
# desktop app:
bun --cwd packages/desktop dev
# server/CLI (headless):
bun run --cwd packages/novaclaw --conditions=browser src/index.ts serve
```

## Attribution

NovaClaw began as a fork of [opencode](https://github.com/anomalyco/opencode) (MIT). Portions of this
codebase are based on opencode; that MIT license and copyright are retained in
[`licenses/opencode-LICENSE-MIT.txt`](licenses/opencode-LICENSE-MIT.txt) and [`NOTICE`](NOTICE) — the one
upstream reference kept by design. NovaClaw itself is proprietary and is not affiliated with or endorsed
by the opencode project.
