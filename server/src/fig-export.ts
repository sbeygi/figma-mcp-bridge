import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 500;
const REQUIRED_STABLE_POLLS = 3;

interface FigFile {
  path: string;
  size: number;
  mtimeMs: number;
}

function normalizedFileStem(value: string): string {
  return path
    .basename(value, path.extname(value))
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function matchesExpectedName(candidatePath: string, expectedName: string): boolean {
  const expected = normalizedFileStem(expectedName);
  const actual = normalizedFileStem(candidatePath);
  if (!expected) return false;
  const suffix = actual.startsWith(expected) ? actual.slice(expected.length) : "";
  return actual === expected || (suffix.length > 0 && /^\d+$/.test(suffix));
}

async function listFigFiles(downloadDir: string): Promise<FigFile[]> {
  let entries;
  try {
    entries = await readdir(downloadDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Downloads folder does not exist: ${downloadDir}`);
    }
    throw error;
  }

  const files: FigFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".fig") continue;
    const filePath = path.join(downloadDir, entry.name);
    try {
      const fileStat = await stat(filePath);
      files.push({ path: filePath, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
    } catch {
      // A browser or Figma may still be replacing the file while the folder is scanned.
    }
  }
  return files;
}

interface CdpTarget {
  type: string;
  title: string;
  webSocketDebuggerUrl: string;
}

interface CdpMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

async function triggerFigmaSaveViaCdp(fileName: string): Promise<void> {
  const port = Number(process.env.FIGMA_CDP_PORT ?? 9222);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("FIGMA_CDP_PORT must be a valid TCP port number.");
  }

  let targets: CdpTarget[];
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    targets = (await response.json()) as CdpTarget[];
  } catch {
    throw new Error(
      `Figma CDP is not reachable on port ${port}. Launch Figma with FIGMA_TEST=1 and --remote-debugging-port=${port}, then retry.`
    );
  }

  const expectedTitle = normalizedFileStem(fileName);
  const target = targets.find((candidate) => {
    if (candidate.type !== "page" || !candidate.webSocketDebuggerUrl) return false;
    const title = candidate.title.replace(/\s+[–-]\s+Figma$/i, "");
    return normalizedFileStem(title) === expectedTitle;
  });
  if (!target) {
    throw new Error(
      `No open Figma editor tab named "${fileName}" was found through CDP on port ${port}.`
    );
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const onMessage = (data: WebSocket.RawData) => {
    let message: CdpMessage;
    try {
      message = JSON.parse(data.toString()) as CdpMessage;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message ?? "CDP command failed."));
    else request.resolve(message.result);
  };
  socket.on("message", onMessage);

  const command = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        pending.delete(id);
        reject(error);
      });
    });
  };

  const evaluate = async (expression: string): Promise<unknown> => {
    const response = (await command("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text ?? "Figma rejected the save action.");
    }
    return response.result?.value;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out connecting to Figma CDP.")),
        5_000
      );
      socket.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    const editor = (await evaluate(
      `({ title: document.title, hasMainMenu: !!document.querySelector("[data-tooltip='main-menu']") })`
    )) as
      | {
          title?: string;
          hasMainMenu?: boolean;
        }
      | undefined;
    if (!editor?.hasMainMenu)
      throw new Error(`The CDP tab for "${fileName}" is not a Figma design editor.`);
    const actualTitle = (editor.title ?? "").replace(/\s+[–-]\s+Figma$/i, "");
    if (normalizedFileStem(actualTitle) !== expectedTitle) {
      throw new Error(`The active Figma editor is "${actualTitle}", not "${fileName}".`);
    }

    // Open the File submenu with CDP mouse input; this does not activate or focus the Figma window.
    const rootMenuOpen = await evaluate(
      `!![...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.trim() === "File")`
    );
    if (!rootMenuOpen) {
      const opened = await evaluate(`(() => {
        const button = document.querySelector("[data-tooltip='main-menu']");
        if (!button) return false;
        button.click();
        return true;
      })()`);
      if (!opened) throw new Error("Could not open Figma's main menu through CDP.");
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    const saveActionVisible = await evaluate(
      `!![...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.trim().startsWith("Save local copy"))`
    );
    if (!saveActionVisible) {
      const fileMenuPoint = (await evaluate(`(() => {
        const item = document.querySelector('[role="menuitem"][aria-controls^="mainMenu.file-menu"]');
        if (!item) return null;
        const rect = item.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`)) as { x: number; y: number } | null;
      if (!fileMenuPoint) throw new Error("Figma's File submenu was not available through CDP.");

      await command("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: fileMenuPoint.x,
        y: fileMenuPoint.y,
      });
      await command("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: fileMenuPoint.x,
        y: fileMenuPoint.y,
        button: "left",
        clickCount: 1,
      });
      await command("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: fileMenuPoint.x,
        y: fileMenuPoint.y,
        button: "left",
        clickCount: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    const triggered = await evaluate(`(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')]
        .find((candidate) => candidate.textContent.trim().startsWith("Save local copy"));
      if (!item) return false;
      // Figma's own "save-as" handler dispatches SaveLocalFile.
      item.click();
      return true;
    })()`);
    if (!triggered)
      throw new Error("Figma's Save local copy action was not found in the File menu.");
  } finally {
    socket.off("message", onMessage);
    for (const request of pending.values()) request.reject(new Error("CDP connection closed."));
    pending.clear();
    socket.close();
  }
}

async function completeWindowsSaveDialog(fileName: string): Promise<void> {
  const expectedDownloadName = `${fileName}.fig`.replace(/'/g, "''");
  const script = `
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class FigmaSaveDialog { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }
'@
$p = Get-Process Figma -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { throw 'Could not find the Figma desktop process.' }
$deadline = (Get-Date).AddSeconds(10)
$root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
$result = 'download'
$saveClicked = $false
while ((Get-Date) -lt $deadline) {
  $items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $confirm = $items | Where-Object { $_.Current.Name -eq 'Confirm Save As' } | Select-Object -First 1
  if ($confirm) {
    $children = $confirm.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $message = $children | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text } | Select-Object -First 1
    if (-not $message -or $message.Current.Name -notlike '*${expectedDownloadName} already exists*') { throw 'Unexpected Figma overwrite prompt; refusing to confirm it.' }
    $yes = $children | Where-Object { $_.Current.Name -eq 'Yes' } | Select-Object -First 1
    if (-not $yes) { throw 'Yes button not found in Figma overwrite prompt.' }
    [FigmaSaveDialog]::PostMessage([IntPtr]$yes.Current.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    $result = 'dialog'
    break
  }
  $saveDialog = $items | Where-Object { $_.Current.ClassName -eq '#32770' } | Select-Object -First 1
  if ($saveDialog) {
    $controls = $saveDialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $save = $controls | Where-Object { $_.Current.Name -eq 'Save' -and $_.Current.ClassName -eq 'Button' } | Select-Object -First 1
    if (-not $save) { throw 'Save button not found in Figma Save dialog.' }
    if (-not $saveClicked) {
      if (-not [FigmaSaveDialog]::PostMessage([IntPtr]$save.Current.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Could not submit Figma Save dialog.' }
      $saveClicked = $true
    }
  } elseif ($saveClicked) {
    $result = 'dialog'
    break
  }
  Start-Sleep -Milliseconds 100
}
$result
`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeout: 35_000, windowsHide: true }
  );
  if (!stdout.trim().endsWith("download") && !stdout.trim().endsWith("dialog")) {
    throw "Could not determine how Figma opened Save local copy: ${stdout.trim()}";
  }
}

async function triggerFigmaSaveLocalCopy(fileName: string): Promise<void> {
  if (process.platform === "win32") {
    await triggerFigmaSaveViaCdp(fileName);
    await completeWindowsSaveDialog(fileName);
    return;
  }

  if (process.platform === "darwin") {
    const script = [
      'tell application "Figma" to activate',
      'tell application "System Events"',
      '  tell process "Figma"',
      "    set frontmost to true",
      '    keystroke "k" using {command down}',
      "    delay 1",
      '    keystroke "Save local copy"',
      "    delay 1",
      "    key code 36",
      "  end tell",
      "end tell",
    ].join("\n");
    await execFileAsync("osascript", ["-e", script], { timeout: 15_000 });
    return;
  }

  throw new Error(
    "Native .fig export automation is currently supported only on macOS and Windows with the Figma desktop app."
  );
}

async function waitForFigDownload(
  downloadDir: string,
  expectedName: string,
  startedAt: number,
  baseline: Map<string, string>,
  timeoutMs: number
): Promise<FigFile> {
  const deadline = Date.now() + timeoutMs;
  const stablePolls = new Map<string, { signature: string; count: number }>();

  while (Date.now() < deadline) {
    const candidates = (await listFigFiles(downloadDir))
      .filter((file) => matchesExpectedName(file.path, expectedName))
      .filter((file) => file.mtimeMs >= startedAt - 2_000)
      .filter((file) => baseline.get(file.path) !== `${file.size}:${file.mtimeMs}`)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const candidate of candidates) {
      const signature = `${candidate.size}:${candidate.mtimeMs}`;
      const previous = stablePolls.get(candidate.path);
      const count = previous?.signature === signature ? previous.count + 1 : 1;
      stablePolls.set(candidate.path, { signature, count });
      if (candidate.size > 0 && count >= REQUIRED_STABLE_POLLS) return candidate;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(
    `Timed out waiting for "${expectedName}.fig" in ${downloadDir}. Make sure the intended Figma file is active, complete any Save dialog, and allow Figma to save local copies to your Downloads folder.`
  );
}

export async function exportNativeFigFile(
  fileName: string,
  outputPath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<{ outputPath: string; bytesWritten: number; sourceFileName: string }> {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error(
      "Native .fig export automation is currently supported only on macOS and Windows with the Figma desktop app."
    );
  }

  if (!fileName.trim() || path.basename(fileName) !== fileName || /[\\/]/.test(fileName)) {
    throw new Error("fileName must be the Figma document name only, without a directory path.");
  }
  if (!normalizedFileStem(fileName)) {
    throw new Error("fileName must contain at least one letter or number.");
  }

  const destination = path.resolve(outputPath);
  if (path.extname(destination).toLowerCase() !== ".fig") {
    throw new Error("outputPath must end with the .fig extension.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer between 5000 and ${MAX_TIMEOUT_MS}.`);
  }

  const downloadDir = path.join(homedir(), "Downloads");
  if (existsSync(destination)) {
    throw new Error(`Refusing to overwrite existing file: ${destination}`);
  }
  const before = await listFigFiles(downloadDir);
  const baseline = new Map(before.map((file) => [file.path, `${file.size}:${file.mtimeMs}`]));
  const startedAt = Date.now();

  await triggerFigmaSaveLocalCopy(fileName);

  const downloaded = await waitForFigDownload(
    downloadDir,
    fileName,
    startedAt,
    baseline,
    timeoutMs
  );

  if (path.resolve(downloaded.path) === destination) {
    return {
      outputPath: destination,
      bytesWritten: downloaded.size,
      sourceFileName: path.basename(downloaded.path),
    };
  }

  try {
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(downloaded.path, destination, constants.COPYFILE_EXCL);
    await unlink(downloaded.path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new Error(`Refusing to overwrite existing file: ${destination}`);
    }
    if (code === "ENOENT") {
      throw new Error(
        `Could not access the source or destination for ${destination}. Check that the Figma download still exists and the destination is writable.`
      );
    }
    throw error;
  }

  return {
    outputPath: destination,
    bytesWritten: downloaded.size,
    sourceFileName: path.basename(downloaded.path),
  };
}

export function registerFigExportTool(server: McpServer): void {
  server.tool(
    "export_fig",
    "Save the named Figma desktop document as a native .fig file and move the completed download from Downloads to outputPath. On Windows this uses Figma CDP and its File > Save local copy action without requiring the Figma window to be focused. Launch Figma with FIGMA_TEST=1 and --remote-debugging-port=9222. Supported on macOS and Windows only.",
    {
      fileName: z
        .string()
        .min(1)
        .describe(
          "Exact Figma document name (without .fig); used to identify the downloaded native file."
        ),
      outputPath: z
        .string()
        .min(1)
        .describe(
          "Destination .fig path; relative paths resolve from the MCP server working directory."
        ),
      timeoutMs: z
        .number()
        .int()
        .min(5_000)
        .max(MAX_TIMEOUT_MS)
        .optional()
        .describe("Maximum time to wait for Figma to finish saving (default 120000, max 300000)."),
    },
    async ({ fileName, outputPath, timeoutMs }) => {
      try {
        const result = await exportNativeFigFile(fileName, outputPath, timeoutMs);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ success: true, ...result }) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        };
      }
    }
  );
}
