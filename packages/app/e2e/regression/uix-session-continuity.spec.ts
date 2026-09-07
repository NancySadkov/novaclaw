import { expect, test } from "@playwright/test"

test("keeps the real timeline pin through layout changes until the user scrolls", async ({ page }) => {
  await page.goto("/")
  await page.setContent(`
    <style>
      #timeline { height: 240px; width: 500px; overflow-y: auto; }
      .row { height: 90px; }
    </style>
    <div id="timeline" tabindex="0"><div id="content">
      ${Array.from({ length: 12 }, (_, index) => `<div class="row">row ${index}</div>`).join("")}
      <details id="working" open><summary>Working</summary><div style="height:600px">live work</div></details>
    </div></div>
  `)

  await page.evaluate(async () => {
    const { createBottomPinController } = await import("/src/pages/session/timeline/native-scroll.ts")
    const scroller = document.getElementById("timeline")!
    const content = document.getElementById("content")!
    let pinned = true
    const controller = createBottomPinController({
      scroller,
      content,
      pinned: () => pinned,
      setPinned: (value: boolean) => (pinned = value),
    })
    Object.assign(window, { uixPin: { controller, pinned: () => pinned } })
  })

  const gap = () =>
    page.locator("#timeline").evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)
  await expect.poll(gap).toBeLessThanOrEqual(2)

  // A scrollbar gesture explicitly releases the pin before its scroll event. Geometry alone cannot
  // do that job because Chromium emits identical, delayed events for route/reconcile layout clamps.
  await page.waitForTimeout(1_100)
  await page.locator("#timeline").evaluate((timeline) => {
    timeline.scrollTop -= 20
  })
  await expect.poll(gap).toBeGreaterThan(10)
  await expect
    .poll(() => page.evaluate(() => (window as never as { uixPin: { pinned: () => boolean } }).uixPin.pinned()))
    .toBe(false)

  // Returning to the bottom through the scrollbar geometry restores follow mode.
  await page.locator("#timeline").evaluate((timeline) => (timeline.scrollTop = timeline.scrollHeight))
  await expect.poll(gap).toBeLessThanOrEqual(2)
  await expect
    .poll(() => page.evaluate(() => (window as never as { uixPin: { pinned: () => boolean } }).uixPin.pinned()))
    .toBe(true)
  // The clamp's scroll notification may arrive well after Mutation/Resize observers have settled.
  // It still describes layout, not new user intent, and must not revoke the pin.
  await page.waitForTimeout(100)
  await page.locator("#timeline").evaluate((timeline) => timeline.dispatchEvent(new Event("scroll")))
  await expect
    .poll(() => page.evaluate(() => (window as never as { uixPin: { pinned: () => boolean } }).uixPin.pinned()))
    .toBe(true)

  // A remount/reconcile can insert or expand rows above the viewport. ResizeObserver must restick.
  await page.locator("#content").evaluate((content) => {
    const growth = document.createElement("div")
    growth.style.height = "900px"
    content.prepend(growth)
  })
  await expect.poll(gap).toBeLessThanOrEqual(2)

  // Folding the live Working region changes geometry without expressing user navigation.
  await page.locator("#working").evaluate((details: HTMLDetailsElement) => (details.open = false))
  await expect.poll(gap).toBeLessThanOrEqual(2)

  // Replacing one chat with another can briefly collapse the transcript while its rows reconcile.
  // Chromium clamps scrollTop to the new maximum and emits the same upward `scroll` event as a
  // scrollbar gesture. That browser-owned movement must keep follow mode so the restored transcript
  // returns to its latest row instead of stranding the reader at the first message.
  await page.locator("#content").evaluate((content) => {
    content.replaceChildren()
    const timeline = content.parentElement!
    timeline.scrollTop = 0
    // Exercise the ordering observed during a chat swap: the clamp's scroll notification can run
    // before ResizeObserver gets its turn to restick the changed content box.
    timeline.dispatchEvent(new Event("scroll"))
  })
  await expect
    .poll(() => page.evaluate(() => (window as never as { uixPin: { pinned: () => boolean } }).uixPin.pinned()))
    .toBe(true)
  await page.locator("#content").evaluate((content) => {
    content.innerHTML = Array.from({ length: 12 }, (_, index) => `<div class="row">new chat ${index}</div>`).join("")
  })
  await expect.poll(gap).toBeLessThanOrEqual(2)

  // A single ordinary wheel tick must release follow mode even though it remains inside the
  // near-bottom re-pin threshold. The old controller unpinned on `wheel`, then immediately re-pinned
  // on this `scroll` event because its 20px gap was less than 80px.
  await page.locator("#timeline").hover()
  await page.mouse.wheel(0, -20)
  await expect.poll(gap).toBeGreaterThan(10)
  await expect
    .poll(() => page.evaluate(() => (window as never as { uixPin: { pinned: () => boolean } }).uixPin.pinned()))
    .toBe(false)
  await page.evaluate(() =>
    (window as never as { uixPin: { controller: { scrollToBottom: () => void } } }).uixPin.controller.scrollToBottom(),
  )
  await expect.poll(gap).toBeLessThanOrEqual(2)
})
