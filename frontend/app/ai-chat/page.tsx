"use client";
import { useCallback, useEffect, useState } from "react";
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

  // On mount: resume latest session or create one
  useEffect(() => {
    (async () => {
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

  return (
    <div className="flex flex-col h-screen">
      <Header />
      <div className="flex flex-1 min-h-0">
        <aside className="w-64 shrink-0 hidden md:block">
          <ChatHistory
            activeSessionId={sessionId}
            onSelect={(id) => {
              setSessionId(id);
              setArtifactPanelOpen(false);
            }}
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
    </div>
  );
}
