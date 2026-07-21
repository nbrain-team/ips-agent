"use client";
import { useEffect, useState } from "react";
import Header from "@/components/layout/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Database, BookOpen, Brain, Landmark, Mail, Clock } from "lucide-react";

interface DataTable {
  table_name: string;
  source_tag: string;
  row_count: number;
  column_count: number | null;
  description: string;
  data_from: string | null;
  data_through: string | null;
  date_column: string | null;
  updated_at: string;
}

interface Inventory {
  data_tables: DataTable[];
  knowledge_base: { category: string; source: string; chunks: number; last_updated: string | null }[];
  memories: { count: number; last_updated: string | null };
  emails: {
    mailboxes: number;
    mailboxes_total: number;
    last_synced: string | null;
    messages: number;
    latest_message: string | null;
  };
  billing_database_connected: boolean;
  summary: {
    primary_tables: number;
    primary_rows: number;
    primary_data_through: string | null;
    primary_profiled_at: string | null;
    billing_tables: number;
    billing_rows: number;
    billing_data_through: string | null;
    billing_profiled_at: string | null;
    knowledge_chunks: number;
    knowledge_last_updated: string | null;
  };
}

function fmtDate(d: string | null | undefined) {
  if (!d) return "—";
  const date = new Date(d);
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtAgo(d: string | null | undefined) {
  if (!d) return "never";
  const ms = Date.now() - new Date(d).getTime();
  if (isNaN(ms)) return "never";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? "s" : ""} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days > 1 ? "s" : ""} ago`;
}

function Freshness({ label, date }: { label: string; date: string | null | undefined }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-ips-charcoal-600">
      <Clock className="h-3 w-3" />
      {label}: <strong className="font-medium">{fmtAgo(date)}</strong>
    </span>
  );
}

export default function DataPage() {
  const [inv, setInv] = useState<Inventory | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/data-inventory", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed to load"))))
      .then(setInv)
      .catch((e) => setError(e.message));
  }, []);

  const primaryTables = inv?.data_tables.filter((t) => t.source_tag === "primary") || [];
  const billingTables = inv?.data_tables.filter((t) => t.source_tag === "billing") || [];
  const s = inv?.summary;

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 max-w-6xl w-full mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-ips-charcoal">What the agent knows</h1>
          <p className="text-sm text-ips-charcoal-600 mt-1">
            Live inventory of every data source the IPS AI Brain can answer from — with depth and freshness.
          </p>
        </div>
        {error && <p className="text-sm text-ips-red">{error}</p>}

        {/* Summary cards */}
        <div className="grid md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center gap-2">
              <Database className="h-4 w-4 text-ips-red" />
              <CardTitle className="text-sm">Operational database</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-semibold">{s?.primary_tables ?? "—"}</div>
              <div className="text-xs text-ips-charcoal-600 mt-1">
                tables · {s ? Number(s.primary_rows).toLocaleString() : "—"} rows
              </div>
              <div className="mt-2 space-y-0.5 flex flex-col">
                <Freshness label="Data through" date={s?.primary_data_through} />
                <Freshness label="Profiled" date={s?.primary_profiled_at} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center gap-2">
              <Landmark className="h-4 w-4 text-ips-steel" />
              <CardTitle className="text-sm">Billing database</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-semibold">{s?.billing_tables ?? "—"}</div>
              <div className="text-xs text-ips-charcoal-600 mt-1">
                tables · {s ? Number(s.billing_rows).toLocaleString() : "—"} rows
                {!inv?.billing_database_connected && " · not connected"}
              </div>
              <div className="mt-2 space-y-0.5 flex flex-col">
                <Freshness label="Data through" date={s?.billing_data_through} />
                <Freshness label="Profiled" date={s?.billing_profiled_at} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center gap-2">
              <Mail className="h-4 w-4 text-ips-steel" />
              <CardTitle className="text-sm">Microsoft 365 email</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-semibold">{inv?.emails?.messages?.toLocaleString() ?? "—"}</div>
              <div className="text-xs text-ips-charcoal-600 mt-1">
                emails · {inv?.emails?.mailboxes ?? 0} of {inv?.emails?.mailboxes_total ?? 0} mailboxes · 30-day window
              </div>
              <div className="mt-2 space-y-0.5 flex flex-col">
                <Freshness label="Last synced" date={inv?.emails?.last_synced} />
                <Freshness label="Newest email" date={inv?.emails?.latest_message} />
              </div>
              <p className="text-[10px] text-gray-400 mt-1.5">Scoped to your mailbox unless you&apos;re an admin.</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center gap-2">
              <BookOpen className="h-4 w-4 text-ips-red" />
              <CardTitle className="text-sm">Knowledge &amp; memory</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-semibold">{s?.knowledge_chunks?.toLocaleString() ?? "—"}</div>
              <div className="text-xs text-ips-charcoal-600 mt-1">
                document chunks · {inv?.memories?.count ?? 0} memories
              </div>
              <div className="mt-2 space-y-0.5 flex flex-col">
                <Freshness label="Docs updated" date={s?.knowledge_last_updated} />
                <Freshness label="Memory updated" date={inv?.memories?.last_updated} />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Table detail — both databases */}
        {[
          { label: "Operational database (Postgres)", tables: primaryTables },
          { label: "Billing database (Postgres, read-only)", tables: billingTables },
        ].map(
          ({ label, tables }) =>
            tables.length > 0 && (
              <Card key={label}>
                <CardHeader>
                  <CardTitle className="text-sm">{label}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2.5">
                    {tables.map((t) => (
                      <div key={t.table_name} className="flex items-start gap-3 border-b border-ips-border pb-2.5 last:border-0 last:pb-0">
                        <code className="text-xs bg-ips-surface px-1.5 py-0.5 rounded shrink-0 mt-0.5">{t.table_name}</code>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-ips-charcoal-600">{t.description?.slice(0, 200)}</p>
                          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[11px] text-gray-500">
                            {t.column_count != null && <span>{t.column_count} columns</span>}
                            {t.data_from && t.data_through && (
                              <span>
                                data {fmtDate(t.data_from)} → <strong className="text-ips-charcoal">{fmtDate(t.data_through)}</strong>
                              </span>
                            )}
                            <span>profiled {fmtAgo(t.updated_at)}</span>
                          </div>
                        </div>
                        <Badge variant="outline" className="shrink-0">
                          {Number(t.row_count).toLocaleString()} rows
                        </Badge>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )
        )}

        {/* Knowledge base detail */}
        <Card>
          <CardHeader className="flex flex-row items-center gap-2">
            <BookOpen className="h-4 w-4 text-ips-steel" />
            <CardTitle className="text-sm">Knowledge base — documents &amp; website content</CardTitle>
          </CardHeader>
          <CardContent>
            {inv?.knowledge_base.length ? (
              <div className="space-y-2">
                {inv.knowledge_base.map((k, i) => (
                  <div key={i} className="flex items-center gap-3 border-b border-ips-border pb-2 last:border-0 last:pb-0">
                    <Badge variant="steel" className="shrink-0">{k.category}</Badge>
                    <span className="text-xs text-ips-charcoal-600 flex-1 truncate">{k.source}</span>
                    <span className="text-[11px] text-gray-500 shrink-0">updated {fmtAgo(k.last_updated)}</span>
                    <Badge variant="outline" className="shrink-0">{k.chunks} chunks</Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-400">
                No knowledge ingested yet — run the website crawl (`npm run crawl`) or ingest documents.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Long-term memory */}
        <Card>
          <CardHeader className="flex flex-row items-center gap-2">
            <Brain className="h-4 w-4 text-ips-red" />
            <CardTitle className="text-sm">Long-term memory</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-ips-charcoal-600">
            {inv?.memories?.count
              ? `${inv.memories.count} durable memories learned from conversations · last added ${fmtAgo(inv.memories.last_updated)}`
              : "No long-term memories yet — the agent learns facts and preferences as people chat with it."}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
