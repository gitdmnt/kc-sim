/** 判定の文字色 (勝敗の段階だけを表す。ランクのトークン色) */
export const RANK_TEXT: Record<string, string> = {
  SS: "text-rank-ss",
  S: "text-rank-s",
  A: "text-rank-a",
  B: "text-rank-b",
  C: "text-rank-c",
  D: "text-rank-d",
  E: "text-rank-e",
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
