import type { BadgeTone } from "../../ui";

export const rankTone = (rank: string | null | undefined): BadgeTone =>
  rank === "SS" || rank === "S" ? "warn" : rank === "A" || rank === "B" ? "accent" : rank ? "danger" : "neutral";

export const formatDateTime = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** 一覧用: 月/日 時:分 */
export const formatShortDateTime = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const downloadText = (filename: string, text: string, mime = "application/json") => {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

