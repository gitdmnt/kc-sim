import React, { useState } from "react";
import type { ShipSummary, SimulationSummary } from "@sim-core";
import { ProgressBar, Tabs } from "../../ui";
import { Assumptions } from "./Assumptions";
import { DTable, DTr, Kpi, Mini, Num, RankLegend, STATE_PARTS, StackedBar, Td, Th, pct, rankBar } from "./bars";
import type { BattleOutcome } from "./requests";

/** 結果がまだ無いときも同じ枠を出す */
export const BattleKpis = ({ s }: { s?: SimulationSummary }) => {
  const r = s?.rankRates;
  const v = (x: number | undefined) => (x === undefined ? "—" : pct(x));
  return (
    <div className="grid grid-cols-2 gap-1.5">
      <Kpi label="S勝利以上" value={v(r && r.SS + r.S)} />
      <Kpi label="A勝利以上" value={v(r && r.SS + r.S + r.A)} />
      <Kpi label="敵旗艦撃沈" value={v(s?.enemyFlagshipSunkRate)} />
      <Kpi label="味方大破あり" value={v(s?.friendHeavyAnyRate)} />
    </div>
  );
};

const ShipRows = ({ names, ships, showMvp }: { names: string[]; ships: ShipSummary[]; showMvp?: boolean }) => (
  <DTable
    head={
      <>
        <Th className="text-left">艦</Th>
        <Th className="w-[24%] text-left">残HP</Th>
        <Th className="w-[26%] text-left">状態</Th>
        <Th>撃沈</Th>
        <Th>与ダメ</Th>
        {showMvp && <Th>MVP</Th>}
      </>
    }
  >
    {ships.map((s, i) => (
      <DTr key={i}>
        <Td className="max-w-24 truncate" title={names[i]}>
          {names[i] ?? `#${i + 1}`}
        </Td>
        <Td title={`${s.hpMean.toFixed(1)}/${s.maxHp}`}>
          <ProgressBar value={s.hpMean} max={s.maxHp} />
        </Td>
        <Td>
          <StackedBar parts={STATE_PARTS(s)} height="h-2.5" />
        </Td>
        <Num main alert={s.sunkRate > 0.005}>{pct(s.sunkRate)}</Num>
        <Num>{s.damageDealtMean.toFixed(1)}</Num>
        {showMvp && <Num>{pct(s.mvpRate)}</Num>}
      </DTr>
    ))}
  </DTable>
);

type Detail = "comps" | "friend" | "enemy" | "notes";

export const BattleResults = ({ out, meta, shipName }: { out: BattleOutcome; meta: React.ReactNode; shipName: (id: number) => string }) => {
  const s = out.total;
  const r = s.rankRates;
  const multi = out.comps.length > 1;
  const [detail, setDetail] = useState<Detail>(multi ? "comps" : "friend");
  const [view, setView] = useState(0);
  const viewed = out.comps[Math.min(view, out.comps.length - 1)];
  const notes = out.assumptions.warnings.length;

  return (
    <>
      <BattleKpis s={s} />
      <div className="flex flex-col gap-1">
        <StackedBar parts={rankBar(r)} height="h-3" />
        <RankLegend rates={r} />
      </div>
      <div className="grid grid-cols-4 gap-x-2">
        <Mini label="B勝利以上" value={pct(r.SS + r.S + r.A + r.B)} />
        <Mini label="味方撃沈あり" value={pct(s.friendSunkAnyRate)} alert={s.friendSunkAnyRate > 0.005} />
      </div>

      <div className="flex items-center justify-between gap-2">
        <Tabs
          variant="pill"
          size="sm"
          value={detail}
          onChange={setDetail}
          tabs={[
            ...(multi ? [{ id: "comps" as const, label: "敵編成" }] : []),
            { id: "friend", label: "味方" },
            { id: "enemy", label: "敵" },
            { id: "notes", label: notes ? `前提 ${notes}` : "前提" },
          ]}
        />
        {meta}
      </div>

      <div className="-mx-1 min-h-0 flex-1 overflow-auto px-1">
        {detail === "comps" && (
          <DTable
            head={
              <>
                <Th className="text-left">編成</Th>
                <Th>出現</Th>
                <Th>S以上</Th>
                <Th>A以上</Th>
                <Th>撃沈あり</Th>
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
                  <Td className="max-w-36 truncate" title={`${ships} (${c.count.toLocaleString()} 戦)`}>
                    {ships}
                  </Td>
                  <Num>{pct(c.comp.weight)}</Num>
                  <Num main>{pct(cr.SS + cr.S)}</Num>
                  <Num main>{pct(cr.SS + cr.S + cr.A)}</Num>
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
