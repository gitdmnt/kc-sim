import React from "react";
import type { Preset, PresetFormation } from "../../fleet";
import { Card, Combobox, Field, NumberInput, Select, TextInput, S } from "../../ui";
import { useApp } from "../context";
import { FleetSummary } from "./FleetSummary";
import { newShipFor } from "./presets";
import { ShipCard } from "./ShipCard";

const MAX_SHIPS = 6;
const SINGLE_FORMATIONS: PresetFormation[] = [
  "line_ahead", "double_line", "diamond", "echelon", "line_abreast", "vanguard",
];

interface Props {
  preset: Preset;
  onChange: (next: Preset) => void;
}

export const PresetEditor = ({ preset, onChange }: Props) => {
  const { catalog } = useApp();
  const patch = (p: Partial<Preset>) => onChange({ ...preset, ...p });
  const formations = preset.fleetType === "single" ? SINGLE_FORMATIONS : (Object.keys(S.formations) as PresetFormation[]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card bodyClassName="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Field label={S.fleet.name} className="col-span-2 md:col-span-2">
          <TextInput value={preset.name} onChange={(e) => patch({ name: e.target.value })} />
        </Field>
        <Field label={S.fleet.fleetType}>
          <Select value={preset.fleetType} onChange={(e) => patch({ fleetType: e.target.value as Preset["fleetType"] })}>
            {(Object.keys(S.fleetTypes) as Preset["fleetType"][]).map((k) => (
              <option key={k} value={k} disabled={k !== "single"}>
                {S.fleetTypes[k]}
                {k !== "single" ? " (準備中)" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={S.fleet.formation}>
          <Select value={preset.formation} onChange={(e) => patch({ formation: e.target.value as PresetFormation })}>
            {formations.map((f) => (
              <option key={f} value={f}>
                {S.formations[f]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={S.fleet.hq}>
          <NumberInput min={1} max={185} value={preset.hqLevel ?? 120} onChange={(v) => patch({ hqLevel: v })} />
        </Field>
        <Field label={S.fleet.note} className="col-span-2 md:col-span-6">
          <TextInput value={preset.note ?? ""} onChange={(e) => patch({ note: e.target.value })} placeholder="用途・出典など" />
        </Field>
      </Card>

      <FleetSummary preset={preset} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {preset.ships.map((ship, i) => (
          <ShipCard
            key={i}
            index={i}
            ship={ship}
            onChange={(next) => patch({ ships: preset.ships.map((s, j) => (j === i ? next : s)) })}
            onRemove={() => patch({ ships: preset.ships.filter((_, j) => j !== i) })}
          />
        ))}
        {preset.ships.length < MAX_SHIPS && (
          <div className="rounded-lg border border-dashed border-ink-500 bg-ink-800/50 p-3.5">
            <div className="mb-2 text-sm text-ink-300">{S.fleet.addShipTo(preset.ships.length + 1)}</div>
            <ShipPicker onPick={(id) => patch({ ships: [...preset.ships, newShipFor(id, catalog)] })} />
          </div>
        )}
      </div>
    </div>
  );
};

const ShipPicker = ({ onPick }: { onPick: (id: number) => void }) => {
  const { catalog } = useApp();
  return (
    <Combobox
      options={catalog.shipOptions}
      value={null}
      onChange={(id) => id !== null && onPick(id)}
      placeholder={S.fleet.addShip}
      aria-label={S.fleet.addShip}
    />
  );
};
