import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { cx } from "./cx";
import { S } from "./strings";

/**
 * ダイアログ表示中は Esc で閉じ、開いた時にフォーカスを移し、閉じたら元の要素へ戻す。
 * window / document はダイアログが置かれた側のものを使う (poi のプラグインウィンドウには、コードが動く
 * メインウィンドウから portal で描かれるため、グローバルの window とは別のことがある)。
 */
const useDialog = (ref: React.RefObject<HTMLElement | null>, onClose: () => void) => {
  useEffect(() => {
    const doc = ref.current?.ownerDocument ?? document;
    const prev = doc.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => prev?.focus?.();
  }, [ref]);
  useEffect(() => {
    const win = ref.current?.ownerDocument.defaultView ?? window;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    win.addEventListener("keydown", h);
    return () => win.removeEventListener("keydown", h);
  }, [ref, onClose]);
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
    className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-ink-300 hover:bg-ink-700 hover:text-ink-50"
  >
    <X size={16} aria-hidden />
  </button>
);

export const Modal = ({ title, onClose, footer, className, children }: Props) => {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/75 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          "flex max-h-[90vh] w-full outline-none max-w-2xl flex-col rounded-md border border-ink-700 bg-ink-900 shadow-2xl shadow-black/60",
          className
        )}
      >
        <header className="flex items-center justify-between px-4 pt-4 pb-2">
          <h2 className="text-base font-semibold text-ink-50">{title}</h2>
          <CloseButton onClose={onClose} />
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer && (
          <footer className="flex items-center justify-end gap-2 px-4 pt-2 pb-4">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
};

export const Drawer = ({ title, onClose, className, children }: Omit<Props, "footer">) => {
  const ref = useRef<HTMLElement>(null);
  useDialog(ref, onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-ink-950/65 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <aside
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          "flex h-full w-full outline-none max-w-xl flex-col bg-ink-900 shadow-2xl shadow-black/60",
          className
        )}
      >
        <header className="flex items-center justify-between px-4 pt-4 pb-2">
          <h2 className="text-base font-semibold text-ink-50">{title}</h2>
          <CloseButton onClose={onClose} />
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
      </aside>
    </div>
  );
};
