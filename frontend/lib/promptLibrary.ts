/**
 * IPS-flavored starter prompts + saved prompts (localStorage).
 */

export interface StarterPrompt {
  title: string;
  prompt: string;
  category: string;
}

export const STARTER_PROMPTS: StarterPrompt[] = [
  {
    title: "What can you do?",
    prompt: "What data and capabilities do you have access to? Give me a quick tour.",
    category: "Getting started",
  },
  {
    title: "Company snapshot",
    prompt: "What services does IPS offer, and what makes each one different? Summarize from our knowledge base.",
    category: "Company",
  },
  {
    title: "Draft a safety toolbox talk",
    prompt: "Draft a 5-minute safety toolbox talk for a hydro excavation crew working near buried utilities.",
    category: "Safety",
  },
  {
    title: "Bid review checklist",
    prompt: "Walk me through your estimating/bid review checklist for an oilfield electrical RFP response.",
    category: "Estimating",
  },
  {
    title: "Billing overview",
    prompt: "Give me a summary of recent invoicing activity — totals, top customers, and anything unpaid.",
    category: "Billing",
  },
  {
    title: "Visualize data",
    prompt: "Create a chart of our data — pick something interesting from the available tables and visualize it.",
    category: "Analysis",
  },
];

const SAVED_KEY = "ips-saved-prompts";

export function getSavedPrompts(): StarterPrompt[] {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) || "[]");
  } catch {
    return [];
  }
}

export function savePrompt(p: StarterPrompt) {
  const all = getSavedPrompts();
  all.unshift(p);
  localStorage.setItem(SAVED_KEY, JSON.stringify(all.slice(0, 50)));
}

export function deleteSavedPrompt(index: number) {
  const all = getSavedPrompts();
  all.splice(index, 1);
  localStorage.setItem(SAVED_KEY, JSON.stringify(all));
}
