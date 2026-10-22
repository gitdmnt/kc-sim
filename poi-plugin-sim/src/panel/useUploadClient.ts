import { useEffect, useState } from "react";
import { UPLOAD_STATE_KEYS, getUploadClient } from "../capture";
import type { RegistrationState } from "../capture";

/** 次に送信できるまでの秒数 (0 = 今すぐ)。1 秒ごとに更新する。 */
export const useUploadWaitSeconds = (): number => {
  const read = () => Math.max(0, Math.ceil((getUploadClient().nextAt() - Date.now()) / 1000));
  const [sec, setSec] = useState(read);
  useEffect(() => {
    const tick = () => setSec(read());
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, []);
  return sec;
};

/** `apiBase` に対する登録状態。もう一方のウィンドウでの登録も storage イベントで拾う。 */
export const useRegistration = (apiBase: string): { state: RegistrationState; refresh: () => void } => {
  const [state, setState] = useState<RegistrationState>(() => getUploadClient().state(apiBase));
  const refresh = () => setState(getUploadClient().state(apiBase));
  useEffect(() => {
    const update = () => setState(getUploadClient().state(apiBase));
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || UPLOAD_STATE_KEYS.includes(e.key)) update();
    };
    update();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [apiBase]);
  return { state, refresh };
};
