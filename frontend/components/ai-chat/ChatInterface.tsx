"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Send, Square, Paperclip, ThumbsUp, ThumbsDown, BookMarked,
  FileText, ImageIcon, X, PanelRight, RefreshCw,
  Copy, Check, RotateCcw, Pencil, Download, Menu,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { parseArtifacts, StreamingArtifactParser, type Artifact } from "@/lib/artifactParser";
import SourceCitation, { type Source } from "./SourceCitation";
import PlanDisplay, { type Plan } from "./PlanDisplay";
import VoiceInput from "./VoiceInput";
import PromptLibrary from "./PromptLibrary";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ChatMessage {
  id?: number;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  plan?: Plan | null;
  confidence?: number;
  feedback?: "up" | "down" | null;
}

interface UploadedFile {
  kind: "image" | "document";
  filename: string;
  media_type?: string;
  data?: string;
  text?: string;
}

const WORKING_PHRASES = [
  "Thinking through your question",
  "Checking the data",
  "Working on it",
  "Pulling things together",
  "Analyzing",
];

function friendlyTool(name: string): string {
  const map: Record<string, string> = {
    query_operational_database: "Querying the operational database",
    query_billing_database: "Querying the billing database",
    vector_search: "Searching documents & knowledge",
    hybrid_search: "Searching documents & knowledge",
    generate_pdf: "Generating a PDF",
    create_document: "Drafting the document",
    execute_python: "Running analysis",
    create_task: "Creating the task",
    research: "Researching",
  };
  return map[name] || `Running ${name.replace(/_/g, " ")}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function ChatInterface({
  sessionId,
  onFirstMessage,
  artifacts,
  setArtifacts,
  setActiveArtifactId,
  setArtifactPanelOpen,
  onOpenHistory,
}: {
  sessionId: number | null;
  onFirstMessage: () => void;
  artifacts: Artifact[];
  setArtifacts: React.Dispatch<React.SetStateAction<Artifact[]>>;
  setActiveArtifactId: (id: string) => void;
  setArtifactPanelOpen: (open: boolean) => void;
  onOpenHistory?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [streamText, setStreamText] = useState("");
  const [streamPlan, setStreamPlan] = useState<Plan | null>(null);
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [feedbackFor, setFeedbackFor] = useState<number | null>(null);
  const [feedbackText, setFeedbackText] = useState("");
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);
  const [pendingRetryMessage, setPendingRetryMessage] = useState<string | null>(null);
  const [copiedMessageIdx, setCopiedMessageIdx] = useState<number | null>(null);
  const editRegenRef = useRef(false); // next send replaces the last user turn

  const abortRef = useRef<AbortController | null>(null);
  const parserRef = useRef(new StreamingArtifactParser());
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const phraseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load session messages
  useEffect(() => {
    setMessages([]);
    setArtifacts([]);
    if (!sessionId) return;
    fetch(`/api/agent-chat/sessions/${sessionId}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.messages) return;
        const loaded: ChatMessage[] = [];
        const allArtifacts: Artifact[] = [];
        for (const m of data.messages) {
          if (m.role === "assistant") {
            const { cleanText, artifacts: arts } = parseArtifacts(m.content);
            allArtifacts.push(...arts);
            loaded.push({
              id: m.id, role: "assistant", content: cleanText,
              sources: m.sources || [], plan: m.plan_json, confidence: m.confidence_score,
            });
          } else {
            loaded.push({ id: m.id, role: m.role, content: m.content });
          }
        }
        setMessages(loaded);
        setArtifacts(allArtifacts);
      })
      .catch(() => {});
  }, [sessionId, setArtifacts]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText, status]);

  // Prefill from the Platform Tips page ("Try it" hand-off)
  useEffect(() => {
    try {
      const tip = sessionStorage.getItem("ips-tip-prompt");
      if (tip) {
        sessionStorage.removeItem("ips-tip-prompt");
        setInput(tip);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Cycle generic phrases while no specific status has arrived
  function startPhraseCycle() {
    let i = 0;
    setStatus(WORKING_PHRASES[0]);
    phraseTimerRef.current = setInterval(() => {
      i = (i + 1) % WORKING_PHRASES.length;
      setStatus((prev) => (prev && WORKING_PHRASES.includes(prev) ? WORKING_PHRASES[i] : prev));
    }, 3000);
  }
  function stopPhraseCycle() {
    if (phraseTimerRef.current) clearInterval(phraseTimerRef.current);
    phraseTimerRef.current = null;
  }

  // -------------------------------------------------------------------------
  // Send + stream
  // -------------------------------------------------------------------------
  const sendMessage = useCallback(
    async (overrideText?: string, opts?: { regenerate?: boolean; skipUserBubble?: boolean }) => {
      const text = (overrideText ?? input).trim();
      if ((!text && attachments.length === 0) || loading || !sessionId) return;

      // Edit-and-resend arms this flag; consume it into the request options
      const regenerate = opts?.regenerate || editRegenRef.current;
      editRegenRef.current = false;

      setInput("");
      setRetryCountdown(null);
      setPendingRetryMessage(null);
      const isFirst = messages.length === 0;

      const imageAttachments = attachments
        .filter((a) => a.kind === "image")
        .map((a) => ({ media_type: a.media_type!, data: a.data! }));
      const documentAttachments = attachments
        .filter((a) => a.kind === "document")
        .map((a) => ({ filename: a.filename, text: a.text! }));
      const sentAttachments = [...attachments];
      setAttachments([]);

      const attachmentNote =
        sentAttachments.length > 0
          ? `\n\n📎 ${sentAttachments.map((a) => a.filename).join(", ")}`
          : "";
      if (!opts?.skipUserBubble) {
        setMessages((prev) => [...prev, { role: "user", content: text + attachmentNote }]);
      }
      setLoading(true);
      setStreamText("");
      setStreamPlan(null);
      parserRef.current.reset();
      startPhraseCycle();

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch(`/api/agent-chat/sessions/${sessionId}/message`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, imageAttachments, documentAttachments, regenerate }),
          signal: controller.signal,
        });

        if (res.status === 429) {
          const body = await res.json().catch(() => ({}));
          beginRetryCountdown(text, body.retryAfterSec || 30);
          return;
        }
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Request failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let gotComplete = false;
        let finalResult: any = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            let event: any;
            try {
              event = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }
            const { type, data } = event;

            if (type === "analysis") {
              // informational only
            } else if (type === "plan") {
              setStreamPlan(data);
              setStatus("Planning the work");
            } else if (type === "progress") {
              setStatus(friendlyTool(data.tool));
            } else if (type === "tool_result") {
              setStatus(friendlyTool(data.tool) + " — done");
            } else if (type === "tool_error") {
              setStatus("A step hit an issue — continuing");
            } else if (type === "response_chunk") {
              stopPhraseCycle();
              setStatus(null);
              const { cleanText, artifacts: arts } = parserRef.current.feed(data.content);
              setStreamText(cleanText);
              if (arts.length) {
                setArtifacts((prev) => {
                  const byId = new Map(prev.map((a) => [a.id, a]));
                  for (const a of arts) byId.set(a.id, a);
                  return [...byId.values()];
                });
                const latest = arts[arts.length - 1];
                if (latest) {
                  setActiveArtifactId(latest.id);
                  setArtifactPanelOpen(true);
                }
              }
            } else if (type === "response_reset") {
              // Intermediate "thinking" text discarded — clear the stream
              parserRef.current.reset();
              setStreamText("");
              startPhraseCycle();
            } else if (type === "session_title") {
              // Server renamed the session after the first exchange
              onFirstMessage();
            } else if (type === "complete") {
              gotComplete = true;
              finalResult = data;
            } else if (type === "error") {
              if (data.retryable && data.retryAfterSec) {
                beginRetryCountdown(text, data.retryAfterSec);
                return;
              }
              throw new Error(data.error || "The agent hit an error");
            }
          }
        }

        // Finalize
        const { cleanText } = parserRef.current.snapshot();
        const finalContent =
          cleanText.trim() ||
          (gotComplete && finalResult?.response ? parseArtifacts(finalResult.response).cleanText : "");
        if (finalContent || gotComplete) {
          setMessages((prev) => [
            ...prev,
            {
              id: finalResult?.assistantMessageId,
              role: "assistant",
              content: finalContent || "(no response)",
              sources: finalResult?.sources || [],
              plan: streamPlan,
              confidence: finalResult?.confidence,
            },
          ]);
        } else {
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content:
                "The connection dropped before the response finished. This can happen on very long research runs — please try again.",
            },
          ]);
        }
        if (isFirst) onFirstMessage();
      } catch (err: any) {
        if (err.name !== "AbortError") {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: `⚠️ ${err.message || "Something went wrong."}` },
          ]);
        } else if (streamText) {
          setMessages((prev) => [...prev, { role: "assistant", content: streamText + "\n\n_(stopped)_" }]);
        }
      } finally {
        stopPhraseCycle();
        setLoading(false);
        setStatus(null);
        setStreamText("");
        setStreamPlan(null);
        abortRef.current = null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [input, attachments, loading, sessionId, messages.length]
  );

  function beginRetryCountdown(message: string, seconds: number) {
    stopPhraseCycle();
    setLoading(false);
    setStatus(null);
    setPendingRetryMessage(message);
    setRetryCountdown(seconds);
    if (retryTimerRef.current) clearInterval(retryTimerRef.current);
    retryTimerRef.current = setInterval(() => {
      setRetryCountdown((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          clearInterval(retryTimerRef.current!);
          setTimeout(() => sendMessage(message), 50);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  }

  function cancelRetry() {
    if (retryTimerRef.current) clearInterval(retryTimerRef.current);
    setRetryCountdown(null);
    setPendingRetryMessage(null);
  }

  function stopGeneration() {
    abortRef.current?.abort();
  }

  // -------------------------------------------------------------------------
  // Message actions: copy / regenerate / edit / export
  // -------------------------------------------------------------------------
  async function copyMessage(idx: number, content: string) {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageIdx(idx);
      setTimeout(() => setCopiedMessageIdx(null), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  function regenerateLast() {
    if (loading) return;
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    const text = lastUser.content.split("\n\n📎")[0];
    // Drop the trailing assistant reply; the user bubble stays
    setMessages((prev) => {
      const idx = prev.map((m) => m.role).lastIndexOf("assistant");
      return idx >= 0 ? prev.slice(0, idx) : prev;
    });
    sendMessage(text, { regenerate: true, skipUserBubble: true });
  }

  function editLastUserMessage() {
    if (loading) return;
    const idx = messages.map((m) => m.role).lastIndexOf("user");
    if (idx === -1) return;
    const text = messages[idx].content.split("\n\n📎")[0];
    setMessages((prev) => prev.slice(0, idx));
    setInput(text);
    editRegenRef.current = true; // the next send replaces the old turn server-side
  }

  function exportConversation() {
    if (!messages.length) return;
    const md = [
      `# IPS AI Brain — Conversation Export`,
      `_Exported ${new Date().toLocaleString()}_`,
      "",
      ...messages.map((m) =>
        m.role === "user" ? `## You\n\n${m.content}` : `## IPS AI\n\n${m.content}`
      ),
    ].join("\n\n");
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ips-chat-${sessionId || "export"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // -------------------------------------------------------------------------
  // Uploads (picker + paste + drag)
  // -------------------------------------------------------------------------
  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    setUploading(true);
    try {
      const form = new FormData();
      list.forEach((f) => form.append("files", f));
      const res = await fetch("/api/agent-chat/upload", {
        method: "POST",
        credentials: "include",
        body: form,
      });
      const data = await res.json();
      if (data.success) setAttachments((prev) => [...prev, ...data.files]);
    } finally {
      setUploading(false);
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    const files = Array.from(e.clipboardData.files);
    if (files.length) {
      e.preventDefault();
      uploadFiles(files);
    }
  }

  // -------------------------------------------------------------------------
  // Feedback
  // -------------------------------------------------------------------------
  async function sendFeedback(messageId: number, rating: "up" | "down", text?: string) {
    await fetch(`/api/agent-chat/messages/${messageId}/feedback`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating, feedback_text: text || null, training_instruction: text || null }),
    });
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, feedback: rating } : m)));
    setFeedbackFor(null);
    setFeedbackText("");
  }

  // -------------------------------------------------------------------------
  // Message content renderer (with artifact placeholders as cards)
  // -------------------------------------------------------------------------
  const renderContent = useCallback(
    (content: string) => {
      const parts = content.split(/\[artifact:([^:\]]+):([^\]]*)\]/g);
      const nodes: React.ReactNode[] = [];
      for (let i = 0; i < parts.length; i += 3) {
        if (parts[i]) {
          nodes.push(
            <div key={`md-${i}`} className="chat-markdown">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" />,
                }}
              >
                {parts[i]}
              </ReactMarkdown>
            </div>
          );
        }
        if (parts[i + 1] !== undefined) {
          const artifactId = parts[i + 1];
          const title = parts[i + 2] || "Artifact";
          nodes.push(
            <button
              key={`art-${i}`}
              onClick={() => {
                setActiveArtifactId(artifactId);
                setArtifactPanelOpen(true);
              }}
              className="flex items-center gap-2 my-2 px-3 py-2 border border-ips-steel/40 bg-ips-steel-soft rounded-lg text-sm text-ips-steel hover:bg-ips-steel hover:text-white transition-colors"
            >
              <PanelRight className="h-4 w-4" />
              {title}
            </button>
          );
        }
      }
      return nodes;
    },
    [setActiveArtifactId, setArtifactPanelOpen]
  );

  const emptyState = messages.length === 0 && !loading;
  const lastAssistantIdx = messages.map((m) => m.role).lastIndexOf("assistant");
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");

  // -------------------------------------------------------------------------
  return (
    <div
      className="flex flex-col h-full bg-white"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        uploadFiles(e.dataTransfer.files);
      }}
    >
      {/* Toolbar: mobile history + export */}
      {(onOpenHistory || messages.length > 0) && (
        <div className="flex items-center px-3 py-1 border-b border-ips-border bg-white shrink-0">
          {onOpenHistory && (
            <button
              onClick={onOpenHistory}
              className="md:hidden p-1.5 rounded text-ips-charcoal-600 hover:bg-ips-surface"
              title="Chat history"
            >
              <Menu className="h-4 w-4" />
            </button>
          )}
          <div className="ml-auto">
            {messages.length > 0 && (
              <button
                onClick={exportConversation}
                className="p-1.5 rounded text-ips-charcoal-600 hover:bg-ips-surface"
                title="Export conversation (.md)"
              >
                <Download className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto thin-scroll px-4 py-4">
        {emptyState && (
          <div className="h-full flex flex-col items-center justify-center text-center gap-3 max-w-md mx-auto">
            <img src="/ips-logo.png" alt="IPS" className="h-16 w-auto opacity-90" />
            <h2 className="text-xl font-semibold text-ips-charcoal">IPS AI Brain</h2>
            <p className="text-sm text-ips-charcoal-600">
              Ask about jobs, billing, crews, safety, or IPS services — or upload an RFP,
              screenshot, or spreadsheet to work through it together.
            </p>
          </div>
        )}

        <div className="max-w-3xl mx-auto space-y-4">
          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
              {m.role === "user" ? (
                <div className="group flex items-end gap-1 max-w-[85%]">
                  {i === lastUserIdx && !loading && (
                    <button
                      onClick={editLastUserMessage}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded text-gray-400 hover:text-ips-steel transition-opacity shrink-0"
                      title="Edit & resend"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <div className="bg-ips-charcoal text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm whitespace-pre-wrap">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div className="max-w-full w-full">
                  {m.plan && <PlanDisplay plan={m.plan} />}
                  <div className="text-sm text-ips-charcoal">{renderContent(m.content)}</div>
                  <SourceCitation sources={m.sources || []} />
                  <div className="flex items-center gap-1 mt-1.5">
                    <button
                      onClick={() => copyMessage(i, m.content)}
                      className={`p-1 rounded hover:bg-ips-surface ${copiedMessageIdx === i ? "text-green-600" : "text-gray-400"}`}
                      title="Copy message"
                    >
                      {copiedMessageIdx === i ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                    {i === lastAssistantIdx && !loading && (
                      <button
                        onClick={regenerateLast}
                        className="p-1 rounded hover:bg-ips-surface text-gray-400 hover:text-ips-steel"
                        title="Regenerate response"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {m.id && (
                      <>
                        <button
                          onClick={() => sendFeedback(m.id!, "up")}
                          className={`p-1 rounded hover:bg-ips-surface ${m.feedback === "up" ? "text-green-600" : "text-gray-400"}`}
                          title="Good response"
                        >
                          <ThumbsUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setFeedbackFor(feedbackFor === m.id ? null : m.id!)}
                          className={`p-1 rounded hover:bg-ips-surface ${m.feedback === "down" ? "text-ips-red" : "text-gray-400"}`}
                          title="Needs work"
                        >
                          <ThumbsDown className="h-3.5 w-3.5" />
                        </button>
                        {typeof m.confidence === "number" && (
                          <span className="text-[10px] text-gray-400 ml-1">
                            {Math.round(m.confidence * 100)}% confidence
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  {feedbackFor === m.id && (
                    <div className="mt-2 border border-ips-border rounded-lg p-2.5 bg-ips-surface">
                      <p className="text-xs text-ips-charcoal-600 mb-1.5">
                        What was wrong? This trains the agent.
                      </p>
                      <Textarea
                        rows={2}
                        value={feedbackText}
                        onChange={(e) => setFeedbackText(e.target.value)}
                        placeholder="e.g. Wrong table — job hours live in the timekeeping data"
                        className="text-xs"
                      />
                      <div className="flex justify-end gap-2 mt-1.5">
                        <Button variant="ghost" size="sm" onClick={() => setFeedbackFor(null)}>
                          Cancel
                        </Button>
                        <Button size="sm" onClick={() => sendFeedback(m.id!, "down", feedbackText)}>
                          Send feedback
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {/* Live stream */}
          {loading && (
            <div className="max-w-full">
              {streamPlan && <PlanDisplay plan={streamPlan} />}
              {streamText ? (
                <div className="text-sm text-ips-charcoal">{renderContent(streamText)}</div>
              ) : (
                status && (
                  <div className="flex items-center gap-2 text-sm text-ips-charcoal-600">
                    <span className="flex gap-1">
                      {[0, 1, 2].map((d) => (
                        <span
                          key={d}
                          className="h-1.5 w-1.5 rounded-full bg-ips-red animate-pulse-dot"
                          style={{ animationDelay: `${d * 0.2}s` }}
                        />
                      ))}
                    </span>
                    {status}…
                  </div>
                )
              )}
            </div>
          )}

          {/* Rate-limit auto retry */}
          {retryCountdown !== null && (
            <div className="flex items-center gap-3 border border-amber-300 bg-amber-50 text-amber-800 rounded-lg px-3 py-2 text-sm">
              <RefreshCw className="h-4 w-4 animate-spin" />
              AI service at capacity — retrying in {retryCountdown}s
              <Button size="sm" variant="outline" onClick={() => { cancelRetry(); sendMessage(pendingRetryMessage!); }}>
                Retry now
              </Button>
              <Button size="sm" variant="ghost" onClick={cancelRetry}>
                Cancel
              </Button>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-ips-border bg-white p-3 shrink-0">
        <div className="max-w-3xl mx-auto relative">
          <PromptLibrary open={libraryOpen} onClose={() => setLibraryOpen(false)} onSelect={(p) => setInput(p)} />

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {attachments.map((a, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1.5 text-xs bg-ips-surface border border-ips-border rounded-full pl-2 pr-1 py-1"
                >
                  {a.kind === "image" ? <ImageIcon className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
                  {a.filename}
                  <button
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    className="p-0.5 hover:text-ips-red"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex items-end gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              accept="image/*,.pdf,.docx,.xlsx,.xls,.csv,.txt,.md,.pptx"
              onChange={(e) => e.target.files && uploadFiles(e.target.files)}
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              title="Attach files (or paste a screenshot)"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => setLibraryOpen(!libraryOpen)} title="Prompt library">
              <BookMarked className="h-4 w-4" />
            </Button>
            <VoiceInput onTranscript={(t) => setInput((prev) => (prev ? prev + " " : "") + t)} />
            <Textarea
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder={uploading ? "Uploading…" : "Ask about jobs, billing, safety, services…"}
              className="flex-1 min-h-[42px] max-h-40"
              style={{ height: "auto" }}
              disabled={!sessionId}
            />
            {loading ? (
              <Button variant="secondary" size="icon" onClick={stopGeneration} title="Stop">
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                size="icon"
                onClick={() => sendMessage()}
                disabled={(!input.trim() && !attachments.length) || !sessionId || uploading}
                title="Send"
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
          <p className="text-[10px] text-gray-400 mt-1.5 text-center">
            IPS AI Brain · private &amp; owned by IPS, Inc. · answers grounded in IPS data
          </p>
        </div>
      </div>
    </div>
  );
}
