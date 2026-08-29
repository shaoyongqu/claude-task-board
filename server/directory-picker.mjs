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
        stdio: ["ignore", "pipe", "ignore"],
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

const WINDOWS_PS = [
  "Add-Type -AssemblyName System.Windows.Forms | Out-Null;",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;",
  "$dialog.Description = '选择项目工作目录 / Choose a project workspace';",
  "$dialog.ShowNewFolderButton = $true;",
  "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
].join(" ");

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
