import type { Confidence } from "@shared/data/types";
import type { BadgeTone } from "../../ui";

/** 推定値の確度の表示 (実測 / 推定 / 仮)。 */
export const CONFIDENCE: Record<Confidence | "none", { label: string; tone: BadgeTone; className: string }> = {
  observed: { label: "実測", tone: "ok", className: "text-ink-400" },
  datamined: { label: "実測", tone: "ok", className: "text-ink-400" },
  db_estimate: { label: "推定", tone: "warn", className: "text-warn-400" },
  placeholder: { label: "仮", tone: "danger", className: "text-danger-400" },
  unknown: { label: "—", tone: "neutral", className: "text-ink-500" },
  none: { label: "—", tone: "neutral", className: "text-ink-500" },
};
