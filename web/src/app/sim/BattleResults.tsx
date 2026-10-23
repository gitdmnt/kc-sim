import React, { useState } from "react";
import type { ShipSummary, SimulationSummary } from "@sim-core";
import { ProgressBar, StackedBar, Tabs } from "../../ui";
import { Assumptions } from "./Assumptions";
import { CompMarks, FormationGlyph } from "./CompMarks";
import { DTable, DTr, Fact, Num, RateList, RateRow, STATE_PARTS, Td, Th, pct, rankBar } from "./bars";
import { raidTitle } from "./extraFleets";
import { S } from "../../ui";
import type { BattleOutcome } from "./requests";

/** 主要な率 (結果がまだ無いときも同じ枠)。勝敗の棒は S → A → B 以上の順に区間が増える。 */
export const BattleRates = ({ s }: { s?: SimulationSummary }) => {
  const v = (x: number | undefined) => (x === undefined ? "—" : pct(x));
  const r = s?.rankRates;
  const ranks = r ? rankBar(r) : [];
  return (
    <RateList>
      <RateRow label="S勝利以上" parts={ranks.slice(0, 2)} value={v(r && r.SS + r.S)} />
      <RateRow label="A勝利以上" parts={ranks.slice(0, 3)} value={v(r && r.SS + r.S + r.A)} />
      <RateRow label="B勝利以上" parts={ranks.slice(0, 4)} value={v(r && r.SS + r.S + r.A + r.B)} />
      <RateRow label="敵旗艦撃沈" parts={[{ label: "敵旗艦撃沈", value: s?.enemyFlagshipSunkRate ?? 0, color: "var(--color-ink-400)" }]} value={v(s?.enemyFlagshipSunkRate)} />
      <RateRow
        label="大破あり"
        title="味方の誰かが大破以上"
        parts={[{ label: "大破あり", value: s?.friendHeavyAnyRate ?? 0, color: "var(--color-hp-heavy)" }]}
        value={v(s?.friendHeavyAnyRate)}
        tone={s && s.friendHeavyAnyRate >= 0.1 ? "danger" : undefined}
      />
      {s && s.friendSunkAnyRate >= 0.0005 && (
        <RateRow
          label="撃沈あり"
          title="味方の誰かが撃沈"
          parts={[{ label: "撃沈あり", value: s.friendSunkAnyRate, color: "var(--color-hp-sunk)" }]}
          value={pct(s.friendSunkAnyRate)}
          tone="danger"
        />
      )}
    </RateList>
  );
};

const ShipRows = ({ names, ships, showMvp }: { names: string[]; ships: ShipSummary[]; showMvp?: boolean }) => (
  <DTable
    head={
      <>
        <Th className="text-left">艦</Th>
        <Th className="w-24 text-left" title="戦闘後の HP の平均">
          残HP
        </Th>
        <Th className="w-32 text-left" title="戦闘後の状態 (無傷・小破・中破・大破・撃沈)">
          状態
        </Th>
        <Th className="w-14">撃沈</Th>
        <Th className="w-14">与ダメ</Th>
        {showMvp && <Th className="w-14">MVP</Th>}
      </>
    }
  >
    {ships.map((s, i) => (
      <DTr key={i}>
        <Td className="max-w-28 truncate text-ink-200" title={names[i]}>
          {names[i] ?? `#${i + 1}`}
        </Td>
        <Td title={`${s.hpMean.toFixed(1)} / ${s.maxHp}`}>
          <ProgressBar value={s.hpMean} max={s.maxHp} />
        </Td>
        <Td>
          <StackedBar parts={STATE_PARTS(s)} />
        </Td>
        <Num alert={s.sunkRate > 0.005}>{pct(s.sunkRate)}</Num>
        <Num>{s.damageDealtMean.toFixed(1)}</Num>
        {showMvp && <Num>{pct(s.mvpRate)}</Num>}
      </DTr>
    ))}
  </DTable>
);

type Detail = "comps" | "friend" | "enemy" | "notes";

