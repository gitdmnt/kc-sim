import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
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

const TONE: Record<Tone, string> = {
  info: "border-accent-600/50",
  ok: "border-ok-600/60",
  danger: "border-danger-600/60",
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
              "pointer-events-auto max-w-sm cursor-pointer rounded-md border bg-ink-800 px-3.5 py-2 text-sm text-ink-50 shadow-lg shadow-black/40",
              TONE[t.tone]
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
};
