# novaclaw

The instance runtime: the HTTP server an instance exposes, the session worker, the permission
evaluator, the storage layer, and the headless CLI (`nova-cli`). Everything the desktop app and the
web UI talk to lives here; the UI itself is `@novaclaw/app` and the agent kernel is `@novaclaw/core`.

This package is `private` and is not published. It is built and run from the repo:

```bash
bun install            # from the repo root
bun --cwd packages/novaclaw run dev        # start an instance
bun --cwd packages/novaclaw run typecheck
bun --cwd packages/novaclaw run test
```

The CLI is deliberately **headless only** — launch an instance, check health, run tests, poke a
session with a message. There is no interactive terminal UI; the HTML UI is the product.

Build and test tiers for the whole repo: `bun run test` from the root.
