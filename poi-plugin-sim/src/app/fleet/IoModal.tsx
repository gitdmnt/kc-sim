import React, { useMemo, useState } from "react";
import type { Preset } from "../../fleet";
import { Button, Field, Modal, Select, Tabs, Textarea, TextInput, S, useToast } from "../../ui";
import { useApp } from "../context";
import { copyText } from "./clipboard";
import { getPresetStore } from "./presets";

type Format = "json" | "deckbuilder";
type Mode = "export" | "import";

interface Props {
  current: Preset | null;
  onClose: () => void;
  onImported: (presets: Preset[]) => void;
}

export const IoModal = ({ current, onClose, onImported }: Props) => {
  const { catalog } = useApp();
  const toast = useToast();
  const [format, setFormat] = useState<Format>("json");
  const [mode, setMode] = useState<Mode>("export");
  const [scope, setScope] = useState<"all" | "current">(current ? "current" : "all");
  const [text, setText] = useState("");
  const [deckFleet, setDeckFleet] = useState(1);
  const [deckName, setDeckName] = useState("");
  const store = getPresetStore();

  const exported = useMemo(() => {
    try {
      if (format === "json") return store.exportJSON(scope === "current" && current ? [current.id] : undefined);
      return current ? store.exportDeckBuilder(current.id, catalog.master) : "";
    } catch (e) {
      return `// ${(e as Error).message}`;
    }
  }, [format, scope, current, store, catalog]);

  const doImport = () => {
    try {
      const imported: Preset[] =
        format === "json"
          ? store.importJSON(text)
          : [
              store.importDeckBuilder(text, {
                fleet: deckFleet,
                name: deckName || undefined,
                master: catalog.master,
              }),
            ];
      toast.push(S.io.importDone(imported.length), "ok");
      onImported(imported);
      onClose();
    } catch (e) {
      toast.push(`${S.io.importFail}: ${(e as Error).message}`, "danger");
    }
  };

  return (
    <Modal
      title={S.io.title}
      onClose={onClose}
      footer={
        mode === "export" ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {S.common.close}
            </Button>
            <Button
              variant="primary"
              disabled={!exported || exported.startsWith("//")}
              onClick={async () => toast.push((await copyText(exported)) ? S.common.copied : "コピーに失敗しました", "ok")}
            >
              {S.common.copy}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {S.common.cancel}
            </Button>
            <Button variant="primary" disabled={!text.trim()} onClick={doImport}>
              {S.common.import}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Tabs
            variant="pill"
            tabs={[
              { id: "json", label: S.io.json },
              { id: "deckbuilder", label: S.io.deckbuilder },
            ]}
            value={format}
            onChange={setFormat}
          />
          <Tabs
            variant="pill"
            tabs={[
              { id: "export", label: S.io.exportTab },
              { id: "import", label: S.io.importTab },
            ]}
            value={mode}
            onChange={setMode}
          />
          {mode === "export" && format === "json" && (
            <Select className="w-40" value={scope} onChange={(e) => setScope(e.target.value as "all" | "current")}>
              <option value="all">{S.io.exportAll}</option>
              <option value="current" disabled={!current}>
                {S.io.exportCurrent}
              </option>
            </Select>
          )}
          {mode === "import" && format === "deckbuilder" && (
            <>
              <Field label={S.io.deckFleet} className="w-28">
                <Select value={deckFleet} onChange={(e) => setDeckFleet(Number(e.target.value))}>
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>
                      f{n}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={S.fleet.name} className="w-44">
                <TextInput value={deckName} onChange={(e) => setDeckName(e.target.value)} />
              </Field>
            </>
          )}
        </div>

        {mode === "export" ? (
          <Textarea readOnly value={exported} rows={14} onFocus={(e) => e.currentTarget.select()} />
        ) : (
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={14}
            placeholder={S.io.pasteHere}
          />
        )}
      </div>
    </Modal>
  );
};
