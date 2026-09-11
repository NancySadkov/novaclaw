import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()

const originalGetContext = HTMLCanvasElement.prototype.getContext
// @ts-expect-error - we're overriding with a simplified mock
HTMLCanvasElement.prototype.getContext = function (contextType: string, _options?: unknown) {
  if (contextType === "2d") {
    return {
      canvas: this,
      fillStyle: "#000000",
      strokeStyle: "#000000",
      font: "12px monospace",
      textAlign: "start",
      textBaseline: "alphabetic",
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      imageSmoothingEnabled: true,
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      miterLimit: 10,
      shadowBlur: 0,
      shadowColor: "rgba(0, 0, 0, 0)",
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      fillRect: () => {},
      strokeRect: () => {},
      clearRect: () => {},
      fillText: () => {},
      strokeText: () => {},
      measureText: (text: string) => ({ width: text.length * 8 }),
      drawImage: () => {},
      save: () => {},
      restore: () => {},
      scale: () => {},
      rotate: () => {},
      translate: () => {},
      transform: () => {},
      setTransform: () => {},
      resetTransform: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      createPattern: () => null,
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      bezierCurveTo: () => {},
      quadraticCurveTo: () => {},
      arc: () => {},
      arcTo: () => {},
      ellipse: () => {},
      rect: () => {},
      fill: () => {},
      stroke: () => {},
      clip: () => {},
      isPointInPath: () => false,
      isPointInStroke: () => false,
      getTransform: () => ({}),
      getImageData: () => ({
        data: new Uint8ClampedArray(0),
        width: 0,
        height: 0,
      }),
      putImageData: () => {},
      createImageData: () => ({
        data: new Uint8ClampedArray(0),
        width: 0,
        height: 0,
      }),
    } as unknown as CanvasRenderingContext2D
  }
  return originalGetContext.call(this, contextType as "2d", _options)
}

/**
 * Print an element as ONE SHORT LINE, never as its object graph.
 *
 * 🔴 Measured 2026-09-11 on the failure path of `expect(saveButton()).toBeUndefined()` in
 * `test-browser/agent-config-dialog-render.test.tsx`. bun's assertion printer walks the received
 * value's properties, and a happy-dom element reaches its `ownerDocument` and every sibling, so the
 * rendering grows roughly ×4 per nesting level: 9.9 KB at depth 0, 92 KB at 1, 1.4 MB at 2, 12 MB at
 * 3, 53 MB at 4 — and the printer does not stop at 4. The run allocated **11.38 GB** of commit
 * charge, starved the event loop until no timer could fire (a 1 s `setInterval` printed nothing in
 * 20 s of wall clock), and died 407 s later in `panic(main thread): attempt to unwrap error:
 * WriteFailed`.
 *
 * ⚠️ **What that does to the SUITE, which is why it lives here and not in one test.** A DOM
 * assertion that fails cannot report red: it takes the runtime down instead. `app:browser` came back
 * twice as a crash while the actual defect was one sentence long ("Nova's dialog gained a Save
 * button"), and roughly twenty `expect(<element>).toBeNull()` sites across this directory are the
 * same landmine with a different fuse — every genuine regression at one of them is indistinguishable
 * from a broken machine. With the hook the same failing assertion prints
 * `Received: <button.ml-auto.rounded-md…>` and finishes in 62 ms.
 *
 * Cost when the assertion passes: zero, because nothing walks the graph in the first place.
 */
const describeNodeForFailure = (node: any): string => {
  const tag = typeof node?.tagName === "string" ? String(node.tagName).toLowerCase() : "node"
  const id = typeof node?.id === "string" && node.id ? `#${node.id}` : ""
  const className = typeof node?.className === "string" ? node.className.trim() : ""
  const classes = className ? "." + className.split(/\s+/).slice(0, 2).join(".") : ""
  // The two attributes this repo's own selectors key on, so a red names the CONTROL and not just
  // the tag: `data-slot` and `data-action` are how these tests find things in the first place.
  const where = ["data-slot", "data-action", "role", "type"]
    .map((attribute) => {
      const value = typeof node?.getAttribute === "function" ? node.getAttribute(attribute) : null
      return value === null ? "" : ` ${attribute}="${value}"`
    })
    .join("")
    .trim()
  const text = typeof node?.textContent === "string" ? node.textContent.replace(/\s+/g, " ").trim() : ""
  const snippet = text.length > 40 ? `${text.slice(0, 40)}…` : text
  return `<${tag}${id}${classes}${where ? ` ${where}` : ""}${snippet ? ` "${snippet}"` : ""}>`
}

const inspectHook = Symbol.for("nodejs.util.inspect.custom")
for (const ctor of [globalThis.Node, globalThis.Element] as const) {
  if (ctor?.prototype) {
    Object.defineProperty(ctor.prototype, inspectHook, {
      value: function (this: unknown) {
        return describeNodeForFailure(this)
      },
      configurable: true,
      writable: true,
    })
  }
}
