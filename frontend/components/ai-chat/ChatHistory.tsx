"use client";
import { useEffect, useState, useCallback } from "react";
import { Plus, Search, Trash2, Pencil, Archive, Folder, FolderInput, MessageSquare, Share2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface ChatSession {
  id: number;
  title: string;
  folder: string | null;
  tags: string[];
  visibility: string;
  updated_at: string;
}

export default function ChatHistory({
  activeSessionId,
  onSelect,
  onNew,
  refreshKey,
}: {
  activeSessionId: number | null;
  onSelect: (id: number) => void;
  onNew: () => void;
  refreshKey: number;
}) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [search, setSearch] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [sharedCopiedId, setSharedCopiedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const params = search ? `?search=${encodeURIComponent(search)}` : "";
    const res = await fetch(`/api/agent-chat/sessions${params}`, { credentials: "include" });
    if (res.ok) setSessions(await res.json());
  }, [search]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function deleteSession(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("Delete this chat permanently?")) return;
    await fetch(`/api/agent-chat/sessions/${id}`, { method: "DELETE", credentials: "include" });
    load();
    if (id === activeSessionId) onNew();
  }

  async function archiveSession(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    await fetch(`/api/agent-chat/sessions/${id}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_archived: true }),
    });
    load();
  }

  // Share = mark the session visible to other logged-in IPS users and copy a
  // direct link. Clicking again on a shared chat makes it private.
  async function toggleShare(s: ChatSession, e: React.MouseEvent) {
    e.stopPropagation();
    const makeShared = s.visibility !== "shared";
    await fetch(`/api/agent-chat/sessions/${s.id}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: makeShared ? "shared" : "private" }),
    });
    if (makeShared) {
      try {
        await navigator.clipboard.writeText(`${window.location.origin}/ai-chat?session=${s.id}`);
        setSharedCopiedId(s.id);
        setTimeout(() => setSharedCopiedId(null), 2000);
      } catch {
        /* clipboard unavailable */
      }
    }
    load();
  }

  async function moveToFolder(s: ChatSession, e: React.MouseEvent) {
    e.stopPropagation();
    const folder = window.prompt("Move to folder (leave empty to remove from folder):", s.folder || "");
    if (folder === null) return;
    await fetch(`/api/agent-chat/sessions/${s.id}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: folder.trim() || null }),
    });
    load();
  }

  async function commitRename(id: number) {
    if (renameValue.trim()) {
      await fetch(`/api/agent-chat/sessions/${id}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: renameValue.trim() }),
      });
    }
    setRenamingId(null);
    load();
  }

  // Group by folder
  const grouped = sessions.reduce<Record<string, ChatSession[]>>((acc, s) => {
    const key = s.folder || "";
    (acc[key] = acc[key] || []).push(s);
    return acc;
  }, {});

  return (
    <div className="flex flex-col h-full bg-white border-r border-ips-border">
      <div className="p-3 space-y-2 shrink-0 border-b border-ips-border">
        <Button className="w-full" onClick={onNew}>
          <Plus className="h-4 w-4" /> New chat
        </Button>
        <div className="relative">
          <Search className="h-4 w-4 absolute left-2.5 top-3 text-gray-400" />
          <Input
            placeholder="Search chats…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-9"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto thin-scroll p-2">
        {Object.entries(grouped).map(([folder, list]) => (
          <div key={folder || "root"}>
            {folder && (
              <div className="flex items-center gap-1.5 px-2 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ips-charcoal-600">
                <Folder className="h-3 w-3" /> {folder}
              </div>
            )}
            {list.map((s) => (
              <div
                key={s.id}
                onClick={() => onSelect(s.id)}
                className={cn(
                  "group flex items-center gap-2 px-2 py-2 rounded-md cursor-pointer text-sm",
                  s.id === activeSessionId
                    ? "bg-ips-red-soft text-ips-red-dark font-medium"
                    : "hover:bg-ips-surface text-ips-charcoal"
                )}
              >
                <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-60" />
                {renamingId === s.id ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => commitRename(s.id)}
                    onKeyDown={(e) => e.key === "Enter" && commitRename(s.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="flex-1 text-sm border border-ips-border rounded px-1 py-0.5"
                  />
                ) : (
                  <span className="flex-1 truncate">{s.title}</span>
                )}
                {s.visibility === "shared" && <Share2 className="h-3 w-3 text-ips-steel shrink-0" />}
                <span className="hidden group-hover:flex items-center gap-0.5 shrink-0">
                  <button
                    className="p-1 hover:text-ips-steel"
                    title="Rename"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenamingId(s.id);
                      setRenameValue(s.title);
                    }}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    className="p-1 hover:text-ips-steel"
                    title={s.visibility === "shared" ? "Stop sharing" : "Share with team (copies link)"}
                    onClick={(e) => toggleShare(s, e)}
                  >
                    {sharedCopiedId === s.id ? <Check className="h-3 w-3 text-green-600" /> : <Share2 className="h-3 w-3" />}
                  </button>
                  <button className="p-1 hover:text-ips-steel" title="Move to folder" onClick={(e) => moveToFolder(s, e)}>
                    <FolderInput className="h-3 w-3" />
                  </button>
                  <button className="p-1 hover:text-ips-steel" title="Archive" onClick={(e) => archiveSession(s.id, e)}>
                    <Archive className="h-3 w-3" />
                  </button>
                </span>
                <button
                  className="p-1 text-gray-400 hover:text-ips-red shrink-0"
                  title="Delete"
                  onClick={(e) => deleteSession(s.id, e)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        ))}
        {!sessions.length && (
          <p className="text-xs text-gray-400 text-center mt-8">No chats yet — start one above.</p>
        )}
      </div>
    </div>
  );
}
