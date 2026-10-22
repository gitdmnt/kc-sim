export const cx = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter(Boolean).join(" ");

/** className に幅指定 (`w-…`) が無いときだけ既定の幅を付ける。Tailwind は同詳細度でクラスの記述順ではなく生成順が効くため、競合させない。 */
export const defaultWidth = (className: string | undefined, fallback = "w-full"): string =>
  className && /(^|\s)w-/.test(className) ? "" : fallback;
