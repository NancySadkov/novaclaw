import { describe, expect, test } from "bun:test"
import { desktopExecutableName, desktopHelp, desktopOptionError, parseDesktopInvocation } from "./desktop-cli"

describe("desktop command line", () => {
  test.each(["-h", "--help"])("%s selects help without launching", (flag) => {
    expect(parseDesktopInvocation(["C:\\NovaClaw.exe", flag])).toEqual({ action: "help" })
  })

  test("documents every NovaClaw desktop argument in GCC style", () => {
    expect(desktopHelp()).toBe(`Usage: NovaClaw.exe [OPTION]... [novaclaw://URL]
Launch the NovaClaw desktop app.

Options:
  --home=DIR    Store this instance's config, data, state, and cache in DIR.
  -h, --help    Display this help and exit.

Arguments:
  novaclaw://URL  Open a NovaClaw link in the selected instance.
`)
  })

  test("retires Chromium's old user-data spelling with the replacement in the error", () => {
    const parsed = parseDesktopInvocation(["C:\\NovaClaw.exe", "--user-data-dir=D:\\old"])
    expect(parsed).toEqual({ action: "error", message: "option '--user-data-dir' has been renamed to '--home'" })
    expect(desktopOptionError("NovaClaw.exe", parsed.action === "error" ? parsed.message : "")).toBe(
      "NovaClaw.exe: option '--user-data-dir' has been renamed to '--home'\n" +
        "Try 'NovaClaw.exe --help' for more information.\n",
    )
  })

  test("a missing home value is an ordinary command-line error", () => {
    for (const argv of [
      ["NovaClaw.exe", "--home"],
      ["NovaClaw.exe", "--home="],
      ["NovaClaw.exe", "--home", "--no-sandbox"],
    ])
      expect(parseDesktopInvocation(argv)).toEqual({
        action: "error",
        message: "option '--home' requires a directory",
      })
  })

  test("ordinary launches, homes, Chromium switches and deep links continue to launch", () => {
    expect(
      parseDesktopInvocation([
        "C:\\NovaClaw.exe",
        "--home=D:\\instances\\one",
        "--remote-debugging-port=9222",
        "novaclaw://session/ses_1",
      ]),
    ).toEqual({ action: "launch" })
  })

  test("uses the real executable basename in diagnostics", () => {
    expect(desktopExecutableName("C:\\Apps\\NovaClaw.exe")).toBe("NovaClaw.exe")
  })
})
