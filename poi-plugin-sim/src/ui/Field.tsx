import React from "react";
import { cx, defaultWidth } from "./cx";

const CONTROL =
  "h-8 rounded-md border border-ink-600 bg-ink-900 px-2.5 text-sm text-ink-50 placeholder:text-ink-400 " +
  "hover:border-ink-500 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500/60 disabled:opacity-50";

export const TextInput = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...rest }, ref) => (
  <input ref={ref} className={cx(CONTROL, defaultWidth(className), className)} {...rest} />
));

export const Textarea = ({
  className,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea className={cx(CONTROL, defaultWidth(className), "h-auto min-h-24 py-2 font-mono text-xs", className)} {...rest} />
);

export const Select = ({
  className,
  children,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement>) => (
  <select className={cx(CONTROL, defaultWidth(className), "cursor-pointer pr-6", className)} {...rest}>
    {children}
  </select>
);

export const Checkbox = ({
  label,
  hint,
  className,
  ...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & { label: string; hint?: string }) => (
  <label className={cx("flex cursor-pointer items-start gap-2.5", className)}>
    <input type="checkbox" className="mt-1 h-4 w-4 cursor-pointer accent-accent-500" {...rest} />
    <span>
      <span className="block text-sm text-ink-100">{label}</span>
      {hint && <span className="block text-xs text-ink-400">{hint}</span>}
    </span>
  </label>
);

export const Field = ({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) => (
  <label className={cx("flex min-w-0 flex-col gap-1", className)}>
    <span className="text-xs font-medium text-ink-300">{label}</span>
    {children}
    {hint && <span className="text-xs text-ink-400">{hint}</span>}
  </label>
);
