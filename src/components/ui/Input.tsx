import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

const field =
  "w-full h-10 px-3 rounded-theme border border-border bg-surface text-text placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-ring";
/**
 * A date or time field is drawn by the browser, and it picks its colours from `color-scheme` rather than from ours.
 * The album is a light page, so say so: without it a browser in dark mode renders the calendar, and the text in the
 * field, near-black on its own near-black background.
 */
const nativePicker = "[color-scheme:light]";

export function Input({ className = "", type, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const dated = type === "date" || type === "datetime-local" || type === "time" || type === "month" || type === "week";
  return <input type={type} className={`${field} ${dated ? nativePicker : ""} ${className}`} {...props} />;
}

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${field} ${className}`} {...props} />;
}

export function Textarea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${field} h-auto py-2 ${className}`} {...props} />;
}

export function Label({ children, htmlFor, className = "" }: { children: React.ReactNode; htmlFor?: string; className?: string }) {
  return (
    <label htmlFor={htmlFor} className={`block text-sm font-medium text-text mb-1 ${className}`}>
      {children}
    </label>
  );
}

export function FieldError({ children }: { children?: string | null }) {
  if (!children) return null;
  return <p className="text-sm text-red-600 mt-1">{children}</p>;
}
