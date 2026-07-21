"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { X, Copy, Download, Check } from "lucide-react";
import type { Artifact } from "@/lib/artifactParser";
import { exportArtifact, copyArtifact } from "@/lib/artifactExport";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/**
 * Renders html / svg / mermaid / chart / markdown artifacts.
 * HTML runs in a sandboxed iframe with Chart.js, D3, Mermaid, KaTeX preloaded.
 */
export default function ArtifactPanel({
  artifacts,
  activeId,
  onSelect,
  onClose,
}: {
  artifacts: Artifact[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const active = artifacts.find((a) => a.id === activeId) || artifacts[artifacts.length - 1];
  const [copied, setCopied] = useState(false);

  if (!active) return null;

  async function handleCopy() {
    await copyArtifact(active!);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex flex-col h-full bg-white border-l border-ips-border">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-ips-border bg-ips-surface shrink-0">
        <Badge variant="steel">{active.type}</Badge>
        <span className="text-sm font-medium truncate flex-1">{active.title}</span>
        <Button variant="ghost" size="icon" onClick={handleCopy} title="Copy source">
          {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
        </Button>
        <Button variant="ghost" size="icon" onClick={() => exportArtifact(active)} title="Download">
          <Download className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={onClose} title="Close panel">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {artifacts.length > 1 && (
        <div className="flex gap-1 px-3 py-1.5 border-b border-ips-border overflow-x-auto thin-scroll shrink-0">
          {artifacts.map((a, i) => (
            <button
              key={a.id}
              onClick={() => onSelect(a.id)}
              className={`text-xs px-2 py-1 rounded whitespace-nowrap ${
                a.id === active.id
                  ? "bg-ips-red text-white"
                  : "bg-ips-surface text-ips-charcoal-600 hover:bg-ips-border"
              }`}
            >
              {i + 1}. {a.title.slice(0, 24)}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-auto thin-scroll">
        <ArtifactRenderer artifact={active} />
      </div>
    </div>
  );
}

function ArtifactRenderer({ artifact }: { artifact: Artifact }) {
  if (artifact.type === "html") return <HtmlFrame html={artifact.content} key={artifact.id + artifact.content.length} />;
  if (artifact.type === "svg")
    return <SvgFrame svg={artifact.content} key={artifact.id + artifact.content.length} />;
  if (artifact.type === "mermaid") return <MermaidFrame code={artifact.content} key={artifact.id + artifact.content.length} />;
  if (artifact.type === "chart") return <ChartFrame config={artifact.content} key={artifact.id + artifact.content.length} />;
  return (
    <div className="p-4 chat-markdown text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{artifact.content}</ReactMarkdown>
    </div>
  );
}

const FRAME_LIBS = `
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"><\/script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.19/dist/katex.min.css" />
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.19/dist/katex.min.js"><\/script>
`;

function HtmlFrame({ html }: { html: string }) {
  const doc = useMemo(() => {
    const hasHtmlTag = /<html[\s>]/i.test(html);
    if (hasHtmlTag) return html.replace(/<head([^>]*)>/i, `<head$1>${FRAME_LIBS}`);
    return `<!DOCTYPE html><html><head><meta charset="utf-8">${FRAME_LIBS}
<style>body{font-family:"Kumbh Sans",Arial,sans-serif;margin:12px;color:#231F20}</style></head><body>${html}</body></html>`;
  }, [html]);
  return (
    <iframe
      sandbox="allow-scripts"
      srcDoc={doc}
      className="w-full h-full min-h-[400px] border-0"
      title="HTML artifact"
    />
  );
}

// SVG can carry <script>/onload handlers — render it inside a sandboxed
// iframe (no allow-same-origin) instead of dangerouslySetInnerHTML.
function SvgFrame({ svg }: { svg: string }) {
  const doc = useMemo(
    () => `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{margin:12px;display:flex;justify-content:center}svg{max-width:100%;height:auto}</style></head>
<body>${svg}</body></html>`,
    [svg]
  );
  return (
    <iframe sandbox="" srcDoc={doc} className="w-full h-full min-h-[400px] border-0" title="SVG artifact" />
  );
}

function MermaidFrame({ code }: { code: string }) {
  const doc = useMemo(
    () => `<!DOCTYPE html><html><head><meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"><\/script>
<style>body{margin:12px;display:flex;justify-content:center}</style></head>
<body><pre class="mermaid">${code.replace(/</g, "&lt;")}</pre>
<script>mermaid.initialize({startOnLoad:true,theme:'neutral'});<\/script></body></html>`,
    [code]
  );
  return (
    <iframe sandbox="allow-scripts" srcDoc={doc} className="w-full h-full min-h-[400px] border-0" title="Mermaid diagram" />
  );
}

function ChartFrame({ config }: { config: string }) {
  const doc = useMemo(
    () => `<!DOCTYPE html><html><head><meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<style>body{margin:12px;font-family:"Kumbh Sans",Arial,sans-serif}#wrap{position:relative;height:92vh}</style></head>
<body><div id="wrap"><canvas id="c"></canvas></div>
<script>
try {
  const cfg = ${JSON.stringify(config)};
  new Chart(document.getElementById('c'), JSON.parse(cfg));
} catch (e) {
  document.body.innerHTML = '<pre style="color:#a63232">Chart config error: ' + e.message + '</pre>';
}
<\/script></body></html>`,
    [config]
  );
  return <iframe sandbox="allow-scripts" srcDoc={doc} className="w-full h-full min-h-[400px] border-0" title="Chart" />;
}
