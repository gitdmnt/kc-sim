import React from "react";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
}

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-accent-500 text-ink-950 font-semibold hover:bg-accent-400 border border-accent-400/60 shadow-[0_0_0_1px_rgb(43_179_200/0.15),0_4px_14px_-4px_rgb(43_179_200/0.5)]",
  secondary: "bg-ink-700/70 text-ink-50 hover:bg-ink-600 hover:border-ink-500 border border-ink-600",
  ghost: "text-ink-200 hover:bg-ink-700/70 hover:text-ink-50 border border-transparent",
  danger: "bg-transparent text-danger-400 hover:bg-danger-600/20 border border-danger-600/50",
};

export const Button = ({ variant = "secondary", size = "md", className, type, ...rest }: Props) => (
  <button
    type={type ?? "button"}
    className={cx(
      "inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors",
      "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-400",
      "disabled:pointer-events-none disabled:opacity-40",
      size === "sm" ? "h-7 px-2.5 text-[13px]" : size === "lg" ? "h-10 px-5 text-[15px]" : "h-8 px-3 text-sm",
      VARIANT[variant],
      className
    )}
    {...rest}
  />
);
