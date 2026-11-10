import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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

async function triggerFigmaSaveLocalCopy(): Promise<void> {
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

  if (process.platform === "win32") {
    const script = [
      "$ws = New-Object -ComObject WScript.Shell",
      'if (-not $ws.AppActivate("Figma")) { throw "Could not activate the Figma desktop app." }',
      "Start-Sleep -Milliseconds 500",
      '$ws.SendKeys("^k")',
      "Start-Sleep -Milliseconds 1000",
      '$ws.SendKeys("Save local copy")',
      "Start-Sleep -Milliseconds 1000",
      '$ws.SendKeys("{ENTER}")',
    ].join("; ");
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 15_000, windowsHide: true }
    );
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
  const before = await listFigFiles(downloadDir);
  const baseline = new Map(before.map((file) => [file.path, `${file.size}:${file.mtimeMs}`]));
  const startedAt = Date.now();

  await triggerFigmaSaveLocalCopy();

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

  // Keep the original Downloads copy intact; exporting elsewhere must not
  // silently remove the file Figma just created.
  return {
    outputPath: destination,
    bytesWritten: downloaded.size,
    sourceFileName: path.basename(downloaded.path),
  };
}

export function registerFigExportTool(server: McpServer): void {
  server.tool(
    "export_fig",
    "Save the active Figma desktop document as a native .fig file and copy the completed download to outputPath (the original Downloads file is kept). This uses Figma's File > Save local copy action; the intended document must be the active Figma window. Supported on macOS and Windows only.",
    {
      fileName: z
        .string()
        .min(1)
        .describe("Exact Figma document name (without .fig); used to identify the downloaded native file."),
      outputPath: z
        .string()
        .min(1)
        .describe("Destination .fig path; relative paths resolve from the MCP server working directory."),
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
