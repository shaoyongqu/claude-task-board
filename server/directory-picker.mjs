// Opens the operating system's native directory picker and resolves to the
// chosen absolute path. Windows uses the WinForms FolderBrowserDialog via a
// short PowerShell host; Linux falls back to zenity/kdialog when present.
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const PICKER_TIMEOUT_MS = 10 * 60_000;

function runPicker(command, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ ok: false, reason: "spawn-failed" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ ok: false, reason: "timeout" });
    }, PICKER_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: error.code === "ENOENT" ? "unavailable" : "spawn-failed" });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: true, code, stdout, stderr });
    });
  });
}

// Win32 helper injected into the PowerShell picker. Foreground activation is
// denied to windows created by the hidden background server process, so the
// dialog can end up behind the foreground browser no matter what owner form
// hosts it. The picker timer grabs the dialog's own HWND while the modal
// message loop is pumping and forces HWND_TOPMOST directly on it.
const WINDOWS_CS = `using System;
using System.Runtime.InteropServices;
public class PickerTopmost {
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  public static void Force(IntPtr hWnd) {
    // HWND_TOPMOST with SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW
    SetWindowPos(hWnd, new IntPtr(-1), 0, 0, 0, 0, 0x43);
    SetForegroundWindow(hWnd);
  }
  public static IntPtr FindDialog(uint pid) {
    IntPtr best = IntPtr.Zero; int bestArea = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint wpid; GetWindowThreadProcessId(h, out wpid);
      if (wpid == pid && IsWindowVisible(h)) {
        RECT r; GetWindowRect(h, out r);
        int area = (r.Right - r.Left) * (r.Bottom - r.Top);
        if (area > bestArea) { bestArea = area; best = h; }
      }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}`;

const WINDOWS_PS = [
  "Add-Type -AssemblyName System.Windows.Forms | Out-Null;",
  `$src = @'\n${WINDOWS_CS}\n'@;`,
  "Add-Type -TypeDefinition $src | Out-Null;",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;",
  "$dialog.Description = '选择项目工作目录 / Choose a project workspace';",
  "$dialog.ShowNewFolderButton = $true;",
  "$owner = New-Object System.Windows.Forms.Form;",
  "$owner.TopMost = $true;",
  "$owner.ShowInTaskbar = $false;",
  "$owner.StartPosition = 'Manual';",
  "$owner.Size = New-Object System.Drawing.Size(1,1);",
  "$owner.Location = New-Object System.Drawing.Point(0,0);",
  "$owner.Show();",
  "$owner.Activate();",
  "$timer = New-Object System.Windows.Forms.Timer;",
  "$timer.Interval = 100;",
  "$timer.Add_Tick({",
  "  $h = [PickerTopmost]::FindDialog($PID);",
  "  if ($h -ne [IntPtr]::Zero) {",
  "    [PickerTopmost]::Force($h);",
  "    $timer.Stop();",
  "  }",
  "});",
  "$timer.Start();",
  "$result = $dialog.ShowDialog($owner);",
  "$timer.Stop();",
  "$owner.Close(); $owner.Dispose();",
  "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
].join("\n");

export async function pickNativeDirectory() {
  if (process.platform === "win32") {
    const result = await runPicker("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_PS,
    ]);
    if (!result.ok) return { available: false, reason: result.reason };
    const picked = result.stdout.trim();
    if (result.code === 0 && picked) return { available: true, path: picked };
    return { available: true, canceled: true };
  }
  for (const [command, args] of [
    ["zenity", ["--file-selection", "--directory", "--title", "选择项目工作目录"]],
    ["kdialog", ["--getexistingdirectory", path.join(os.homedir()), "--title", "选择项目工作目录"]],
  ]) {
    const result = await runPicker(command, args);
    if (!result.ok || result.reason === "unavailable") continue;
    const picked = result.stdout.trim();
    if (result.code === 0 && picked) return { available: true, path: picked };
    return { available: true, canceled: true };
  }
  return { available: false, reason: "unavailable" };
}
