import { useMemo } from "react";
import { useApp } from "../app/context";
import { getDataApi } from "./api";
import type { ApiEquipment, ApiShip } from "@shared/data/types";
import type { MapData } from "./mapData";
import { useAsync } from "./useAsync";

/** 深海棲艦は名前が同じで elite / flagship が違う艦がいる (区別は yomi にある) */
export const abyssalShipLabel = (ship: Pick<ApiShip, "name" | "yomi">): string =>
  ship.yomi === "elite" || ship.yomi === "flagship" ? `${ship.name} ${ship.yomi}` : ship.name;

/** 深海棲艦の表示名。名前が同じで elite / flagship だけ違う艦がいる (区別は yomi にある) ので付け足す。 */
export const abyssalName = (ship: { name: string; yomi: string | null }): string =>
  ship.yomi === "elite" || ship.yomi === "flagship" ? `${ship.name}${ship.yomi}` : ship.name;

/** 深海棲艦・深海装備の名前引き。API の一覧を優先し、無ければ poi の const を使う。 */
export const useAbyssalData = (fallback?: MapData) => {
  const { catalog } = useApp();
  const ships = useAsync(() => getDataApi().abyssalShips(), []);
  const equips = useAsync(() => getDataApi().abyssalEquipments(), []);

  const maps = useMemo(() => {
    const s = new Map<number, ApiShip>((ships.data ?? []).map((x) => [x.id, x]));
    const e = new Map<number, ApiEquipment>((equips.data ?? []).map((x) => [x.id, x]));
    return { s, e };
  }, [ships.data, equips.data]);

  return {
    ships: ships.data,
    equips: equips.data,
    loading: ships.loading || equips.loading,
    error: ships.error ?? equips.error,
    stale: ships.stale || equips.stale,
    // API の一覧に無い/取得できないときは海域データ (静的バンドル含む) の値を使う
    shipById: (id: number) => maps.s.get(id) ?? fallback?.ships.get(id)?.ship,
    equipById: (id: number) => maps.e.get(id) ?? fallback?.equips.get(id),
    shipName: (id: number) => {
      const ship = maps.s.get(id) ?? fallback?.ships.get(id)?.ship;
      return ship ? abyssalShipLabel(ship) : catalog.shipName(id);
    },
    equipName: (id: number) => maps.e.get(id)?.name ?? fallback?.equips.get(id)?.name ?? `装備#${id}`,
  };
};
