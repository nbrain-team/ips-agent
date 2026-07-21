"use client";
import { useState, useEffect } from "react";
import { BookMarked, X } from "lucide-react";
import { STARTER_PROMPTS, getSavedPrompts, type StarterPrompt } from "@/lib/promptLibrary";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export default function PromptLibrary({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (prompt: string) => void;
}) {
  const [saved, setSaved] = useState<StarterPrompt[]>([]);
  useEffect(() => {
    if (open) setSaved(getSavedPrompts());
  }, [open]);

  if (!open) return null;
  const all = [...saved, ...STARTER_PROMPTS];

  return (
    <div className="absolute bottom-full mb-2 left-0 right-0 max-h-96 overflow-y-auto thin-scroll bg-white border border-ips-border rounded-lg shadow-lg z-20">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-ips-border sticky top-0 bg-white">
        <BookMarked className="h-4 w-4 text-ips-red" />
        <span className="text-sm font-medium flex-1">Prompt library</span>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="p-2 grid gap-1.5">
        {all.map((p, i) => (
          <button
            key={i}
            onClick={() => {
              onSelect(p.prompt);
              onClose();
            }}
            className="text-left p-2.5 rounded-md hover:bg-ips-surface border border-transparent hover:border-ips-border transition-colors"
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{p.title}</span>
              <Badge variant="outline">{p.category}</Badge>
            </div>
            <p className="text-xs text-ips-charcoal-600 mt-0.5 line-clamp-2">{p.prompt}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
