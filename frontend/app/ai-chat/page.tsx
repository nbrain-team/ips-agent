"use client";
import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import Header from "@/components/layout/Header";
import ChatHistory from "@/components/ai-chat/ChatHistory";
import ChatInterface from "@/components/ai-chat/ChatInterface";
import ArtifactPanel from "@/components/ai-chat/ArtifactPanel";
import type { Artifact } from "@/lib/artifactParser";

export default function AiChatPage() {
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [artifactPanelOpen, setArtifactPanelOpen] = useState(false);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);

  const newSession = useCallback(async () => {
    const res = await fetch("/api/agent-chat/sessions", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const s = await res.json();
      setSessionId(s.id);
      setArtifacts([]);
      setArtifactPanelOpen(false);
      setHistoryKey((k) => k + 1);
    }
  }, []);

  // On mount: honor a shared link (?session=), else resume latest, else create
  useEffect(() => {
    (async () => {
      try {
        const requested = new URLSearchParams(window.location.search).get("session");
        if (requested && /^\d+$/.test(requested)) {
          setSessionId(parseInt(requested, 10));
          return;
        }
      } catch {
        /* ignore */
      }
      const res = await fetch("/api/agent-chat/sessions", { credentials: "include" });
      if (res.ok) {
        const sessions = await res.json();
        if (sessions.length) {
          setSessionId(sessions[0].id);
          return;
        }
      }
      newSession();
    })();
  }, [newSession]);

  const selectSession = (id: number) => {
    setSessionId(id);
    setArtifactPanelOpen(false);
    setMobileHistoryOpen(false);
  };

  return (
    <div className="flex flex-col h-screen">
      <Header />
      <div className="flex flex-1 min-h-0">
        <aside className="w-64 shrink-0 hidden md:block">
          <ChatHistory
            activeSessionId={sessionId}
            onSelect={selectSession}
            onNew={newSession}
            refreshKey={historyKey}
          />
        </aside>
        <main className="flex-1 min-w-0">
          <ChatInterface
            sessionId={sessionId}
            onFirstMessage={() => setHistoryKey((k) => k + 1)}
            artifacts={artifacts}
            setArtifacts={setArtifacts}
            setActiveArtifactId={setActiveArtifactId}
            setArtifactPanelOpen={setArtifactPanelOpen}
            onOpenHistory={() => setMobileHistoryOpen(true)}
          />
        </main>
        {artifactPanelOpen && artifacts.length > 0 && (
          <aside className="w-[45%] max-w-3xl shrink-0 hidden lg:block">
            <ArtifactPanel
              artifacts={artifacts}
              activeId={activeArtifactId}
              onSelect={setActiveArtifactId}
              onClose={() => setArtifactPanelOpen(false)}
            />
          </aside>
        )}
      </div>

      {/* Mobile: chat history drawer */}
      {mobileHistoryOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileHistoryOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-white shadow-xl flex flex-col">
            <div className="flex justify-end p-2 border-b border-ips-border">
              <button
                onClick={() => setMobileHistoryOpen(false)}
                className="p-1.5 rounded text-ips-charcoal-600 hover:bg-ips-surface"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <ChatHistory
                activeSessionId={sessionId}
                onSelect={selectSession}
                onNew={() => {
                  newSession();
                  setMobileHistoryOpen(false);
                }}
                refreshKey={historyKey}
              />
            </div>
          </div>
        </div>
      )}

      {/* Mobile/tablet: artifacts as a full-screen overlay */}
      {artifactPanelOpen && artifacts.length > 0 && (
        <div className="fixed inset-0 z-50 lg:hidden bg-white">
          <ArtifactPanel
            artifacts={artifacts}
            activeId={activeArtifactId}
            onSelect={setActiveArtifactId}
            onClose={() => setArtifactPanelOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
