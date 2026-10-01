export function serialMinification() {
  return {
    name: "novaclaw:serial-minification",
    apply: "build",
    configResolved(config) {
      const plugin = config.plugins.find((item) => item.name === "vite:esbuild-transpile")
      const render = plugin?.renderChunk
      if (typeof render !== "function") throw new Error("Vite's chunk compiler has no serial minification boundary")
      let queued = Promise.resolve()
      let collected = false
      plugin.renderChunk = function (...args) {
        const pending = queued.then(() => {
          if (!collected) {
            globalThis.gc?.()
            collected = true
          }
          return render.apply(this, args)
        })
        queued = pending.then(
          () => {},
          () => {},
        )
        return pending
      }
    },
  }
}
