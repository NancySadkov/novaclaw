import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")
const source = path.join(root, "packages/core/src/tool")

test("deferred registrations are generated from current implementation metadata and dependencies", async () => {
  const child = Bun.spawn([process.execPath, "packages/core/script/deferred-builtins.ts", "--check"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  expect(stdout).toContain("registrations verified")
}, 35_000)

test("a fresh worker graph evaluates no deferred implementation and includes resident tools and policies", async () => {
  const deferred = []
  for (const file of await fs.readdir(source)) {
    if (file.endsWith(".ts") && (await fs.readFile(path.join(source, file), "utf8")).includes("Tool.withDeferred("))
      deferred.push(file)
  }
  expect(deferred.length).toBeGreaterThan(0)
  // A separate process is essential: other tool tests import implementations intentionally.
  // Probe the real worker root so an indirect import through a resident service is caught too.
  const code = `
    const { SessionWorkerRunnerLayer } = await import("./packages/novaclaw/src/session-worker/runner-layer.ts");
    const deferred = new Set(${JSON.stringify(deferred)});
    const evaluated = Object.keys(require.cache).map(p => p.replaceAll("\\\\", "/")).filter(p => p.includes("/core/src/tool/") && deferred.has(p.split("/").at(-1)));
    const names = new Set();
    function walk(node) { if (names.has(node.name)) return; names.add(node.name); for (const dep of node.dependencies) walk(dep); }
    walk(SessionWorkerRunnerLayer.root);
    process.stdout.write(JSON.stringify({ evaluated, names: [...names] }));
  `
  const child = Bun.spawn([process.execPath, "-e", code], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
  const result = JSON.parse(stdout)
  expect(result.evaluated).toEqual([])
  expect(result.names).toContain("tool-policy/builtin")
  expect(result.names).toContain("tool/read")
  expect(result.names).toContain("tool/tool-search")
}, 35_000)
