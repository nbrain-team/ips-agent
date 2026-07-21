"use client";
import { CheckCircle2, Circle, Loader2, ListChecks } from "lucide-react";

export interface PlanStep {
  tool: string;
  description: string;
  status?: "pending" | "running" | "done" | "error";
}

export interface Plan {
  mode?: string;
  goal?: string;
  steps: PlanStep[];
}

export default function PlanDisplay({ plan }: { plan: Plan }) {
  if (!plan?.steps?.length) return null;
  return (
    <div className="border border-ips-border rounded-lg bg-ips-surface p-3 my-2 text-sm">
      <div className="flex items-center gap-2 font-medium text-ips-charcoal mb-2">
        <ListChecks className="h-4 w-4 text-ips-steel" />
        {plan.mode === "deep_research" ? "Deep research plan" : "Execution plan"}
      </div>
      <ol className="space-y-1.5">
        {plan.steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2">
            {s.status === "done" ? (
              <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
            ) : s.status === "running" ? (
              <Loader2 className="h-4 w-4 text-ips-steel animate-spin mt-0.5 shrink-0" />
            ) : (
              <Circle className="h-4 w-4 text-gray-300 mt-0.5 shrink-0" />
            )}
            <span className="text-ips-charcoal-600">
              {s.description || s.tool}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
