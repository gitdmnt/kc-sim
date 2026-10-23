import React from "react";
import type { Advance, Maelstrom, ResourceAmounts } from "@sim-core";
import type { MapNode } from "@shared/data/types";
import { isBalloonNode } from "@shared/sim/nodeEffects";
import type { NodeEffect } from "../../../sim/sortieOptions";
import { NumberInput, Select } from "../../../ui";
import { Group, Inline } from "./parts";
import type { SortieOptionProps } from "./parts";

const RES: [keyof ResourceAmounts, string][] = [
  ["fuel", "燃料"],
  ["ammo", "弾薬"],
  ["steel", "鋼材"],
  ["bauxite", "ボーキ"],
];
const BATTLE_TYPES = ["battle", "boss", "night_battle", "air_battle", "air_raid"];

/** マスの効果を変える。値が全部空になったマスは消す */
const withEffect = (effects: Record<string, NodeEffect>, letter: string, patch: NodeEffect): Record<string, NodeEffect> => {
  const { [letter]: cur, ...rest } = effects;
  const next = { ...cur, ...patch };
  if (!next.resource) delete next.resource;
  if (!next.maelstrom) delete next.maelstrom;
  return Object.keys(next).length ? { ...rest, [letter]: next } : rest;
};

/** マス: マスごとの進撃 / 撤退 / 強行、煙幕を試みるマス、資源・揚陸・渦潮マスの効果 (地図データに量が無いので手入力) */
export const NodeChoices = ({ prefs, mapPrefs, setMapPrefs, nodes }: Pick<SortieOptionProps, "prefs" | "mapPrefs" | "setMapPrefs"> & { nodes: MapNode[] }) => {
  const { advance, effects, smoke } = mapPrefs;
  const choiceNodes = nodes.filter((n) => !n.isBoss && n.type !== "start");
  const battleNodes = nodes.filter((n) => BATTLE_TYPES.includes(n.type ?? ""));
  const resNodes = nodes.filter((n) => n.type === "resource" || n.type === "landing");
  const maelNodes = nodes.filter((n) => n.type === "maelstrom");
  const setEffect = (letter: string, patch: NodeEffect) => setMapPrefs({ effects: withEffect(effects, letter, patch) });
  // 海域キーは "4-2" / イベントは "60-1" の形 (world-no)
  const [world, no] = prefs.map.split("-").map(Number);

  return (
    <div className="flex flex-col gap-4">
      <Group title="マスのあと (進撃 = 撤退の設定に従う、撤退 = 必ず帰投、強行 = 損傷があっても進む。旗艦大破は常に帰投)">
        {choiceNodes.length === 0 ? (
          <p className="text-xs text-ink-400">マスがありません</p>
        ) : (
          <div className="grid grid-cols-4 gap-x-3 gap-y-1">
            {choiceNodes.map((n) => (
              <Inline key={n.letter} label={n.letter}>
                <Select
                  className="h-7! w-full"
                  aria-label={`${n.letter} のあと`}
                  value={advance[n.letter] ?? ""}
                  onChange={(e) => {
                    const { [n.letter]: _drop, ...rest } = advance;
                    setMapPrefs({ advance: e.target.value ? { ...rest, [n.letter]: e.target.value as Advance } : rest });
                  }}
                >
                  <option value="">進撃</option>
                  <option value="retreat">撤退</option>
                  <option value="push">強行</option>
                </Select>
              </Inline>
            ))}
          </div>
        )}
      </Group>

      {battleNodes.length > 0 && (
        <Group title="煙幕を試みるマス (発煙装置を積んだ単艦隊、1 出撃 1 回)。気球 = 阻塞気球マス">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {battleNodes.map((n) => (
              <label key={n.letter} className="flex cursor-pointer items-center gap-1.5 text-sm text-ink-100">
                <input
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer accent-accent-500"
                  aria-label={`${n.letter} で煙幕`}
                  checked={smoke.includes(n.letter)}
                  onChange={(e) => setMapPrefs({ smoke: e.target.checked ? [...smoke, n.letter] : smoke.filter((l) => l !== n.letter) })}
                />
                {n.letter}
                {isBalloonNode(world, no, n.letter) && <span className="text-xs text-ink-400">気球</span>}
              </label>
            ))}
          </div>
        </Group>
      )}

      {resNodes.length > 0 && (
        <Group title="資源・揚陸マスの獲得量 (1 回の通過あたりの期待値)">
          {resNodes.map((n) => (
            <div key={n.letter} className="grid grid-cols-[2rem_repeat(4,minmax(0,1fr))] items-center gap-2">
              <span className="text-sm font-medium text-ink-100">{n.letter}</span>
              {RES.map(([k, label]) => (
                <Inline key={k} label={label}>
                  <NumberInput
                    className="h-7! w-full"
                    aria-label={`${n.letter} の${label}`}
                    min={0}
                    max={9999}
                    value={effects[n.letter]?.resource?.[k] ?? 0}
                    onChange={(v) => {
                      const resource = { ...effects[n.letter]?.resource, [k]: v || undefined };
                      setEffect(n.letter, { resource: Object.values(resource).some(Boolean) ? resource : undefined });
                    }}
                  />
                </Inline>
              ))}
            </div>
          ))}
        </Group>
      )}

      {maelNodes.length > 0 && (
        <Group title="渦潮マスの損失 (率が 0 なら損失なし。電探で軽減)">
          {maelNodes.map((n) => {
            const m = effects[n.letter]?.maelstrom;
            const put = (p: Partial<Maelstrom>) => {
              const next: Maelstrom = { resource: "fuel", ...m, ...p };
              setEffect(n.letter, { maelstrom: next.rate || next.max ? next : undefined });
            };
            return (
              <div key={n.letter} className="grid grid-cols-[2rem_6rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
                <span className="text-sm font-medium text-ink-100">{n.letter}</span>
                <Select className="h-7!" aria-label={`${n.letter} の渦潮の資源`} value={m?.resource ?? "fuel"} onChange={(e) => put({ resource: e.target.value as Maelstrom["resource"] })}>
                  <option value="fuel">燃料</option>
                  <option value="ammo">弾薬</option>
                </Select>
                <Inline label="率 %">
                  <NumberInput className="h-7! w-full" aria-label={`${n.letter} の渦潮の率`} min={0} max={100} value={Math.round((m?.rate ?? 0) * 100)} onChange={(v) => put({ rate: v / 100 || undefined })} />
                </Inline>
                <Inline label="上限" title="1 隻あたりの上限 (0 = 上限なし)">
                  <NumberInput className="h-7! w-full" aria-label={`${n.letter} の渦潮の上限`} min={0} max={999} value={m?.max ?? 0} onChange={(v) => put({ max: v || undefined })} />
                </Inline>
              </div>
            );
          })}
        </Group>
      )}
    </div>
  );
};
