import React, { useEffect, useState } from "react";
import { getObservationDb } from "../../capture";
import type { CapturedBattle, StoredEvent } from "../../capture";
import {
  ENGAGEMENT_LABEL,
  FORMATION_ID_LABEL,
  HIT_LABEL,
  PHASE_LABEL,
  battleKindLabel,
} from "../../capture/labels";
import { Badge, Button, Drawer, ProgressBar, Table, Td, Th, Thead, Tr, S, useToast } from "@web/ui";
import type { BadgeTone } from "@web/ui";
import { copyText } from "@web/app/fleet/clipboard";
import type { Catalog } from "@web/fleet/catalog";
import { L } from "../strings";
import { rankTone } from "./util";

const HIT_TONE: Record<string, BadgeTone> = { miss: "neutral", hit: "accent", crit: "warn" };

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mb-5">
    <h4 className="mb-2 text-sm font-semibold text-ink-200">{title}</h4>
    {children}
  </section>
);

const arr = (v: unknown): number[] => (Array.isArray(v) ? (v as number[]) : []);

export const LogDetail = ({ battle, catalog, onClose }: { battle: CapturedBattle; catalog: Catalog; onClose: () => void }) => {
  const toast = useToast();
  const [events, setEvents] = useState<StoredEvent[] | null>(null);

  useEffect(() => {
    let alive = true;
    setEvents(null);
    getObservationDb()
      .listEvents(battle.id)
      .then((e) => alive && setEvents(e))
      .catch(() => alive && setEvents([]));
    return () => {
      alive = false;
    };
  }, [battle.id]);

  const raw = battle.raw as any;
  const friendNow = arr(raw?.api_f_nowhps);
  const friendMax = arr(raw?.api_f_maxhps);
  const friendShips = battle.fleet?.ships ?? [];
  const enemyAll = [...battle.enemy.ships, ...battle.enemy.escort.map((s) => ({ ...s, idx: s.idx + 6 }))];

  const nameOf = (side: "friend" | "enemy", idx: number) => {
    if (idx < 0) return side === "friend" ? "味方航空隊" : "敵航空隊";
    if (side === "friend") {
      const ship = idx < 6 ? friendShips[idx] : battle.fleet?.escort?.[idx - 6];
      return ship ? catalog.shipName(ship.masterId) : `味方#${idx + 1}`;
    }
    const e = enemyAll.find((s) => s.idx === idx);
    return e ? catalog.shipName(e.masterId) : `敵#${idx + 1}`;
  };

  const e = battle.enemy;
  return (
    <Drawer title={`${L.log.detail} — ${battle.map?.map ?? "?"} ${battle.map?.node ?? ""}`} onClose={onClose} className="max-w-3xl">
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{battleKindLabel(battle.path)}</Badge>
        {battle.result?.rank && <Badge tone={rankTone(battle.result.rank)}>{battle.result.rank}</Badge>}
        {e.engagement && <Badge tone="neutral">{ENGAGEMENT_LABEL[e.engagement]}</Badge>}
        <span className="text-sm text-ink-300">
          味方 {FORMATION_ID_LABEL[e.friendFormation ?? -1] ?? "—"} / 敵 {FORMATION_ID_LABEL[e.enemyFormation ?? -1] ?? "—"}
        </span>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Section title={L.log.friend}>
          <ul className="flex flex-col gap-1.5">
            {friendShips.length === 0 && <li className="text-sm text-ink-400">艦隊スナップショットなし</li>}
            {friendShips.map((s, i) => (
              <li key={i} className="rounded bg-ink-900/60 px-2.5 py-1.5">
                <div className="flex justify-between text-sm">
                  <span>{catalog.shipName(s.masterId)}</span>
                  <span className="text-xs text-ink-300">Lv{s.level}</span>
                </div>
                {friendMax[i] ? (
                  <>
                    <ProgressBar value={friendNow[i] ?? 0} max={friendMax[i]} className="mt-1" />
                    <div className="mt-0.5 text-right text-xs text-ink-300 tabular-nums">
                      {friendNow[i]}/{friendMax[i]}
                    </div>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
        <Section title={L.log.enemySide}>
          <ul className="flex flex-col gap-1.5">
            {enemyAll.map((s) => (
              <li key={s.idx} className="rounded bg-ink-900/60 px-2.5 py-1.5">
                <div className="flex justify-between text-sm">
                  <span>{catalog.shipName(s.masterId)}</span>
                  <span className="text-xs text-ink-300">{s.level ? `Lv${s.level}` : ""}</span>
                </div>
                {s.maxHp ? (
                  <>
                    <ProgressBar value={s.nowHp ?? s.maxHp} max={s.maxHp} className="mt-1" />
                    <div className="mt-0.5 flex justify-between text-xs text-ink-300 tabular-nums">
                      <span>{s.params ? `火${s.params[0]} 雷${s.params[1]} 空${s.params[2]} 装${s.params[3]}` : ""}</span>
                      <span>
                        {s.nowHp}/{s.maxHp}
                      </span>
                    </div>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      </div>

      <Section title={`${L.log.events}${events ? ` (${events.length})` : ""}`}>
        {events === null ? (
          <div className="text-sm text-ink-400">{S.common.loading}</div>
        ) : events.length === 0 ? (
          <div className="text-sm text-ink-400">イベントなし (未対応の戦闘形式)</div>
        ) : (
          <Table className="max-h-[28rem]">
            <Thead>
              <tr>
                <Th>#</Th>
                <Th>フェーズ</Th>
                <Th>攻撃側</Th>
                <Th>対象</Th>
                <Th>種別</Th>
                <Th>結果</Th>
                <Th className="text-right">ダメージ</Th>
              </tr>
            </Thead>
            <tbody>
              {events.map((ev) => (
                <Tr key={ev.seq}>
                  <Td className="text-ink-400 tabular-nums">{ev.seq + 1}</Td>
                  <Td className="whitespace-nowrap">{PHASE_LABEL[ev.phase]}</Td>
                  <Td className={ev.attackerSide === "friend" ? "text-accent-400" : "text-danger-400"}>
                    {nameOf(ev.attackerSide, ev.attackerIdx)}
                  </Td>
                  <Td>{nameOf(ev.defenderSide, ev.defenderIdx)}</Td>
                  <Td className="text-ink-300">{ev.attackType ?? (ev.airKind ? { bomb: "爆撃", torpedo: "雷撃", both: "爆雷" }[ev.airKind] : "—")}</Td>
                  <Td>
                    <Badge tone={HIT_TONE[ev.hit]}>{HIT_LABEL[ev.hit]}</Badge>
                  </Td>
                  <Td className="text-right tabular-nums">
                    {ev.damage}
                    {ev.protected && <span className="ml-1 text-xs text-warn-400">かばう</span>}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>
      <Button
        size="sm"
        variant="ghost"
        onClick={async () => toast.push((await copyText(JSON.stringify(battle.raw, null, 2))) ? S.common.copied : "コピーに失敗しました", "ok")}
      >
        {L.log.copyRaw}
      </Button>
    </Drawer>
  );
};
