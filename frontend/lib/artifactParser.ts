/**
 * Artifact parsing — extracts <artifact type="..." title="...">...</artifact>
 * blocks from agent output, both for completed messages (parseArtifacts) and
 * live token streams (StreamingArtifactParser).
 *
 * Supported types: html | svg | mermaid | chart | markdown
 */

export type ArtifactType = "html" | "svg" | "mermaid" | "chart" | "markdown";

export interface Artifact {
  id: string;
  type: ArtifactType;
  title: string;
  content: string;
  complete: boolean;
}

const OPEN_TAG = /<artifact\s+type="([^"]+)"\s+title="([^"]*)"\s*>/i;
const CLOSE_TAG = /<\/artifact>/i;

let counter = 0;
function nextId() {
  counter += 1;
  return `artifact-${Date.now()}-${counter}`;
}

/** Parse a COMPLETED message: returns clean text (with placeholders) + artifacts. */
export function parseArtifacts(text: string): { cleanText: string; artifacts: Artifact[] } {
  const artifacts: Artifact[] = [];
  let remaining = text;
  let cleanText = "";

  while (true) {
    const openMatch = remaining.match(OPEN_TAG);
    if (!openMatch || openMatch.index === undefined) {
      cleanText += remaining;
      break;
    }
    cleanText += remaining.slice(0, openMatch.index);
    const afterOpen = remaining.slice(openMatch.index + openMatch[0].length);
    const closeMatch = afterOpen.match(CLOSE_TAG);

    const artifact: Artifact = {
      id: nextId(),
      type: (openMatch[1].toLowerCase() as ArtifactType) || "markdown",
      title: openMatch[2] || "Artifact",
      content: closeMatch && closeMatch.index !== undefined ? afterOpen.slice(0, closeMatch.index).trim() : afterOpen.trim(),
      complete: !!closeMatch,
    };
    artifacts.push(artifact);
    cleanText += `\n[artifact:${artifact.id}:${artifact.title}]\n`;

    remaining =
      closeMatch && closeMatch.index !== undefined
        ? afterOpen.slice(closeMatch.index + closeMatch[0].length)
        : "";
  }

  return { cleanText: cleanText.trim(), artifacts };
}

/**
 * Streaming parser: feed token chunks; it withholds partial artifact markup
 * from the visible text and emits artifacts as they complete.
 */
export class StreamingArtifactParser {
  private buffer = "";
  private cleanText = "";
  private artifacts: Artifact[] = [];
  private currentArtifact: Artifact | null = null;

  feed(chunk: string): { cleanText: string; artifacts: Artifact[] } {
    this.buffer += chunk;
    this.process();
    return this.snapshot();
  }

  reset() {
    this.buffer = "";
    this.cleanText = "";
    this.artifacts = [];
    this.currentArtifact = null;
  }

  private process() {
    while (true) {
      if (this.currentArtifact) {
        const closeMatch = this.buffer.match(CLOSE_TAG);
        if (closeMatch && closeMatch.index !== undefined) {
          this.currentArtifact.content = this.buffer.slice(0, closeMatch.index).trim();
          this.currentArtifact.complete = true;
          this.buffer = this.buffer.slice(closeMatch.index + closeMatch[0].length);
          this.currentArtifact = null;
          continue;
        }
        // Still streaming inside the artifact
        this.currentArtifact.content = this.buffer.trim();
        return;
      }

      const openMatch = this.buffer.match(OPEN_TAG);
      if (openMatch && openMatch.index !== undefined) {
        this.cleanText += this.buffer.slice(0, openMatch.index);
        this.currentArtifact = {
          id: nextId(),
          type: (openMatch[1].toLowerCase() as ArtifactType) || "markdown",
          title: openMatch[2] || "Artifact",
          content: "",
          complete: false,
        };
        this.artifacts.push(this.currentArtifact);
        this.cleanText += `\n[artifact:${this.currentArtifact.id}:${this.currentArtifact.title}]\n`;
        this.buffer = this.buffer.slice(openMatch.index + openMatch[0].length);
        continue;
      }

      // Withhold anything that could be the start of an artifact tag
      const partialIdx = this.buffer.lastIndexOf("<");
      if (partialIdx !== -1 && this.buffer.length - partialIdx < 60) {
        const tail = this.buffer.slice(partialIdx);
        if ("<artifact".startsWith(tail.slice(0, 9)) || tail.toLowerCase().startsWith("<artifact")) {
          this.cleanText += this.buffer.slice(0, partialIdx);
          this.buffer = tail;
          return;
        }
      }
      this.cleanText += this.buffer;
      this.buffer = "";
      return;
    }
  }

  snapshot(): { cleanText: string; artifacts: Artifact[] } {
    return { cleanText: this.cleanText, artifacts: [...this.artifacts] };
  }
}
