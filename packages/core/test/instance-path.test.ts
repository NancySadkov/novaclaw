import { expect, test } from "bun:test"
import { mapValues, preserveProjectDirectory, resolve, store } from "@novaclaw/core/database/instance-path"

const source = {
  data: "C:/Users/A/Nova/data",
  cache: "C:/Users/A/Nova/cache",
  config: "C:/Users/A/Nova/config",
  state: "C:/Users/A/Nova/state",
  tmp: "C:/Users/A/Nova/data/tmp",
}
const target = {
  data: "/home/b/nova/data",
  cache: "/home/b/nova/cache",
  config: "/home/b/nova/config",
  state: "/home/b/nova/state",
  tmp: "/home/b/nova/data/tmp",
}

test("instance owned paths survive a Windows to Unix home move", () => {
  const stored = store("C:/Users/A/Nova/data/scratch/officer", source)
  expect(stored).toBe("novaclaw-home:/data/scratch/officer")
  expect(resolve(stored, target).replaceAll("\\", "/")).toBe("/home/b/nova/data/scratch/officer")
  expect(store("C:/Work/project", source)).toBe("C:/Work/project")
})

test("config path conversion preserves assigned project directories", () => {
  const config = [{ directory: "C:/Users/A/Nova/data/project", permissions: [{ resource: "C:/Users/A/Nova/data/tool-output/*" }] },
    { directory: "C:/Users/A/Nova/data/scratch/officer" }]
  expect(mapValues(config, (value) => store(value, source), preserveProjectDirectory)).toEqual([
    { directory: "C:/Users/A/Nova/data/project", permissions: [{ resource: "novaclaw-home:/data/tool-output/*" }] },
    { directory: "novaclaw-home:/data/scratch/officer" },
  ])
  expect(mapValues([{ directory: "novaclaw-home:/data/scratch/officer" }], (value) => resolve(value, target).replaceAll("\\", "/"))).toEqual([
    { directory: "/home/b/nova/data/scratch/officer" },
  ])
})

test("stored path cannot escape its instance root", () => {
  expect(() => resolve("novaclaw-home:/data/../outside", target)).toThrow("Invalid instance path")
  expect(() => resolve("novaclaw-home:/data/..\\outside", target)).toThrow("Invalid instance path")
})

test("old internal paths rebase after moving the home", () => {
  expect(resolve("C:/Users/A/.local/share/novaclaw/data/scratch/officer", target).replaceAll("\\", "/")).toBe("/home/b/nova/data/scratch/officer")
  expect(store("C:/Users/A/AppData/Local/Temp/novaclaw/output.txt", source)).toBe("novaclaw-home:/tmp/output.txt")
  expect(resolve("C:/Work/project", target)).toBe("C:/Work/project")
  expect(resolve("C:/Work/data/scratch/project", target)).toBe("C:/Work/data/scratch/project")
  expect(resolve("C:/Work/novaclaw/data/scratch/project", target)).toBe("C:/Work/novaclaw/data/scratch/project")
})
