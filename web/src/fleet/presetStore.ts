import { parseDeckBuilder, toDeckBuilder } from "./deckbuilder";
import type { DeckBuilderData, DeckBuilderImportOptions } from "./deckbuilder";
import { normalizePreset } from "./normalize";
import { defaultStorage, keysWithPrefix } from "./storage";
import type { KeyValueStorage } from "./storage";
import type { MasterData, Preset } from "@shared/fleet/types";

export const STORAGE_PREFIX = "kcsim:";
const PRESET_PREFIX = `${STORAGE_PREFIX}preset:`;
export const EXPORT_FORMAT = "kcsim-presets";

export interface PresetStoreOptions {
  storage?: KeyValueStorage;
  now?: () => number;
  genId?: () => string;
}

export class PresetStore {
  private storage: KeyValueStorage;
  private now: () => number;
  private genId: () => string;

  constructor(opts: PresetStoreOptions = {}) {
    this.storage = opts.storage ?? defaultStorage();
    this.now = opts.now ?? Date.now;
    this.genId =
      opts.genId ??
      (() => `p_${this.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  }

  private key(id: string) {
    return `${PRESET_PREFIX}${id}`;
  }

  /** 更新日時の新しい順。壊れたエントリは無視する。 */
  list(): Preset[] {
    const presets: Preset[] = [];
    for (const key of keysWithPrefix(this.storage, PRESET_PREFIX)) {
      const p = this.get(key.slice(PRESET_PREFIX.length));
      if (p) presets.push(p);
    }
    return presets.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Preset | null {
    const text = this.storage.getItem(this.key(id));
    if (text === null) return null;
    try {
      return normalizePreset(JSON.parse(text), this.genId, this.now());
    } catch {
      return null;
    }
  }

  /** 保存し updatedAt を更新して返す。id が無ければ採番する。 */
  save(preset: Omit<Preset, "id"> & { id?: string }): Preset {
    const now = this.now();
    const saved: Preset = {
      ...preset,
      id: preset.id ?? this.genId(),
      createdAt: preset.createdAt ?? now,
      updatedAt: now,
    };
    this.storage.setItem(this.key(saved.id), JSON.stringify(saved));
    return saved;
  }

  remove(id: string): void {
    this.storage.removeItem(this.key(id));
  }

  // ---- JSON ----

  exportJSON(ids?: string[]): string {
    const presets = this.list().filter((p) => !ids || ids.includes(p.id));
    return JSON.stringify({ format: EXPORT_FORMAT, version: 1, presets }, null, 2);
  }

  /**
   * `exportJSON` の出力、または単体 Preset の JSON を取り込む。
   * id が衝突したら採番し直す。overwrite=true なら上書き、skipExisting=true なら取り込まない
   * (poi プラグインからの移行を何度受け取っても増えないように)。
   */
  importJSON(text: string, opts: { overwrite?: boolean; skipExisting?: boolean } = {}): Preset[] {
    const data = JSON.parse(text);
    const rawList: unknown[] = Array.isArray(data?.presets)
      ? data.presets
      : [data];
    const imported: Preset[] = [];
    for (const raw of rawList) {
      const p = normalizePreset(raw, this.genId, this.now());
      if (!opts.overwrite && this.get(p.id)) {
        if (opts.skipExisting) continue;
        p.id = this.genId();
      }
      p.source = "import";
      imported.push(this.save(p));
    }
    return imported;
  }

  // ---- DeckBuilder ----

  exportDeckBuilder(id: string, master?: MasterData): string {
    const p = this.get(id);
    if (!p) throw new Error(`Preset not found: ${id}`);
    return JSON.stringify(toDeckBuilder(p, master));
  }

  importDeckBuilder(
    input: string | DeckBuilderData,
    opts: DeckBuilderImportOptions = {}
  ): Preset {
    const p = parseDeckBuilder(input, {
      now: this.now(),
      genId: this.genId,
      ...opts,
    });
    return this.save(p);
  }
}