export const BattleResults = ({ out, meta, shipName }: { out: BattleOutcome; meta: React.ReactNode; shipName: (id: number) => string }) => {
  const s = out.total;
  const multi = out.comps.length > 1;
  const [detail, setDetail] = useState<Detail>(multi ? "comps" : "friend");
  const [view, setView] = useState(0);
  const viewed = out.comps[Math.min(view, out.comps.length - 1)];
  const notes = out.assumptions.warnings.length;
  // 艦の位置ごとに、全編成で同じ艦か (同じ位置は薄く出す)
  const slots = Math.max(0, ...out.comps.map((c) => c.comp.main.length));
  const first = out.comps[0]?.comp.main ?? [];
  const same = Array.from({ length: slots }, (_, i) => multi && out.comps.every((c) => c.comp.main[i]?.shipId === first[i]?.shipId));

  return (
    <>
      <BattleRates s={s} />
      {(s.supportRate !== undefined || s.friendFleetRate !== undefined || s.baseRaid) && (
        <div className="grid grid-cols-2 gap-x-6 gap-y-1">
          {s.supportRate !== undefined && <Fact label={S.extraFleets.supportRate} value={pct(s.supportRate)} title="支援艦隊が到達した戦闘の割合" />}
          {s.friendFleetRate !== undefined && <Fact label={S.extraFleets.friendRate} value={pct(s.friendFleetRate)} title="夜戦になり友軍艦隊が戦った戦闘の割合" />}
          {s.baseRaid && (
            <Fact
              label={`${S.extraFleets.raidAir} (優勢以上)`}
              value={pct(s.baseRaid.airStateRates.supremacy + s.baseRaid.airStateRates.superiority)}
              title={raidTitle(s.baseRaid, out.baseNumbers)}
            />
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <Tabs
          variant="pill"
          size="sm"
          value={detail}
          onChange={setDetail}
          tabs={[
            ...(multi ? [{ id: "comps" as const, label: "敵編成", hint: String(out.comps.length) }] : []),
            { id: "friend", label: "味方" },
            { id: "enemy", label: "敵" },
            { id: "notes", label: "前提", hint: notes ? String(notes) : undefined },
          ]}
        />
        {meta}
      </div>

      <div className="-mx-2 min-h-0 flex-1 overflow-auto px-2">
        {detail === "comps" && (
          <DTable
            head={
              <>
                <Th className="text-left" title="艦ごとの級 (カナ) と改/elite (e)/flagship (f)。全編成で同じ位置は薄く表示">
                  編成
                </Th>
                <Th className="w-6" />
                <Th className="w-14">出現</Th>
                <Th className="w-28 text-left" title="この編成での勝敗">
                  勝敗
                </Th>
                <Th className="w-14">S以上</Th>
                <Th className="w-16">撃沈あり</Th>
              </>
            }
          >
            {out.comps.map((c, i) => {
              const ships = c.comp.main.map((x) => shipName(x.shipId)).join("、");
              const cr = c.summary.rankRates;
              return (
                <DTr
                  key={c.comp.id}
                  selected={i === view}
                  onClick={() => {
                    setView(i);
                    setDetail("enemy");
                  }}
                >
                  <Td title={`${ships} (${c.count.toLocaleString()} 戦)`}>
                    <CompMarks ids={c.comp.main.map((x) => x.shipId)} same={same} name={shipName} slots={slots} />
                  </Td>
                  <Td className="px-0">
                    <FormationGlyph formation={c.comp.formation} />
                  </Td>
                  <Num>{pct(c.comp.weight)}</Num>
                  <Td>
                    <StackedBar parts={rankBar(cr)} />
                  </Td>
                  <Num>{pct(cr.SS + cr.S)}</Num>
                  <Num alert={c.summary.friendSunkAnyRate > 0.005}>{pct(c.summary.friendSunkAnyRate)}</Num>
                </DTr>
              );
            })}
          </DTable>
        )}
        {detail === "friend" && <ShipRows names={out.friendNames} ships={s.friend} showMvp />}
        {detail === "enemy" && viewed && (
          <>
            {multi && <div className="mb-1 text-xs text-ink-400">出現率 {pct(viewed.comp.weight)} の編成</div>}
            <ShipRows names={viewed.enemyNames} ships={viewed.summary.enemy} />
          </>
        )}
        {detail === "notes" && <Assumptions data={out.assumptions} />}
      </div>
    </>
  );
};
