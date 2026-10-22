import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Info } from "lucide-react";
import { cx } from "./cx";

type Tone = "info" | "ok" | "danger";
interface ToastItem {
  id: number;
  tone: Tone;
  message: string;
}
interface ToastApi {
  push: (message: string, tone?: Tone) => void;
}

const Ctx = createContext<ToastApi>({ push: () => {} });
export const useToast = () => useContext(Ctx);

/** 状態はアイコンの形と色で示す (枠の色では示さない) */
const ICON: Record<Tone, React.ReactNode> = {
  info: <Info size={16} className="shrink-0 text-accent-400" aria-hidden />,
  ok: <CircleCheck size={16} className="shrink-0 text-ok-400" aria-hidden />,
  danger: <CircleAlert size={16} className="shrink-0 text-danger-400" aria-hidden />,
};

export const ToastProvider = ({ children }: { children: React.ReactNode }) => {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const set = timers.current;
    return () => set.forEach(clearTimeout);
  }, []);

  const push = useCallback((message: string, tone: Tone = "info") => {
    const id = ++seq.current;
    setItems((prev) => [...prev, { id, tone, message }]);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
    timers.current.add(timer);
  }, []);

  return (
    <Ctx.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex flex-col items-end gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
            className={cx(
              "pointer-events-auto flex max-w-sm cursor-pointer items-center gap-2 rounded-md border border-ink-700 bg-ink-800 px-3 py-2 text-sm text-ink-50 shadow-xl shadow-black/50"
            )}
          >
            {ICON[t.tone]}
            {t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
};
