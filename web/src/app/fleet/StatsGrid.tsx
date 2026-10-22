import React from "react";
import { resolveShipStats, sumEquipStats } from "../../fleet";
import type { PresetShip, StatKey } from "../../fleet";
import { Stat, S } from "../../ui";
import { useApp } from "../context";

const ORDER: StatKey[] = [
  "maxHp", "firepower", "torpedo", "antiAir", "armor", "evasion",
  "asw", "los", "luck", "range", "speed",
];

const formatValue = (key: StatKey, v: number | null): string => {
  if (v === null) return "—";
  if (key === "range") return S.range[v] ?? String(v);
  if (key === "speed") return S.speeds[v] ?? String(v);
  return String(v);
};

export const StatsGrid = ({ ship }: { ship: PresetShip }) => {
  const { catalog } = useApp();
  const stats = resolveShipStats(ship, catalog.master);
  const accuracy = sumEquipStats(ship, catalog.master).accuracy;
  // 出典は艦単位の既定 (実測あり→実測、なし→計算) と異なるセルだけ sub で示す
  const base = ship.observed ? "observed" : "computed";
  return (
    <div className="grid grid-cols-4 gap-3 sm:grid-cols-6">
      {ORDER.map((key) => {
        const r = stats[key];
        return (
          <Stat
            key={key}
            label={S.stat[key]}
            value={formatValue(key, r.value)}
            sub={r.source !== base && r.source !== "unknown" ? S.source[r.source] : undefined}
            subTone={r.source === "observed" ? "ok" : "accent"}
            title={
              r.source === "unknown"
                ? "マスターデータに値が無く、実測も無いため算出できません"
                : r.source === "computed"
                  ? "マスターデータからの計算値 (近代化・固有ボーナス除く)"
                  : "ゲーム内で取得した実測値"
            }
          />
        );
      })}
      <Stat label="命中" value={accuracy} title="装備の命中合計" />
    </div>
  );
};
