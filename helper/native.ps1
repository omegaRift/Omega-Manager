# Screen Autopilot input helper. Runs hidden for the life of the app.
# Protocol: one base64(UTF-8 JSON) request per stdin line, one base64(UTF-8 JSON) reply per stdout line.
# With AP_DRY_INPUT=1 it never moves the mouse or presses keys: input commands only report what they would do.
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class ApNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }

  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr h, int idx);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, int flags, StringBuilder sb, ref int size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr h, ref int len, StringBuilder sb);

  // Program file and (for Store/packaged apps) the app id of a process, for opening it again. Read-only.
  public static string[] ProcInfo(int pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);          // PROCESS_QUERY_LIMITED_INFORMATION
    if (h == IntPtr.Zero) return new string[] { "", "" };
    try {
      var sb = new StringBuilder(1024); int size = sb.Capacity;
      string path = QueryFullProcessImageNameW(h, 0, sb, ref size) ? sb.ToString() : "";
      string aumid = "";
      try { var id = new StringBuilder(512); int len = id.Capacity; if (GetApplicationUserModelId(h, ref len, id) == 0) aumid = id.ToString(); } catch { }
      return new string[] { path, aumid };
    } finally { CloseHandle(h); }
  }

  public static bool Dry = false;
  public static List<string> Log = new List<string>();
  static int[] dryCursor = null;     // where the pointer would be, so the safety stop works in dry runs

  public static void DpiAware() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } }
  public static int InputSize() { return Marshal.SizeOf(typeof(INPUT)); }

  // Visible frame of a window in physical pixels (without the invisible resize border).
  public static int[] Rect(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (!IsWindow(h)) return null;
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
    return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
  }

  public static List<object[]> Windows() {
    var list = new List<object[]>();
    IntPtr shell = IntPtr.Zero;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLengthW(h);
      if (len == 0) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true;                 // owned popups
      if ((GetWindowLongW(h, -20) & 0x80) != 0) return true;           // tool windows
      int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      var sb = new StringBuilder(len + 1); GetWindowTextW(h, sb, sb.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      list.Add(new object[] { h.ToInt64(), sb.ToString(), (int)pid, Rect(h.ToInt64()), IsIconic(h) });
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static int[] Cursor() { if (Dry && dryCursor != null) return dryCursor; POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }

  public static bool Focus(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (!IsWindow(h)) return false;
    if (GetForegroundWindow() == h) return true;
    if (Dry) { Log.Add("focus " + hwnd); return true; }
    if (IsIconic(h)) ShowWindow(h, 9);
    uint pid; uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint me = GetCurrentThreadId();
    bool attached = fg != me && AttachThreadInput(me, fg, true);
    BringWindowToTop(h); SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, fg, false);
    Thread.Sleep(120);
    return GetForegroundWindow() == h;
  }

  static INPUT Mouse(uint flags, uint data) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; return i; }
  static INPUT Key(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  static void Send(params INPUT[] a) { SendInput((uint)a.Length, a, InputSize()); }

  public static void Move(int x, int y) {
    if (Dry) { Log.Add("move " + x + "," + y); dryCursor = new int[] { x, y }; return; }
    SetCursorPos(x, y);
  }

  public static void Click(int x, int y, string button, int count) {
    uint down = 0x2, up = 0x4;
    if (button == "right") { down = 0x8; up = 0x10; }
    else if (button == "middle") { down = 0x20; up = 0x40; }
    if (Dry) { Log.Add(button + " click x" + count + " at " + x + "," + y); dryCursor = new int[] { x, y }; return; }
    SetCursorPos(x, y); Thread.Sleep(30);
    for (int n = 0; n < count; n++) { Send(Mouse(down, 0)); Thread.Sleep(20); Send(Mouse(up, 0)); if (n + 1 < count) Thread.Sleep(60); }
  }

  public static void Scroll(int x, int y, int clicks, bool horizontal) {
    if (Dry) { Log.Add("scroll " + (horizontal ? "h " : "v ") + clicks + " at " + x + "," + y); dryCursor = new int[] { x, y }; return; }
    SetCursorPos(x, y); Thread.Sleep(30);
    int step = clicks > 0 ? 1 : -1;
    for (int n = 0; n != clicks; n += step) { Send(Mouse(horizontal ? 0x1000u : 0x800u, (uint)(120 * step))); Thread.Sleep(25); }
  }

  public static void Type(string text, int delayMs) {
    if (Dry) { Log.Add("type " + text); return; }
    foreach (char c in text) {
      if (c == '\r') continue;
      if (c == '\n') { Send(Key(0x0D, 0, 0), Key(0x0D, 0, 2)); }
      else if (c == '\t') { Send(Key(0x09, 0, 0), Key(0x09, 0, 2)); }
      else { Send(Key(0, c, 4), Key(0, c, 4 | 2)); }
      if (delayMs > 0) Thread.Sleep(delayMs);
    }
  }

  static bool Extended(int vk) { return (vk >= 0x21 && vk <= 0x2E) || vk == 0x5B || vk == 0x5C || vk == 0x6F || vk == 0x90; }

  // Presses the keys in order, then lets them go in reverse (a shortcut like Ctrl+Shift+S).
  public static void Keys(int[] vks) {
    if (Dry) { Log.Add("keys " + string.Join("+", vks)); return; }
    var a = new List<INPUT>();
    foreach (int vk in vks) a.Add(Key((ushort)vk, 0, Extended(vk) ? 1u : 0u));
    for (int i = vks.Length - 1; i >= 0; i--) a.Add(Key((ushort)vks[i], 0, (Extended(vks[i]) ? 1u : 0u) | 2u));
    foreach (var i in a) { Send(i); Thread.Sleep(15); }
  }
}
'@

