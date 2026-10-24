import { useApp } from "../app/context";
import type { MapData } from "./mapData";

/** 深海棲艦の表示名。名前が同じで elite / flagship だけ違う艦がいる (区別は yomi にある) ので付け足す。 */
export const abyssalName = (ship: { name: string; yomi: string | null }): string =>
  ship.yomi === "elite" || ship.yomi === "flagship" ? `${ship.name}${ship.yomi}` : ship.name;

/** 海域データ (API・静的バンドルとも編成に出る艦と深海装備を持つ) の名前引き。無い艦は poi の const を使う。 */
export const useMapNames = (md: MapData | undefined) => {
  const { catalog } = useApp();
  return {
    shipName: (id: number) => {
      const ship = md?.ships.get(id)?.ship;
      return ship ? abyssalName(ship) : catalog.shipName(id);
    },
    equipById: (id: number) => md?.equips.get(id),
    equipName: (id: number) => md?.equips.get(id)?.name ?? `装備#${id}`,
  };
};
