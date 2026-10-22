import React from "react";
import { cx } from "./cx";

/** 表。数値列は右揃え (`Td className="text-right tabular-nums"`)、行の区切りは hairline だけ。 */
export const Table = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={cx("overflow-auto", className)}>
    <table className="w-full border-collapse text-sm">{children}</table>
  </div>
);

export const Thead = ({ children }: { children: React.ReactNode }) => (
  <thead className="sticky top-0 bg-ink-900 text-left text-xs text-ink-400">{children}</thead>
);

export const Th = ({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) => (
  <th className={cx("border-b border-ink-800 px-2 py-1 font-medium whitespace-nowrap", className)}>
    {children}
  </th>
);

export const Tr = ({
  children,
  onClick,
  selected,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  selected?: boolean;
}) => (
  <tr
    onClick={onClick}
    aria-selected={selected}
    className={cx(
      "border-b border-ink-800 last:border-0",
      onClick && "cursor-pointer hover:bg-ink-800",
      selected && "bg-accent-500/12"
    )}
  >
    {children}
  </tr>
);

export const Td = ({
  children,
  className,
  colSpan,
  title,
}: {
  children?: React.ReactNode;
  className?: string;
  colSpan?: number;
  title?: string;
}) => (
  <td colSpan={colSpan} title={title} className={cx("px-2 py-1 align-middle", className)}>
    {children}
  </td>
);
