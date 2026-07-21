import * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "secondary" | "outline" | "steel";

const variants: Record<Variant, string> = {
  default: "bg-ips-red-soft text-ips-red-dark",
  secondary: "bg-ips-charcoal text-white",
  outline: "border border-ips-border text-ips-charcoal-600",
  steel: "bg-ips-steel-soft text-ips-steel",
};

export function Badge({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: Variant }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        variants[variant],
        className
      )}
      {...props}
    />
  );
}
