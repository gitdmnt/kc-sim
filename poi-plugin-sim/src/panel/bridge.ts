/**
 * プラグイン側の橋渡し (プロトコルは shared/embed/protocol.ts)。DOM に依存しない部分だけをここに置く
 * (iframe・postMessage・オリジン確認は WebFrame.tsx)。
 */
import { EMBED_SOURCE, EMBED_VERSION, parseWebMessage, projectConst, projectInfo } from "@shared/embed/protocol";
import type { PluginMessage, PoiState } from "@shared/embed/protocol";

export interface BridgeDeps {
  /** iframe へ送る (WebFrame が iframe のオリジン宛てに postMessage する) */
  post: (m: PluginMessage) => void;
  /** 移行するプリセット (kcsim-presets の JSON)。無ければ null */
  presetsJson: () => string | null;
  /** このオリジンへのプリセット移行が済んだか / 済んだことを記録する */
  presetsDone: () => boolean;
  markPresetsDone: () => void;
  /** Web UI のプロトコルの版 (ready で届く) */
  onWebVersion?: (v: number) => void;
}

/** info のうち Web UI が読む部分の参照。どれかが変わったら送り直す */
const infoParts = (info: unknown): unknown[] => {
  const p = projectInfo(info);
  return [p.fleets, p.ships, p.equips, p.basic.api_level];
};

export class EmbedBridge {
  private ready = false;
  private latest: PoiState | null = null;
  private sentConst: unknown = undefined;
  private constSent = false;
  private sentInfo: unknown[] | null = null;

  constructor(private deps: BridgeDeps) {}

  /** poi の state が変わったとき (WebFrame が間引いて呼ぶ)。ready 前は覚えておくだけ */
  update(state: PoiState) {
    this.latest = state;
    if (this.ready) this.flush();
  }

  /** iframe からのメッセージ (送り元とオリジンは WebFrame が確認済み)。 */
  onMessage(data: unknown) {
    const m = parseWebMessage(data);
    if (!m) return;
    if (m.type === "ready") {
      // 読み込み直した iframe は何も持っていないので、const も含めて全部送り直す
      this.ready = true;
      this.constSent = false;
      this.sentInfo = null;
      this.deps.onWebVersion?.(m.v);
      this.flush();
      this.sendPresets();
    } else if (m.type === "presets-ack") {
      this.deps.markPresetsDone();
    }
  }

  private flush() {
    if (!this.latest) return;
    const parts = infoParts(this.latest.info);
    const prev = this.sentInfo;
    const infoChanged = !prev || parts.some((p, i) => p !== prev[i]);
    const constChanged = !this.constSent || this.sentConst !== this.latest.const;
    if (!constChanged && !infoChanged) return;
    const msg: PluginMessage = { src: EMBED_SOURCE, v: EMBED_VERSION, type: "state", info: projectInfo(this.latest.info) };
    if (constChanged) msg.const = projectConst(this.latest.const);
    this.deps.post(msg);
    this.sentConst = this.latest.const;
    this.constSent = true;
    this.sentInfo = parts;
  }

  private sendPresets() {
    if (this.deps.presetsDone()) return;
    const json = this.deps.presetsJson();
    if (json === null) return;
    this.deps.post({ src: EMBED_SOURCE, v: EMBED_VERSION, type: "presets", json });
  }
}
