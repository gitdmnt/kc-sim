import type { BadgeTone } from "@web/ui";

export const rankTone = (rank: string | null | undefined): BadgeTone =>
  rank === "SS" || rank === "S" ? "warn" : rank === "A" || rank === "B" ? "accent" : rank ? "danger" : "neutral";

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
