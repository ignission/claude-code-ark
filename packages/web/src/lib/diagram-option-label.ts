import { DIAGRAM_DIR } from "@ark/shared";

const DIAGRAMS_PREFIX = `${DIAGRAM_DIR}/`;

function basename(relPath: string): string {
  return relPath.split("/").at(-1) ?? relPath;
}

export function formatDiagramOptionLabel(
  displayName: string,
  relPath: string
): string {
  const displayPath = relPath.startsWith(DIAGRAMS_PREFIX)
    ? relPath.slice(DIAGRAMS_PREFIX.length)
    : relPath;

  if (displayName === basename(relPath)) return displayPath;

  return `${displayName} — ${displayPath}`;
}
