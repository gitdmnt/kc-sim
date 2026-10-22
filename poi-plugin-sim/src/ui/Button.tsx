import React from "react";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent-600 text-white hover:bg-accent-500 border border-accent-500/40",
  secondary: "bg-ink-700 text-ink-50 hover:bg-ink-600 border border-ink-500",
  ghost: "text-ink-200 hover:bg-ink-700 hover:text-ink-50 border border-transparent",
  danger: "bg-danger-600/15 text-danger-400 hover:bg-danger-600/30 border border-danger-600/40",
};

export const Button = ({ variant = "secondary", size = "md", className, type, ...rest }: Props) => (
  <button
    type={type ?? "button"}
    className={cx(
      "inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors",
      "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-400",
      "disabled:pointer-events-none disabled:opacity-40",
      size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm",
      VARIANT[variant],
      className
    )}
    {...rest}
  />
);
