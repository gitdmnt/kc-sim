/**
 * マス固有の戦闘効果。阻塞気球マス: kancolle-replay `js/common.js` COMMON.BARRAGE_BALLOON_NODES
 * ("world-map-node"、イベント海域は world 57.. の番号)。
 */
const BALLOON_NODES: Record<string, true> = Object.fromEntries(
  [
    "3-5-H", "4-3-N", "4-5-T",
    "57-5-L1", "57-5-L2", "57-5-O", "57-6-C2", "57-6-Q", "57-7-A5", "57-7-H", "57-7-P", "57-7-U", "57-7-Z",
    "59-1-I", "59-1-M", "59-2-M", "59-2-U", "59-3-V1", "59-3-X",
    "60-1-O", "60-2-W", "60-3-R", "60-3-U", "60-5-Q", "60-5-Z",
    "62-5-J2", "62-5-L1", "62-5-L2", "62-5-P3", "62-5-S",
  ].map((k) => [k, true as const])
);

/** 阻塞気球が効くマスか (両艦隊の気球が有効になる)。 */
export const isBalloonNode = (world: number, map: number, node: string): boolean => BALLOON_NODES[`${world}-${map}-${node}`] === true;
