import React from "react";
import { cx } from "./cx";

/** 装備アイコン ID (装備マスタの api_type[3]) の大分類。色と図柄はこの分類ごと。 */
export type EquipIconCategory =
  | "smallGun" | "mediumGun" | "largeGun" | "secondaryGun" | "aaGun" | "highAngleGun"
  | "torpedo" | "fighter" | "diveBomber" | "torpedoBomber" | "recon" | "seaplane"
  | "radar" | "sonar" | "depthCharge" | "armor" | "engine" | "apShell" | "type3Shell"
  | "landingCraft" | "amphibTank" | "drum" | "searchlight" | "flare" | "repair" | "supply"
  | "lbas" | "jet" | "autogyro" | "crew" | "other";

export const EQUIP_ICON_CATEGORIES: readonly EquipIconCategory[] = [
  "smallGun", "mediumGun", "largeGun", "secondaryGun", "aaGun", "highAngleGun",
  "torpedo", "fighter", "diveBomber", "torpedoBomber", "recon", "seaplane",
  "radar", "sonar", "depthCharge", "armor", "engine", "apShell", "type3Shell",
  "landingCraft", "amphibTank", "drum", "searchlight", "flare", "repair", "supply",
  "lbas", "jet", "autogyro", "crew", "other",
];

/** api_start2 (@kancolle/data) の装備に現れる icon id 1〜50 を割り当てる。未知の ID は other。 */
const BY_ICON_ID: Record<number, EquipIconCategory> = {
  1: "smallGun", 2: "mediumGun", 3: "largeGun", 4: "secondaryGun", 5: "torpedo",
  6: "fighter", 7: "diveBomber", 8: "torpedoBomber", 9: "recon", 10: "seaplane",
  11: "radar", 12: "type3Shell", 13: "apShell", 14: "repair", 15: "aaGun",
  16: "highAngleGun", 17: "depthCharge", 18: "sonar", 19: "engine", 20: "landingCraft",
  21: "autogyro", 22: "autogyro", 23: "armor", 24: "searchlight", 25: "drum",
  26: "repair", 27: "flare", 28: "crew", 29: "crew", 32: "crew",
  33: "seaplane", 34: "supply", 35: "supply", 36: "amphibTank", 37: "lbas",
  38: "fighter", 39: "jet", 40: "jet", 41: "recon", 42: "radar",
  43: "seaplane", 44: "fighter", 45: "fighter", 46: "torpedoBomber",
  47: "lbas", 48: "lbas", 49: "lbas", 50: "seaplane",
};

export const equipIconCategory = (iconId: number): EquipIconCategory => BY_ICON_ID[iconId] ?? "other";

/** 暗い背景用に彩度を落とした分類色。意味は分類だけを表す。 */
export const EQUIP_CATEGORY_COLOR: Record<EquipIconCategory, string> = {
  smallGun: "#d98a84", mediumGun: "#d98a84", largeGun: "#d98a84",
  secondaryGun: "#d6bb6e", aaGun: "#c9a85a", highAngleGun: "#c9a85a",
  torpedo: "#6fa3dc", fighter: "#7cc490", diveBomber: "#d9a066", torpedoBomber: "#6fb0c8",
  recon: "#b6c47a", seaplane: "#8fc4b0", radar: "#d9a55e", sonar: "#6fb8c8",
  depthCharge: "#7f9fc8", armor: "#a9a39a", engine: "#a9a39a", apShell: "#cf8f78",
  type3Shell: "#cf8f78", landingCraft: "#a3b57a", amphibTank: "#a3b57a", drum: "#b9a283",
  searchlight: "#e0cf7e", flare: "#e0cf7e", repair: "#8fcfa0", supply: "#b9a283",
  lbas: "#8fb0d9", jet: "#b79be0", autogyro: "#a8c487", crew: "#b6a9d0", other: "#9aa3b2",
};

/** 16×16・線幅 1.5・currentColor の単色図柄。塗りは fill="currentColor" の部品だけ。 */
const F = "currentColor";
const gun = (barrels: number[], w = 6, h = 6, y0 = 8) => (
  <>
    <rect x="1.8" y={y0 - h / 2 + 0.5} width={w} height={h} rx="1.6" />
    {barrels.map((y) => (
      <path key={y} d={`M${1.8 + w} ${y}H14.5`} />
    ))}
  </>
);
const plane = { fus: <path d="M8 2.5V13.5" />, tail: <path d="M5.5 13H10.5" /> };

