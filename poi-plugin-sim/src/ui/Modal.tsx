import React, { useEffect, useRef } from "react";
import { cx } from "./cx";
import { S } from "./strings";

/** ダイアログ表示中は Esc で閉じ、開いた時にフォーカスを移し、閉じたら元の要素へ戻す。 */
const useDialogFocus = (ref: React.RefObject<HTMLElement | null>) => {
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => prev?.focus?.();
  }, [ref]);
};

const useEscape = (onClose: () => void) => {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
};

interface Props {
  title: string;
  onClose: () => void;
  footer?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

const CloseButton = ({ onClose }: { onClose: () => void }) => (
  <button
    type="button"
    aria-label={S.common.close}
    onClick={onClose}
    className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-ink-300 hover:bg-ink-700 hover:text-ink-50"
  >
    ✕
  </button>
);

export const Modal = ({ title, onClose, footer, className, children }: Props) => {
  useEscape(onClose);
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          "flex max-h-[90vh] w-full outline-none max-w-2xl flex-col rounded-lg border border-ink-500 bg-ink-800 shadow-2xl shadow-black/60",
          className
        )}
      >
        <header className="flex items-center justify-between border-b border-ink-600 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-50">{title}</h2>
          <CloseButton onClose={onClose} />
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-ink-600 px-4 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
};

export const Drawer = ({ title, onClose, className, children }: Omit<Props, "footer">) => {
  useEscape(onClose);
  const ref = useRef<HTMLElement>(null);
  useDialogFocus(ref);
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/50"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <aside
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          "flex h-full w-full outline-none max-w-xl flex-col border-l border-ink-500 bg-ink-800 shadow-2xl shadow-black/60",
          className
        )}
      >
        <header className="flex items-center justify-between border-b border-ink-600 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-50">{title}</h2>
          <CloseButton onClose={onClose} />
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
      </aside>
    </div>
  );
};
