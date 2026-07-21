"use client";
import { useEffect, useState } from "react";
import Header from "@/components/layout/Header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Database, BookOpen, Brain, Landmark } from "lucide-react";

interface Inventory {
  data_tables: { table_name: string; source_tag: string; row_count: number; description: string; updated_at: string }[];
  knowledge_base: { category: string; source: string; chunks: number }[];
  memories: number;
  billing_database_connected: boolean;
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

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 max-w-5xl w-full mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-ips-charcoal">What the agent knows</h1>
          <p className="text-sm text-ips-charcoal-600 mt-1">
            Live inventory of the data sources, tables, and knowledge available to the IPS AI Brain.
          </p>
        </div>
        {error && <p className="text-sm text-ips-red">{error}</p>}

        <div className="grid md:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center gap-2">
              <Database className="h-4 w-4 text-ips-red" />
              <CardTitle className="text-sm">Operational tables</CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-semibold">{primaryTables.length}</CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center gap-2">
              <Landmark className="h-4 w-4 text-ips-steel" />
              <CardTitle className="text-sm">Billing tables</CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-semibold">
              {billingTables.length}
              {!inv?.billing_database_connected && (
                <span className="block text-xs font-normal text-gray-400 mt-1">billing DB not connected</span>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center gap-2">
              <Brain className="h-4 w-4 text-ips-red" />
              <CardTitle className="text-sm">Long-term memories</CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-semibold">{inv?.memories ?? "—"}</CardContent>
          </Card>
        </div>

        {[
          { label: "Operational database", tables: primaryTables },
          { label: "Billing database (read-only)", tables: billingTables },
        ].map(
          ({ label, tables }) =>
            tables.length > 0 && (
              <Card key={label}>
                <CardHeader>
                  <CardTitle className="text-sm">{label}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {tables.map((t) => (
                      <div key={t.table_name} className="flex items-start gap-3 border-b border-ips-border pb-2 last:border-0">
                        <code className="text-xs bg-ips-surface px-1.5 py-0.5 rounded shrink-0">{t.table_name}</code>
                        <span className="text-xs text-ips-charcoal-600 flex-1">{t.description?.slice(0, 180)}</span>
                        <Badge variant="outline">{Number(t.row_count).toLocaleString()} rows</Badge>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )
        )}

        <Card>
          <CardHeader className="flex flex-row items-center gap-2">
            <BookOpen className="h-4 w-4 text-ips-steel" />
            <CardTitle className="text-sm">Knowledge base</CardTitle>
          </CardHeader>
          <CardContent>
            {inv?.knowledge_base.length ? (
              <div className="flex flex-wrap gap-2">
                {inv.knowledge_base.map((k, i) => (
                  <Badge key={i} variant="steel">
                    {k.category} · {k.source} · {k.chunks} chunks
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-400">
                No knowledge ingested yet — run the website crawl (`npm run crawl`) or ingest documents.
              </p>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
