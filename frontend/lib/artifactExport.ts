/**
 * Export an artifact to a downloadable file (client-side).
 */
import type { Artifact } from "./artifactParser";

const EXT: Record<string, string> = {
  html: "html",
  svg: "svg",
  mermaid: "mmd",
  chart: "json",
  markdown: "md",
};

export function exportArtifact(artifact: Artifact) {
  const ext = EXT[artifact.type] || "txt";
  const mime =
    artifact.type === "html" ? "text/html" : artifact.type === "svg" ? "image/svg+xml" : "text/plain";
  const blob = new Blob([artifact.content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${artifact.title.replace(/[^a-zA-Z0-9-_ ]/g, "").slice(0, 60) || "artifact"}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function copyArtifact(artifact: Artifact) {
  await navigator.clipboard.writeText(artifact.content);
}
