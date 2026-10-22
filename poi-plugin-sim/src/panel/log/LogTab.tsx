import React, { useCallback, useEffect, useMemo, useState } from "react";
import { getObservationDb, getUploadClient } from "../../capture";
import type { CapturedBattle } from "../../capture";
import { ENGAGEMENT_LABEL, FORMATION_ID_LABEL, battleKindLabel } from "../../capture/labels";
import { normalizeForSearch } from "@web/fleet/catalog";
import type { Catalog } from "@web/fleet/catalog";
import { Badge, Button, Card, EmptyState, Select, Table, Td, TextInput, Th, Thead, Tr, S, useToast } from "@web/ui";
import { formatDateTime, formatShortDateTime } from "@web/ui/format";
import { serverOrigin } from "@shared/embed/protocol";
import { usePluginSettings } from "../../settings";
import { L } from "../strings";
import { useUploadWaitSeconds } from "../useUploadClient";
import { LogDetail } from "./LogDetail";
import { downloadText, rankTone } from "./util";

const MAX_ROWS = 300;
const RANKS = ["SS", "S", "A", "B", "C", "D", "E"];

export const LogTab = ({ catalog }: { catalog: Catalog }) => {
  const toast = useToast();
  const apiBase = serverOrigin(usePluginSettings().serverUrl) ?? "";
  const db = getObservationDb();

  const [battles, setBattles] = useState<CapturedBattle[] | null>(null);
  const [pending, setPending] = useState(0);
  const [map, setMap] = useState("");
  const [node, setNode] = useState("");
  const [enemy, setEnemy] = useState("");
  const [rank, setRank] = useState("");
  const [selected, setSelected] = useState<CapturedBattle | null>(null);
  const [busy, setBusy] = useState(false);
  const wait = useUploadWaitSeconds();

  const load = useCallback(async () => {
    try {
      const m = map.trim();
      const list = await db.listBattles({ map: m || undefined, node: m && node.trim() ? node.trim() : undefined });
      setBattles(list.reverse());
      setPending(await db.countPending());
    } catch (e) {
      console.error("[kcsim] failed to load observations", e);
      setBattles([]);
    }
  }, [db, map, node]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const q = normalizeForSearch(enemy);
    return (battles ?? [])
      .filter((b) => !rank || b.result?.rank === rank)
      .filter(
        (b) =>
          !q ||
          [...b.enemy.ships, ...b.enemy.escort].some((s) => normalizeForSearch(catalog.shipName(s.masterId)).includes(q))
      );
  }, [battles, enemy, rank, catalog]);

  const exportJson = async () => {
    downloadText(`kcsim-observations-${Date.now()}.json`, await db.exportJSON());
  };

  const upload = async () => {
    setBusy(true);
    try {
      const out = await getUploadClient().send(db, apiBase);
      if (out.status === "sent") toast.push(L.log.uploadDone(out.sent, out.remaining), "ok");
      else if (out.status === "deferred") toast.push(L.log.uploadWait(Math.max(1, Math.ceil((out.until - Date.now()) / 1000))), "info");
      else if (out.status === "banned") toast.push(L.log.uploadBanned, "danger");
      await load();
    } catch (e) {
      toast.push(`${L.log.uploadFail}: ${(e as Error).message}`, "danger");
    } finally {
      setBusy(false);
    }
  };

  const enemyNames = (b: CapturedBattle) => {
    const names = [...b.enemy.ships, ...b.enemy.escort].map((s) => catalog.shipName(s.masterId));
    return names.length > 3 ? `${names.slice(0, 3).join("、")} 他${names.length - 3}` : names.join("、");
  };

  return (
    <div className="flex flex-col gap-4">
      <Card
        title={`${L.log.title} (${S.common.count(rows.length)})`}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => void load()} title={L.log.reload} aria-label={L.log.reload}>
              ↻
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void exportJson()}>
              {L.log.exportJson}
            </Button>
            <Button size="sm" variant="primary" disabled={busy || pending === 0 || wait > 0 || apiBase === ""} onClick={() => void upload()}>
              {pending > 0 && wait > 0 ? L.log.uploadWait(wait) : L.log.upload(pending)}
            </Button>
          </>
        }
        bodyClassName="grid grid-cols-2 gap-3 md:grid-cols-4"
      >
        <TextInput value={map} onChange={(e) => setMap(e.target.value)} placeholder={L.log.filterMap} aria-label={L.log.filterMap} />
        <TextInput
          value={node}
          onChange={(e) => setNode(e.target.value)}
          placeholder={L.log.filterNode}
          disabled={!map.trim()}
          aria-label={L.log.filterNode}
        />
        <TextInput value={enemy} onChange={(e) => setEnemy(e.target.value)} placeholder={L.log.filterEnemy} aria-label={L.log.filterEnemy} />
        <Select value={rank} onChange={(e) => setRank(e.target.value)} aria-label={L.log.filterRank}>
          <option value="">
            {L.log.filterRank}: {L.log.all}
          </option>
          {RANKS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
      </Card>

      {battles !== null && rows.length === 0 ? (
        <EmptyState title={L.log.empty} description={L.log.emptyHint} className="py-16" />
      ) : (
        <Table>
          <Thead>
            <tr>
              <Th>{L.log.map}</Th>
              <Th>{L.log.node}</Th>
              <Th>{L.log.rank}</Th>
              <Th>{L.log.enemy}</Th>
              <Th>{L.log.kind}</Th>
              <Th>{L.log.formation}</Th>
              <Th className="text-right">{L.log.date}</Th>
            </tr>
          </Thead>
          <tbody>
            {rows.slice(0, MAX_ROWS).map((b) => (
              <Tr key={b.id} onClick={() => setSelected(b)} selected={selected?.id === b.id}>
                <Td className="whitespace-nowrap font-semibold text-ink-50 tabular-nums">
                  {b.map?.map ?? "—"}
                  {b.map?.difficulty ? <span className="ml-1 text-xs font-normal text-ink-400">難度{b.map.difficulty}</span> : null}
                </Td>
                <Td className="font-semibold text-ink-50">{b.map?.node ?? "—"}</Td>
                <Td>{b.result?.rank ? <Badge tone={rankTone(b.result.rank)}>{b.result.rank}</Badge> : <span className="text-ink-500">—</span>}</Td>
                <Td className="max-w-80 truncate text-ink-100">{enemyNames(b) || "—"}</Td>
                <Td className="whitespace-nowrap text-ink-300">{battleKindLabel(b.path)}</Td>
                <Td className="whitespace-nowrap text-ink-300">
                  {FORMATION_ID_LABEL[b.enemy.enemyFormation ?? -1] ?? "—"}
                  {b.enemy.engagement ? ` / ${ENGAGEMENT_LABEL[b.enemy.engagement] ?? ""}` : ""}
                </Td>
                <Td className="whitespace-nowrap text-right text-xs text-ink-400 tabular-nums">
                  <span title={formatDateTime(b.capturedAt)}>{formatShortDateTime(b.capturedAt)}</span>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      {selected && <LogDetail battle={selected} catalog={catalog} onClose={() => setSelected(null)} />}
    </div>
  );
};
