param([switch]$Once)
# Read-only Win32 discovery. No DLL injection, keyboard emulation, or orders.
# One persistent PowerShell process avoids repeatedly starting Windows PowerShell.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public sealed class WindowSnapshot {
  public string id { get; set; }
  public int pid { get; set; }
  public string exe { get; set; }
  public string title { get; set; }
  public int left { get; set; }
  public int top { get; set; }
  public int width { get; set; }
  public int height { get; set; }
  public bool minimized { get; set; }
}
public static class H00kWindowAgent {
  private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lparam);
  [StructLayout(LayoutKind.Sequential)] private struct RECT {
    public int Left, Top, Right, Bottom;
  }
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern int GetWindowTextLengthW(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT bounds, int size);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  public static void EnablePhysicalDpi() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { /* older Windows */ }
  }
  public static List<WindowSnapshot> Snapshot() {
    var windows = new List<WindowSnapshot>();
    EnumWindows((hwnd, _) => {
      try {
        if (!IsWindowVisible(hwnd) || GetWindow(hwnd, 4) != IntPtr.Zero) return true;
        var len = GetWindowTextLengthW(hwnd);
        if (len < 2 || len > 512) return true;
        var title = new StringBuilder(len + 1);
        GetWindowTextW(hwnd, title, title.Capacity);
        RECT bounds;
        if (!GetWindowRect(hwnd, out bounds)) return true;
        // GetWindowRect may include invisible Windows resize borders (visible as a black seam).
        // DWM's extended-frame bounds represent the actual visible target boundary.
        RECT visible;
        try {
          if (DwmGetWindowAttribute(hwnd, 9, out visible, Marshal.SizeOf(typeof(RECT))) == 0
            && visible.Right > visible.Left && visible.Bottom > visible.Top)
            bounds = visible;
        } catch { /* older Windows or DWM unavailable: use GetWindowRect */ }
        if (bounds.Right - bounds.Left < 140 || bounds.Bottom - bounds.Top < 80) return true;
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        if (pid == 0 || pid == Process.GetCurrentProcess().Id) return true;
        // Protected/elevated processes can deny name lookup. Keep the visible
        // window available in the manual picker instead of silently dropping it.
        string processName;
        try { processName = Process.GetProcessById((int)pid).ProcessName; }
        catch { processName = "Unknown"; }
        windows.Add(new WindowSnapshot {
          id = hwnd.ToInt64().ToString(),
          pid = (int)pid, exe = processName, title = title.ToString(),
          left = bounds.Left, top = bounds.Top,
          width = bounds.Right - bounds.Left, height = bounds.Bottom - bounds.Top,
          minimized = IsIconic(hwnd)
        });
      } catch { /* windows may close during enumeration; protected processes may deny details */ }
      return true;
    }, IntPtr.Zero);
    return windows;
  }
}
'@
[H00kWindowAgent]::EnablePhysicalDpi()
while ($true) {
  try {
    $current = @([H00kWindowAgent]::Snapshot())
    $json = ConvertTo-Json -InputObject $current -Depth 4 -Compress
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
  } catch {
    [Console]::Out.WriteLine('[]')
    [Console]::Out.Flush()
  }
  if ($Once) { break }
  Start-Sleep -Milliseconds 160
}
