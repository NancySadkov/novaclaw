import { expect, test } from "@playwright/test"

test("narrow settings controls stay inside their rows", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 })
  await page.goto("/")
  await page.evaluate(async () => {
    const fixture = await import(/* @vite-ignore */ "/e2e/fixtures/settings-control-width.tsx")
    fixture.mount()
  })

  for (const name of ["preset", "profile-input", "profile-select"]) {
    const result = await page.locator(`#${name}`).evaluate((row) => {
      const bounds = row.getBoundingClientRect()
      const controls = [...row.querySelectorAll('[data-component="text-input-v2"], [data-component="select-v2"]')]
      return {
        scrolls: row.scrollWidth > row.clientWidth,
        outside: controls.some((control) => {
          const box = control.getBoundingClientRect()
          return box.left < bounds.left - 1 || box.right > bounds.right + 1
        }),
      }
    })
    expect(result, name).toEqual({ scrolls: false, outside: false })
  }
})
