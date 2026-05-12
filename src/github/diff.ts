import type { DiffPosition, PullRequestFile } from "../types.js";

export function collectValidNewLines(files: PullRequestFile[]): Set<string> {
  const validLines = new Set<string>();

  for (const file of files) {
    if (!file.patch) {
      continue;
    }

    let newLine = 0;
    for (const rawLine of file.patch.split("\n")) {
      if (rawLine.startsWith("@@")) {
        const match = /\+(\d+)(?:,\d+)?/.exec(rawLine);
        if (match) {
          newLine = Number(match[1]);
        }
        continue;
      }

      if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
        validLines.add(`${file.filename}:${newLine}`);
        newLine += 1;
        continue;
      }

      if (!rawLine.startsWith("-")) {
        newLine += 1;
      }
    }
  }

  return validLines;
}

export function toDiffPosition(
  file: PullRequestFile,
  line: number,
  validLines: Set<string>
): DiffPosition | null {
  if (validLines.has(`${file.filename}:${line}`)) {
    return {
      path: file.filename,
      line,
      side: "RIGHT"
    };
  }

  return null;
}