[ApNative]::DpiAware()
[ApNative]::Dry = ($env:AP_DRY_INPUT -eq '1')
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Reply($obj) {
  $json = ConvertTo-Json -InputObject $obj -Compress -Depth 6
  [Console]::Out.WriteLine([Convert]::ToBase64String($utf8.GetBytes($json)))
  [Console]::Out.Flush()
}

$names = @{}
function ProcName($procId) {
  if (-not $names.ContainsKey($procId)) {
    try { $names[$procId] = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { $names[$procId] = '' }
  }
  $names[$procId]
}

Reply @{ id = 0; ok = $true; result = @{ ready = $true; dry = [ApNative]::Dry; inputSize = [ApNative]::InputSize() } }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $id = 0
  try {
    $req = $utf8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
    $id = $req.id
    [ApNative]::Log.Clear()
    $result = $null
    switch ($req.cmd) {
      'windows' {
        $result = @([ApNative]::Windows() | ForEach-Object {
          @{ hwnd = $_[0]; title = $_[1]; pid = $_[2]; process = (ProcName $_[2]); rect = $_[3]; minimized = $_[4] }
        })
      }
      'rect'   { $result = [ApNative]::Rect([long]$req.hwnd) }
      'cursor' { $result = [ApNative]::Cursor() }
      'focus'  { $result = [ApNative]::Focus([long]$req.hwnd) }
      'move'   { [ApNative]::Move([int]$req.x, [int]$req.y) }
      'click'  { [ApNative]::Click([int]$req.x, [int]$req.y, [string]$req.button, [int]$req.count) }
      'scroll' { [ApNative]::Scroll([int]$req.x, [int]$req.y, [int]$req.clicks, [bool]$req.horizontal) }
      'type'   { [ApNative]::Type($utf8.GetString([Convert]::FromBase64String($req.text64)), [int]$req.delay) }
      'keys'   { [ApNative]::Keys([int[]]@($req.vks)) }
      'procinfo' {
        $info = [ApNative]::ProcInfo([int]$req.pid)
        $cl = $null
        try { $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$req.pid)" -ErrorAction Stop).CommandLine } catch { }
        $result = @{ path = $info[0]; aumid = $info[1]; commandLine = [string]$cl }
      }
      'ping'   { $result = 'pong' }
      default  { throw "unknown command $($req.cmd)" }
    }
    Reply @{ id = $id; ok = $true; result = $result; dry = @([ApNative]::Log) }
  } catch {
    Reply @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
}
