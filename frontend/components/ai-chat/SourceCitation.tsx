"use client";
import { Database, BookOpen, FileText, Cpu, Landmark } from "lucide-react";

export interface Source {
  type: string;
  tool?: string;
  confidence?: number | null;
  summary?: string | null;
}

const ICONS: Record<string, any> = {
  database: Database,
  billing_database: Landmark,
  knowledge_base: BookOpen,
  generated_document: FileText,
  computation: Cpu,
};

const LABELS: Record<string, string> = {
  database: "Operational data",
  billing_database: "Billing data",
  knowledge_base: "Knowledge base",
  generated_document: "Generated document",
  computation: "Computation",
  task_system: "Task system",
};

export default function SourceCitation({ sources }: { sources: Source[] }) {
  if (!sources?.length) return null;
  const unique = sources.filter(
    (s, i) => sources.findIndex((x) => x.type === s.type && x.tool === s.tool) === i
  );
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {unique.map((s, i) => {
        const Icon = ICONS[s.type] || Database;
        return (
          <span
            key={i}
            title={s.summary || s.tool}
            className="inline-flex items-center gap-1 text-[11px] bg-ips-steel-soft text-ips-steel px-2 py-0.5 rounded-full"
          >
            <Icon className="h-3 w-3" />
            {LABELS[s.type] || s.type}
            {typeof s.confidence === "number" && (
              <span className="opacity-70">{Math.round(s.confidence * 100)}%</span>
            )}
          </span>
        );
      })}
    </div>
  );
}
