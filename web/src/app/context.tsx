import React, { createContext, useContext } from "react";
import type { Catalog } from "../fleet/catalog";
import type { PoiConnection } from "../poiBridge";

export interface AppContextValue {
  /** poi の state (または同梱サンプル)。poi のデータが無ければ null */
  state: any;
  catalog: Catalog;
  /** poi プラグインとの接続状態 */
  poi: PoiConnection;
}

const Ctx = createContext<AppContextValue | null>(null);

export const AppProvider = ({ value, children }: { value: AppContextValue; children: React.ReactNode }) => (
  <Ctx.Provider value={value}>{children}</Ctx.Provider>
);

export const useApp = (): AppContextValue => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside <AppProvider>");
  return v;
};
