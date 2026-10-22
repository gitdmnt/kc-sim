import React from "react";
import { cx } from "./cx";

export const Table = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={cx("overflow-auto rounded-lg border border-ink-600", className)}>
    <table className="w-full border-collapse text-sm">{children}</table>
  </div>
);

export const Thead = ({ children }: { children: React.ReactNode }) => (
  <thead className="sticky top-0 bg-ink-800 text-left text-xs text-ink-300">{children}</thead>
);

export const Th = ({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) => (
  <th className={cx("border-b border-ink-600 px-3 py-2 font-medium whitespace-nowrap", className)}>
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
    className={cx(
      "border-b border-ink-700 last:border-0",
      onClick && "cursor-pointer hover:bg-ink-700/60",
      selected && "bg-accent-600/15"
    )}
  >
    {children}
  </tr>
);

export const Td = ({
  children,
  className,
  colSpan,
}: {
  children?: React.ReactNode;
  className?: string;
  colSpan?: number;
}) => (
  <td colSpan={colSpan} className={cx("px-3 py-2 align-middle", className)}>
    {children}
  </td>
);
