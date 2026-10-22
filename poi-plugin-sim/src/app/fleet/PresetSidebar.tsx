import React, { useMemo, useState } from "react";
import type { Preset } from "../../fleet";
import { normalizeForSearch } from "../../fleet/catalog";
import { Badge, Button, Card, ConfirmDialog, EmptyState, TextInput, S } from "../../ui";
import { cx } from "../../ui";
import { useApp } from "../context";

interface Props {
  presets: Preset[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onImportPoi: (fleetIndex: number) => void;
  onOpenIo: () => void;
}

const SOURCE_LABEL: Record<NonNullable<Preset["source"]>, string> = {
  manual: "手動",
  poi: "poi",
  deckbuilder: "DeckBuilder",
  import: "JSON",
};

const formatDate = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const PresetSidebar = ({
  presets,
  selectedId,
  onSelect,
  onCreate,
  onDuplicate,
  onDelete,
  onImportPoi,
  onOpenIo,
}: Props) => {
  const { catalog } = useApp();
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState(false);

  const filtered = useMemo(() => {
    const q = normalizeForSearch(query);
    if (!q) return presets;
    return presets.filter((p) => {
      const hay = normalizeForSearch(
        `${p.name}${p.note ?? ""}${p.ships.map((s) => catalog.shipName(s.masterId)).join("")}`
      );
      return hay.includes(q);
    });
  }, [presets, query, catalog]);

  const selected = presets.find((p) => p.id === selectedId);

  return (
    <Card title={S.fleet.presets} className="flex h-fit flex-col" bodyClassName="flex flex-col gap-3 p-3">
      <TextInput
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={S.fleet.searchPlaceholder}
        aria-label={S.fleet.searchPlaceholder}
      />

      <div className="flex gap-1.5">
        <Button variant="primary" size="sm" className="flex-1" onClick={onCreate}>
          ＋ {S.fleet.newPreset}
        </Button>
        <Button size="sm" disabled={!selected} onClick={onDuplicate}>
          {S.common.duplicate}
        </Button>
        <Button variant="danger" size="sm" disabled={!selected} onClick={() => setConfirming(true)}>
          {S.common.delete}
        </Button>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-xs text-ink-300">{S.fleet.importPoi}</span>
        {[0, 1, 2, 3].map((i) => (
          <Button key={i} size="sm" className="flex-1 px-0" onClick={() => onImportPoi(i)} title={`第${i + 1}艦隊`}>
            {i + 1}
          </Button>
        ))}
      </div>
      <Button size="sm" onClick={onOpenIo}>
        {S.fleet.importExport}
      </Button>

      <ul className="-mx-1 flex max-h-[28rem] flex-col gap-1 overflow-auto px-1">
        {filtered.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => onSelect(p.id)}
              className={cx(
                "w-full cursor-pointer rounded-md border px-3 py-2 text-left transition-colors",
                p.id === selectedId
                  ? "border-accent-500/70 bg-accent-600/15"
                  : "border-transparent bg-ink-900/40 hover:bg-ink-700/70"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-ink-50">{p.name}</span>
                {p.source && <Badge tone={p.source === "poi" ? "ok" : "neutral"}>{SOURCE_LABEL[p.source]}</Badge>}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-ink-300">
                {p.ships.length}隻 · {formatDate(p.updatedAt)}
                {p.ships[0] && ` · ${catalog.shipName(p.ships[0].masterId)}`}
              </div>
            </button>
          </li>
        ))}
      </ul>
      {presets.length === 0 && <EmptyState className="py-6" title={S.fleet.emptyList} description={S.fleet.emptyListHint} />}

      {confirming && selected && (
        <ConfirmDialog
          danger
          title={`「${selected.name}」を削除`}
          message="このプリセットを削除します。取り消せません。"
          confirmLabel={S.common.delete}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onDelete();
          }}
        />
      )}
    </Card>
  );
};
