export type CommandClass = "inspection" | "verification" | "default";

function tailLines(text: string, count: number): string {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

export function commandClass(command: string): CommandClass {
  const normalized = command.trim().toLowerCase();
  if (/^(rg|grep|find|ls|tree|git\s+(status|diff|log|show|branch|rev-parse)|pwd|which|type|head|tail|wc)\b/.test(normalized)) {
    return "inspection";
  }
  if (/\b(pytest|ctest|colcon\s+build|cmake\s+--build|make|ninja|npm\s+(test|run\s+(test|build|lint))|pnpm\s+(test|run\s+(test|build|lint)))\b/.test(normalized)) {
    return "verification";
  }
  return "default";
}

export function compactPreview(text: string, isError: boolean, command: string): string {
  const kind = commandClass(command);
  let maxChars = 900;
  let maxLines = 10;
  if (kind === "inspection") {
    maxChars = 5000;
    maxLines = 120;
  } else if (kind === "verification") {
    maxChars = 700;
    maxLines = 8;
  }
  if (isError) {
    maxChars = Math.max(maxChars, 2200);
    maxLines = Math.max(maxLines, 30);
  }

  const lines = text.split(/\r?\n/);
  const selected = kind === "inspection" && !isError
    ? lines.slice(0, maxLines).join("\n").trim()
    : tailLines(text, maxLines).trim();
  if (!selected) return "";
  if (selected.length <= maxChars) return selected;
  return kind === "inspection" && !isError
    ? `${selected.slice(0, maxChars)}\n…`
    : `…\n${selected.slice(-maxChars)}`;
}
