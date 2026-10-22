import React from "react";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** sm 28px / md 32px / lg 40px。`icon` は正方形 (中身はアイコン 1 つ、aria-label 必須) */
  size?: "sm" | "md" | "lg";
  icon?: boolean;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent-500 text-ink-950 font-semibold hover:bg-accent-400",
  secondary: "bg-ink-800 text-ink-100 hover:bg-ink-700",
  ghost: "text-ink-300 hover:bg-ink-800 hover:text-ink-50",
  danger: "text-danger-400 hover:bg-danger-600/20",
};

const SIZE = { sm: "h-7 text-sm", md: "h-8 text-sm", lg: "h-10 text-base" };
const PAD = { sm: "px-2", md: "px-3", lg: "px-4" };
const SQUARE = { sm: "w-7", md: "w-8", lg: "w-10" };

export const Button = ({ variant = "secondary", size = "md", icon, className, type, ...rest }: Props) => (
  <button
    type={type ?? "button"}
    className={cx(
      "inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-1 rounded-md font-medium whitespace-nowrap transition-colors",
      "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-400",
      "disabled:pointer-events-none disabled:opacity-40",
      SIZE[size],
      icon ? SQUARE[size] : PAD[size],
      VARIANT[variant],
      className
    )}
    {...rest}
  />
);
