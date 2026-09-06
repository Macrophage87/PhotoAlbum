import type { ReactNode } from "react";

const tones = {
  neutral: "bg-surface-alt text-muted",
  primary: "bg-primary/10 text-primary",
  accent: "bg-accent/15 text-text",
  success: "bg-emerald-100 text-emerald-800",
  warning: "bg-amber-100 text-amber-800",
  danger: "bg-red-100 text-red-800",
};

export function Badge({ children, tone = "neutral", className = "" }: { children: ReactNode; tone?: keyof typeof tones; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]} ${className}`}>
      {children}
    </span>
  );
}
