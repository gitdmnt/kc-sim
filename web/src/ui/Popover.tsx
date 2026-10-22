import React, { useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import type { ButtonVariant } from "./Button";
import { cx } from "./cx";

interface Props {
  /** 開閉ボタンの中身 */
  label: React.ReactNode;
  title?: string;
  "aria-label"?: string;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  /** 正方形のアイコンボタン (aria-label 必須) */
  icon?: boolean;
  disabled?: boolean;
  /** パネルをボタンの左端 (start) / 右端 (end) に揃える */
  align?: "start" | "end";
  className?: string;
  buttonClassName?: string;
  panelClassName?: string;
  /** 関数なら閉じる関数を受け取る (操作後に閉じるとき) */
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
}

/** 下に足りなければ上に開く高さ */
const MIN_BELOW = 320;

/**
 * ボタンに付くパネル。スクロールする枠の中でも切れないよう fixed で置き、下に余裕が無ければ上に開く。
 * 外側のクリック・Esc・外側のスクロールで閉じる。
 */
export const Popover = ({
  label,
  title,
  variant = "secondary",
  size = "md",
  icon,
  disabled,
  align = "start",
  className,
  buttonClassName,
  panelClassName,
  children,
  ...rest
}: Props) => {
  const [pos, setPos] = useState<React.CSSProperties | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const open = pos !== null;

  const toggle = () => {
    const el = root.current;
    if (open || !el) return setPos(null);
    // poi のプラグインウィンドウでは描画先の window が global と違うことがある
    const win = el.ownerDocument.defaultView ?? window;
    const r = el.getBoundingClientRect();
    const below = win.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const up = below < MIN_BELOW && above > below;
    setPos({
      ...(up ? { bottom: win.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
      ...(align === "end" ? { right: win.innerWidth - r.right } : { left: r.left }),
      maxHeight: up ? above : below,
    });
  };

  useEffect(() => {
    if (!open) return;
    const doc = root.current?.ownerDocument ?? document;
    const inside = (t: EventTarget | null) => t instanceof Node && !!root.current?.contains(t);
    const down = (e: MouseEvent) => !inside(e.target) && setPos(null);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setPos(null);
    const scroll = (e: Event) => !inside(e.target) && setPos(null);
    doc.addEventListener("mousedown", down);
    doc.addEventListener("keydown", key);
    doc.addEventListener("scroll", scroll, true);
    return () => {
      doc.removeEventListener("mousedown", down);
      doc.removeEventListener("keydown", key);
      doc.removeEventListener("scroll", scroll, true);
    };
  }, [open]);

  return (
    <div ref={root} className={cx("relative", className)}>
      <Button
        variant={variant}
        size={size}
        icon={icon}
        disabled={disabled}
        title={title}
        aria-label={rest["aria-label"]}
        aria-expanded={open}
        className={cx(open && "bg-ink-700 text-ink-50", buttonClassName)}
        onClick={toggle}
      >
        {label}
      </Button>
      {pos && (
        <div
          role="dialog"
          style={pos}
          className={cx(
            "fixed z-40 overflow-auto rounded-md border border-ink-700 bg-ink-900 p-4 text-left shadow-2xl shadow-black/60",
            panelClassName
          )}
        >
          {typeof children === "function" ? children(() => setPos(null)) : children}
        </div>
      )}
    </div>
  );
};