const GLYPH: Record<EquipIconCategory, React.ReactNode> = {
  smallGun: gun([9], 6, 6.5, 9),
  mediumGun: gun([6.2, 10.2], 6, 9, 8.2),
  largeGun: <>
    <rect x="1.5" y="3.5" width="6" height="9" rx="1.8" />
    <path d="M7.5 5H14.5M7.5 8H14.5M7.5 11H14.5" />
  </>,
  secondaryGun: <>
    <path d="M2 13.5H14" />
    <path d="M4 13.5a3.2 3.2 0 0 1 6.4 0" />
    <path d="M8.8 8.6L14 4.6" />
  </>,
  aaGun: <>
    <path d="M3 13.5H13" />
    <path d="M8 13.5V9" />
    <path d="M8 9L4 2.5M8 9V2M8 9l4-6.5" />
  </>,
  highAngleGun: <>
    <circle cx="6" cy="11" r="3" />
    <path d="M7.8 8.6L13.5 3M9.2 10L14.5 5.2" />
  </>,
  torpedo: <>
    <path d="M5 5.8h7a2.2 2.2 0 0 1 0 4.4H5z" />
    <path d="M5 5.8L2 3.8M5 10.2L2 12.2" />
  </>,
  fighter: <>
    <path d="M8 1.5V14" />
    <path d="M8 6L2 11M8 6l6 5M8 12.8l-2.3 1.7M8 12.8l2.3 1.7" />
  </>,
  diveBomber: <>
    {plane.fus}
    <path d="M1.5 6.5H14.5" />
    {plane.tail}
    <circle cx="8" cy="10" r="1.7" fill={F} stroke="none" />
  </>,
  torpedoBomber: <>
    {plane.fus}
    <path d="M1.5 5.5H14.5" />
    {plane.tail}
    <rect x="10.2" y="7.5" width="2.2" height="5.5" rx="1.1" fill={F} stroke="none" />
  </>,
  recon: <>
    <path d="M8 6.5V14" />
    <path d="M1.5 9H14.5" />
    <path d="M5.5 14H10.5" />
    <circle cx="8" cy="4" r="2.2" />
  </>,
  seaplane: <>
    {plane.fus}
    <path d="M1.5 6H14.5" />
    {plane.tail}
    <path d="M4 8.5V14M12 8.5V14" />
  </>,
  radar: <>
    <path d="M2.5 13.5H11" />
    <path d="M6 13.5V10" />
    <path d="M2.5 3.5A8 8 0 0 0 10 11z" fill={F} fillOpacity=".35" />
    <path d="M10.8 3.2a3.5 3.5 0 0 1 2.4 2.4M10.6 0.9a6 6 0 0 1 4 4" />
  </>,
  sonar: <>
    <circle cx="4" cy="12" r="1.4" fill={F} stroke="none" />
    <path d="M4 7.5a4.5 4.5 0 0 1 4.5 4.5M4 3a9 9 0 0 1 9 9" />
  </>,
  depthCharge: <>
    <rect x="5" y="2" width="6" height="7.5" rx="1.6" />
    <path d="M5 5.7H11" />
    <path d="M1.5 12.5q1.6-1.8 3.2 0t3.2 0 3.2 0 3.2 0" />
  </>,
  armor: <path d="M8 1.8L13.5 3.8V8c0 3-2.5 5-5.5 6.2C5 13 2.5 11 2.5 8V3.8z" />,
  engine: <>
    <circle cx="8" cy="8" r="2.6" />
    <path d="M8 1.5V4M8 12v2.5M1.5 8H4M12 8h2.5M3.4 3.4l1.8 1.8M10.8 10.8l1.8 1.8M12.6 3.4l-1.8 1.8M5.2 10.8l-1.8 1.8" />
  </>,
  apShell: <>
    <path d="M2 5.5h6.5q4 0 5.5 2.5-1.5 2.5-5.5 2.5H2z" />
    <path d="M5 5.5v5" />
  </>,
  type3Shell: <>
    <path d="M2 6.5h4q2.5 0 3.5 1.5-1 1.5-3.5 1.5H2z" />
    <path d="M11.5 4.5L14 3M12 8h2.5M11.5 11.5L14 13" />
  </>,
  landingCraft: <>
    <path d="M1.5 8H14.5l-2 4.5H4z" />
    <path d="M14.5 8L13 4.5" />
    <path d="M4 8V5.5H8V8" />
  </>,
  amphibTank: <>
    <rect x="1.8" y="9.5" width="12" height="3.8" rx="1.9" />
    <path d="M4.5 9.5V6.5H9.5V9.5M9.5 7.8H14.5" />
  </>,
  drum: <>
    <rect x="3.5" y="2" width="9" height="12" rx="2" />
    <path d="M3.5 5.5H12.5M3.5 10.5H12.5" />
  </>,
  searchlight: <>
    <circle cx="4.5" cy="8" r="2.5" />
    <path d="M8 5.8L14.5 2.5M8 8h6.5M8 10.2l6.5 3.3" />
  </>,
  flare: <path d="M8 1.5L9.7 6.3 14.5 8 9.7 9.7 8 14.5 6.3 9.7 1.5 8 6.3 6.3z" />,
  repair: <>
    <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.4" />
    <path d="M8 5v6M5 8h6" />
  </>,
  supply: <>
    <rect x="2.2" y="4" width="11.6" height="9" rx="1.2" />
    <path d="M2.2 7.5H13.8M8 4v3.5" />
    <path d="M5 2h6" />
  </>,
  lbas: <>
    {plane.fus}
    <path d="M1.5 7.5H14.5" />
    {plane.tail}
    <circle cx="4.5" cy="5.2" r="1.5" fill={F} stroke="none" />
    <circle cx="11.5" cy="5.2" r="1.5" fill={F} stroke="none" />
  </>,
  jet: <>
    <path d="M8 1.5L13.8 13.5 8 11.2 2.2 13.5z" />
  </>,
  autogyro: <>
    <path d="M1.5 3H14.5M8 3v3" />
    <rect x="3.5" y="6" width="7" height="4" rx="2" />
    <path d="M10.5 8h4M4 12.5h6" />
  </>,
  crew: <>
    <circle cx="8" cy="5" r="2.5" />
    <path d="M3 14c0-3 2.2-4.8 5-4.8s5 1.8 5 4.8" />
  </>,
  other: <path d="M8 2L14 8 8 14 2 8z" />,
};

export interface EquipIconProps {
  /** 装備マスタの api_type[3] */
  iconId: number;
  className?: string;
  title?: string;
  /** 分類色を付ける (既定 true)。false なら currentColor */
  colored?: boolean;
}

export const EquipIcon = ({ iconId, className, title, colored = true }: EquipIconProps) => {
  const cat = equipIconCategory(iconId);
  return (
    <svg
      viewBox="0 0 16 16"
      className={cx("h-4 w-4 shrink-0", className)}
      style={colored ? { color: EQUIP_CATEGORY_COLOR[cat] } : undefined}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      {GLYPH[cat]}
    </svg>
  );
};
