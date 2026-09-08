param(
  [Parameter(Mandatory = $true)][string]$Operation,
  [string]$Executable,
  [string]$Handle,
  [string]$Path,
  [string]$Region,
  [string]$X,
  [string]$Y,
  [string]$Button,
  [string]$TextBase64,
  [string]$Keys,
  [string]$Direction,
  [string]$Amount
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class NovaWindowsComputer {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT {
    public uint type;
    public InputUnion U;
  }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx, dy;
    public uint mouseData, dwFlags, time;
    public UIntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk, wScan;
    public uint dwFlags, time;
    public UIntPtr dwExtraInfo;
  }

  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScan(char value);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);

  const uint INPUT_MOUSE = 0;
  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;
  const uint KEYEVENTF_SCANCODE = 0x0008;
  const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  const uint MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
  const uint MOUSEEVENTF_WHEEL = 0x0800;
  const uint MOUSEEVENTF_HWHEEL = 0x01000;
  const int SW_RESTORE = 9;

  public sealed class WindowInfo {
    public string handle;
    public int processID;
    public string executable;
    public string title;
    public bool visible;
    public bool minimized;
    public bool foreground;
    public int x, y, width, height;
  }

  static string ExeOf(uint pid) {
    using (var process = Process.GetProcessById((int)pid)) {
      try { return System.IO.Path.GetFileName(process.MainModule.FileName); }
      catch { return process.ProcessName + ".exe"; }
    }
  }

  public static WindowInfo Inspect(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) throw new InvalidOperationException("window no longer exists");
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    RECT rect;
    if (!GetWindowRect(hwnd, out rect)) throw new InvalidOperationException("window rectangle is unreadable");
    var title = new StringBuilder(1024);
    GetWindowText(hwnd, title, title.Capacity);
    return new WindowInfo {
      handle = hwnd.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture), processID = checked((int)pid), executable = ExeOf(pid), title = title.ToString(),
      visible = IsWindowVisible(hwnd), minimized = IsIconic(hwnd), foreground = GetForegroundWindow() == hwnd,
      x = rect.Left, y = rect.Top, width = rect.Right - rect.Left, height = rect.Bottom - rect.Top
    };
  }

  public static WindowInfo[] Find(string executable) {
    var result = new List<WindowInfo>();
    EnumWindows((hwnd, ignored) => {
      try {
        var info = Inspect(hwnd);
        // Browser helper/IME surfaces can be visible top-level HWNDs owned by chrome.exe while
        // being only a titleless strip. They are not applications a person can select or an agent
        // can use. Bind only substantial, titled user surfaces.
        if (info.visible && info.width >= 320 && info.height >= 200 && !String.IsNullOrWhiteSpace(info.title) &&
            String.Equals(info.executable, executable, StringComparison.OrdinalIgnoreCase)) result.Add(info);
      } catch { }
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }

  public static WindowInfo Bind(string executable) {
    var found = Find(executable);
    if (found.Length == 0) throw new InvalidOperationException("no visible top-level window belongs to " + executable);
    WindowInfo selected = found.Length == 1 ? found[0] : null;
    if (selected == null) {
      var foregroundHandleString = GetForegroundWindow().ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture);
      foreach (var candidate in found) {
        if (candidate.handle != foregroundHandleString) continue;
        if (selected != null) throw new InvalidOperationException("foreground application resolved to more than one window");
        selected = candidate;
      }
    }
    if (selected == null) throw new InvalidOperationException("more than one visible top-level window belongs to " + executable + "; bring the intended one to the front and bind again");
    var hwnd = new IntPtr(Int64.Parse(selected.handle, System.Globalization.CultureInfo.InvariantCulture));
    if (selected.minimized) ShowWindow(hwnd, SW_RESTORE);
    uint targetPid;
    var targetThread = GetWindowThreadProcessId(hwnd, out targetPid);
    var currentThread = GetCurrentThreadId();
    var foreground = GetForegroundWindow();
    uint foregroundPid;
    var foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out foregroundPid);
    if (targetThread != currentThread) AttachThreadInput(currentThread, targetThread, true);
    if (foregroundThread != 0 && foregroundThread != targetThread) AttachThreadInput(foregroundThread, targetThread, true);
    try {
      BringWindowToTop(hwnd);
      SetForegroundWindow(hwnd);
      SetFocus(hwnd);
    } finally {
      if (foregroundThread != 0 && foregroundThread != targetThread) AttachThreadInput(foregroundThread, targetThread, false);
      if (targetThread != currentThread) AttachThreadInput(currentThread, targetThread, false);
    }
    Thread.Sleep(150);
    var bound = Inspect(hwnd);
    if (!bound.foreground) throw new InvalidOperationException("Windows did not foreground the approved application; bring it to the front and bind again");
    return bound;
  }

  public static WindowInfo RequireForeground(IntPtr hwnd) {
    var info = Inspect(hwnd);
    if (!info.visible) throw new InvalidOperationException("window is not visible");
    if (info.minimized) throw new InvalidOperationException("window is minimized");
    if (!info.foreground) throw new InvalidOperationException("approved window is not the foreground application");
    if (info.width < 1 || info.height < 1) throw new InvalidOperationException("window has no capturable area");
    return info;
  }

  static INPUT Mouse(uint flags, uint data) {
    return new INPUT { type = INPUT_MOUSE, U = new InputUnion { mi = new MOUSEINPUT { dwFlags = flags, mouseData = data } } };
  }
  static INPUT Key(ushort vk, ushort scan, uint flags) {
    return new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags } } };
  }
  static INPUT PhysicalKey(ushort vk, bool up) {
    var flags = KEYEVENTF_SCANCODE | (up ? KEYEVENTF_KEYUP : 0);
    if (vk == 0x21 || vk == 0x22 || vk == 0x23 || vk == 0x24 || vk == 0x25 || vk == 0x26 ||
        vk == 0x27 || vk == 0x28 || vk == 0x2D || vk == 0x2E) flags |= KEYEVENTF_EXTENDEDKEY;
    return Key(0, (ushort)MapVirtualKey(vk, 0), flags);
  }
  static void Send(params INPUT[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length)
      throw new InvalidOperationException("SendInput did not accept every event");
  }

  public static void Move(IntPtr hwnd, int x, int y) {
    var info = RequireForeground(hwnd);
    if (x < 0 || y < 0 || x >= info.width || y >= info.height) throw new ArgumentOutOfRangeException("point", "point lies outside the approved window");
    if (!SetCursorPos(info.x + x, info.y + y)) throw new InvalidOperationException("SetCursorPos failed");
  }

  public static void Click(IntPtr hwnd, string button, int count) {
    RequireForeground(hwnd);
    uint down, up;
    switch (button.ToLowerInvariant()) {
      case "left": down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; break;
      case "right": down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; break;
      case "middle": down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; break;
      default: throw new ArgumentException("unknown mouse button");
    }
    for (var i = 0; i < count; i++) { Send(Mouse(down, 0), Mouse(up, 0)); if (count > 1) Thread.Sleep(70); }
  }

  public static void Type(IntPtr hwnd, string text) {
    RequireForeground(hwnd);
    foreach (char value in text) {
      var mapped = VkKeyScan(value);
      if (mapped == -1) {
        Send(Key(0, value, KEYEVENTF_UNICODE), Key(0, value, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
      } else {
        var vk = (ushort)(mapped & 0xff);
        var modifiers = (mapped >> 8) & 0xff;
        if ((modifiers & 1) != 0) Send(Key(0x10, 0, 0));
        if ((modifiers & 2) != 0) Send(Key(0x11, 0, 0));
        if ((modifiers & 4) != 0) Send(Key(0x12, 0, 0));
        Send(Key(vk, 0, 0), Key(vk, 0, KEYEVENTF_KEYUP));
        if ((modifiers & 4) != 0) Send(Key(0x12, 0, KEYEVENTF_KEYUP));
        if ((modifiers & 2) != 0) Send(Key(0x11, 0, KEYEVENTF_KEYUP));
        if ((modifiers & 1) != 0) Send(Key(0x10, 0, KEYEVENTF_KEYUP));
      }
      Thread.Sleep(5);
    }
  }

  static ushort VirtualKey(string name) {
    var key = name.ToLowerInvariant();
    if (key.Length == 1 && key[0] >= 'a' && key[0] <= 'z') return (ushort)Char.ToUpperInvariant(key[0]);
    if (key.Length == 1 && key[0] >= '0' && key[0] <= '9') return (ushort)key[0];
    int fn;
    if (key.StartsWith("f") && Int32.TryParse(key.Substring(1), out fn) && fn >= 1 && fn <= 12) return (ushort)(0x70 + fn - 1);
    switch (key) {
      case "return": case "enter": return 0x0D; case "escape": case "esc": return 0x1B;
      case "tab": return 0x09; case "space": return 0x20; case "backspace": return 0x08;
      case "delete": return 0x2E; case "insert": return 0x2D; case "home": return 0x24; case "end": return 0x23;
      case "left": return 0x25; case "up": return 0x26; case "right": return 0x27; case "down": return 0x28;
      case "plus": case "add": return 0xBB; case "minus": case "subtract": return 0xBD;
      case "page_up": case "pageup": return 0x21; case "page_down": case "pagedown": return 0x22;
      default: throw new ArgumentException("unknown key: " + name);
    }
  }

  public static void KeyCombo(IntPtr hwnd, string spec) {
    RequireForeground(hwnd);
    var parts = spec.Split('+');
    var modifiers = new List<ushort>();
    for (var i = 0; i < parts.Length - 1; i++) {
      switch (parts[i].ToLowerInvariant()) {
        case "ctrl": case "control": modifiers.Add(0x11); break;
        case "alt": modifiers.Add(0x12); break;
        case "shift": modifiers.Add(0x10); break;
        case "win": case "meta": modifiers.Add(0x5B); break;
        default: throw new ArgumentException("unknown modifier: " + parts[i]);
      }
    }
    var key = VirtualKey(parts[parts.Length - 1]);
    foreach (var modifier in modifiers) Send(PhysicalKey(modifier, false));
    Send(PhysicalKey(key, false), PhysicalKey(key, true));
    for (var i = modifiers.Count - 1; i >= 0; i--) Send(PhysicalKey(modifiers[i], true));
  }

  public static void Scroll(IntPtr hwnd, string direction, int amount) {
    var info = RequireForeground(hwnd);
    POINT cursor;
    GetCursorPos(out cursor);
    if (cursor.X < info.x || cursor.Y < info.y || cursor.X >= info.x + info.width || cursor.Y >= info.y + info.height)
      SetCursorPos(info.x + info.width / 2, info.y + info.height / 2);
    var horizontal = direction == "left" || direction == "right";
    var sign = direction == "up" || direction == "right" ? 1 : -1;
    Send(Mouse(horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, unchecked((uint)(sign * amount * 120))));
  }
}
'@

[NovaWindowsComputer]::SetProcessDPIAware() | Out-Null

function To-Handle([string]$Value) {
  $parsed = [Int64]::Parse($Value, [Globalization.CultureInfo]::InvariantCulture)
  if ($parsed -le 0) { throw "window handle must be positive" }
  return [IntPtr]::new($parsed)
}

switch ($Operation) {
  "bind" {
    if ($Executable -notmatch '^[^\\/:*?"<>|]+\.exe$') { throw "executable must be a Windows .exe basename" }
    [NovaWindowsComputer]::Bind($Executable) | ConvertTo-Json -Compress
  }
  "inspect" { [NovaWindowsComputer]::Inspect((To-Handle $Handle)) | ConvertTo-Json -Compress }
  "screenshot" {
    $info = [NovaWindowsComputer]::RequireForeground((To-Handle $Handle))
    $rx = 0; $ry = 0; $rw = $info.width; $rh = $info.height
    if ($Region) {
      $values = $Region.Split(',')
      if ($values.Count -ne 4) { throw "region must contain four integers" }
      $rx, $ry, $rw, $rh = $values | ForEach-Object { [Int32]::Parse($_, [Globalization.CultureInfo]::InvariantCulture) }
      if ($rx -lt 0 -or $ry -lt 0 -or $rw -lt 1 -or $rh -lt 1 -or $rx + $rw -gt $info.width -or $ry + $rh -gt $info.height) { throw "region lies outside the approved window" }
    }
    $directory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))
    if ($directory) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
    $bitmap = [Drawing.Bitmap]::new($rw, $rh, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $graphics = [Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.CopyFromScreen($info.x + $rx, $info.y + $ry, 0, 0, [Drawing.Size]::new($rw, $rh), [Drawing.CopyPixelOperation]::SourceCopy)
        $cursor = [NovaWindowsComputer+POINT]::new()
        if ([NovaWindowsComputer]::GetCursorPos([ref]$cursor)) {
          $cx = $cursor.X - $info.x - $rx; $cy = $cursor.Y - $info.y - $ry
          if ($cx -ge 0 -and $cy -ge 0 -and $cx -lt $rw -and $cy -lt $rh) {
            $graphics.DrawEllipse([Drawing.Pens]::Red, $cx - 8, $cy - 8, 16, 16)
            $graphics.DrawLine([Drawing.Pens]::Red, $cx - 14, $cy, $cx + 14, $cy)
            $graphics.DrawLine([Drawing.Pens]::Red, $cx, $cy - 14, $cx, $cy + 14)
            $logicalX = [Math]::Round(($cx / $rw) * 1000); $logicalY = [Math]::Round(($cy / $rh) * 1000)
            $graphics.DrawString("($logicalX,$logicalY)", [Drawing.SystemFonts]::DefaultFont, [Drawing.Brushes]::Red, $cx + 10, $cy + 10)
          }
        }
      }
      finally { $graphics.Dispose() }
      $outWidth = $rw; $outHeight = $rh
      if ($rw -gt 1600 -or $rh -gt 1000) {
        $scale = [Math]::Min(1600.0 / $rw, 1000.0 / $rh)
        $outWidth = [Math]::Max(1, [Math]::Round($rw * $scale))
        $outHeight = [Math]::Max(1, [Math]::Round($rh * $scale))
        $scaled = [Drawing.Bitmap]::new($outWidth, $outHeight, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try {
          $scaledGraphics = [Drawing.Graphics]::FromImage($scaled)
          try {
            $scaledGraphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $scaledGraphics.DrawImage($bitmap, 0, 0, $outWidth, $outHeight)
          } finally { $scaledGraphics.Dispose() }
          $destination = [IO.Path]::GetFullPath($Path)
          if ([IO.Path]::GetExtension($destination) -match '^\.(jpg|jpeg)$') {
            $encoder = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg' | Select-Object -First 1
            $parameters = [Drawing.Imaging.EncoderParameters]::new(1)
            try {
              $parameters.Param[0] = [Drawing.Imaging.EncoderParameter]::new([Drawing.Imaging.Encoder]::Quality, [Int64]82)
              $scaled.Save($destination, $encoder, $parameters)
            } finally { $parameters.Dispose() }
          } else {
            $scaled.Save($destination, [Drawing.Imaging.ImageFormat]::Png)
          }
        } finally { $scaled.Dispose() }
      } else {
        $destination = [IO.Path]::GetFullPath($Path)
        if ([IO.Path]::GetExtension($destination) -match '^\.(jpg|jpeg)$') {
          $encoder = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg' | Select-Object -First 1
          $parameters = [Drawing.Imaging.EncoderParameters]::new(1)
          try {
            $parameters.Param[0] = [Drawing.Imaging.EncoderParameter]::new([Drawing.Imaging.Encoder]::Quality, [Int64]82)
            $bitmap.Save($destination, $encoder, $parameters)
          } finally { $parameters.Dispose() }
        } else {
          $bitmap.Save($destination, [Drawing.Imaging.ImageFormat]::Png)
        }
      }
    } finally { $bitmap.Dispose() }
    @{ width = $outWidth; height = $outHeight; path = [IO.Path]::GetFullPath($Path) } | ConvertTo-Json -Compress
  }
  "move" { [NovaWindowsComputer]::Move((To-Handle $Handle), [Int32]$X, [Int32]$Y) }
  "click" { [NovaWindowsComputer]::Click((To-Handle $Handle), $Button, 1) }
  "double_click" { [NovaWindowsComputer]::Click((To-Handle $Handle), "left", 2) }
  "type" { [NovaWindowsComputer]::Type((To-Handle $Handle), [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TextBase64))) }
  "type_submit" {
    [NovaWindowsComputer]::Type((To-Handle $Handle), [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TextBase64)))
    [NovaWindowsComputer]::KeyCombo((To-Handle $Handle), "Return")
  }
  "key" { [NovaWindowsComputer]::KeyCombo((To-Handle $Handle), $Keys) }
  "copy_text" {
    $hwnd = To-Handle $Handle
    [NovaWindowsComputer]::KeyCombo($hwnd, "ctrl+a")
    Start-Sleep -Milliseconds 100
    # Clear only after the foreground check/select operation. If Ctrl+C is ignored, an empty result
    # fails closed instead of accidentally returning clipboard text from before this approved action.
    [Windows.Forms.Clipboard]::Clear()
    [NovaWindowsComputer]::KeyCombo($hwnd, "ctrl+c")
    Start-Sleep -Milliseconds 250
    $copied = [Windows.Forms.Clipboard]::GetText()
    if ([string]::IsNullOrWhiteSpace($copied)) { throw "approved application copied no text" }
    if ($copied.Length -gt 100000) { $copied = $copied.Substring(0, 100000) + "`n[copy_text truncated at 100000 characters]" }
    $copied
  }
  "scroll" { [NovaWindowsComputer]::Scroll((To-Handle $Handle), $Direction, [Int32]$Amount) }
  "cursor" {
    $info = [NovaWindowsComputer]::RequireForeground((To-Handle $Handle))
    $point = [NovaWindowsComputer+POINT]::new()
    if (-not [NovaWindowsComputer]::GetCursorPos([ref]$point)) { throw "GetCursorPos failed" }
    if ($point.X -lt $info.x -or $point.Y -lt $info.y -or
        $point.X -ge $info.x + $info.width -or $point.Y -ge $info.y + $info.height) {
      throw "cursor lies outside the approved window"
    }
    @{ x = $point.X - $info.x; y = $point.Y - $info.y } | ConvertTo-Json -Compress
  }
  default { throw "unknown operation: $Operation" }
}
