"use client";
import { useState } from "react";
import { Database, BookOpen, FileText, Cpu, Landmark, Mail, Calendar, FolderOpen, ChevronDown, ExternalLink } from "lucide-react";

export interface Source {
  type: string;
  tool?: string;
  confidence?: number | null;
  summary?: string | null;
  sql?: string | null;
  tables?: string[] | null;
  items?: { title: string; url: string | null }[] | null;
}

const ICONS: Record<string, any> = {
  database: Database,
  billing_database: Landmark,
  knowledge_base: BookOpen,
  generated_document: FileText,
  computation: Cpu,
  email: Mail,
  calendar: Calendar,
  files: FolderOpen,
};

const LABELS: Record<string, string> = {
  database: "Operational data",
  billing_database: "Billing data",
  knowledge_base: "Knowledge base",
  generated_document: "Generated document",
  computation: "Computation",
  task_system: "Task system",
  email: "Email",
  calendar: "Calendar",
  files: "Files",
  system: "Platform",
};

export default function SourceCitation({ sources }: { sources: Source[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  if (!sources?.length) return null;
  const unique = sources.filter(
    (s, i) => sources.findIndex((x) => x.type === s.type && x.tool === s.tool && x.sql === s.sql) === i
  );

  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-1.5">
        {unique.map((s, i) => {
          const Icon = ICONS[s.type] || Database;
          const hasDetail = !!(s.sql || s.items?.length || s.tables?.length);
          const isOpen = expanded === i;
          return (
            <button
              key={i}
              type="button"
              title={s.summary || s.tool}
              onClick={() => hasDetail && setExpanded(isOpen ? null : i)}
              className={`inline-flex items-center gap-1 text-[11px] bg-ips-steel-soft text-ips-steel px-2 py-0.5 rounded-full ${
                hasDetail ? "cursor-pointer hover:opacity-80" : "cursor-default"
              }`}
            >
              <Icon className="h-3 w-3" />
              {LABELS[s.type] || s.type}
              {typeof s.confidence === "number" && (
                <span className="opacity-70">{Math.round(s.confidence * 100)}%</span>
              )}
              {hasDetail && (
                <ChevronDown className={`h-3 w-3 transition-transform ${isOpen ? "rotate-180" : ""}`} />
              )}
            </button>
          );
        })}
      </div>

      {expanded !== null && unique[expanded] && (
        <div className="mt-1.5 text-[11px] bg-ips-surface border border-ips-border rounded-md p-2 max-w-xl">
          {unique[expanded].tables?.length ? (
            <div className="mb-1">
              <span className="font-semibold text-ips-charcoal-600">Tables: </span>
              {unique[expanded].tables!.map((t, j) => (
                <code key={j} className="bg-white border border-ips-border rounded px-1 py-0.5 mr-1">
                  {t}
                </code>
              ))}
            </div>
          ) : null}
          {unique[expanded].sql ? (
            <pre className="whitespace-pre-wrap break-all bg-white border border-ips-border rounded p-1.5 text-[10.5px] text-ips-charcoal-600 max-h-40 overflow-auto thin-scroll">
              {unique[expanded].sql}
            </pre>
          ) : null}
          {unique[expanded].items?.length ? (
            <ul className="space-y-0.5">
              {unique[expanded].items!.map((it, j) => (
                <li key={j} className="truncate">
                  {it.url ? (
                    <a
                      href={it.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-ips-steel hover:underline"
                    >
                      <ExternalLink className="h-3 w-3 shrink-0" />
                      {it.title}
                    </a>
                  ) : (
                    <span className="text-ips-charcoal-600">{it.title}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}
