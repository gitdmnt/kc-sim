/**
 * poi 無しで UI を動かす開発サーバ。`bun run dev` (既定ポート 5173、`--port N` か PORT で変更)。
 *
 * - dev/main.tsx と Worker を Bun.build でメモリ上にバンドルして配る
 * - CSS は poi 向けビルドと同じ PostCSS (Tailwind + .kcsim スコープ) で作る
 * - src/ assets/ dev/ と sim-core/pkg の変更で作り直し、ページを再読み込みさせる
 */
import { existsSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import postcss from "postcss";
import postcssConfig from "../postcss.config.mjs";
import { wasmBytes } from "./plugins";

const ROOT = resolve(import.meta.dir, "..");
const CSS_ENTRY = join(ROOT, "assets/styles.css");
const MAPS_DIR = resolve(ROOT, "../data-worker/dist/maps");
const STATE_FILE = [join(ROOT, "myState.json"), join(ROOT, "dev/sampleState.json")].find(existsSync)!;

const { values: args } = parseArgs({ options: { port: { type: "string" } } });
const port = Number(args.port ?? process.env.PORT ?? 5173);

const HTML = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>kcsim (dev)</title>
  <link rel="stylesheet" href="/kcsim.css" />
  <style>body { margin: 0; background: #060c17; }</style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/main.js"></script>
</body>
</html>`;

/** パス → 内容。直近で成功したビルド */
let files = new Map<string, Blob>();
let css = "";
let buildError: string | null = null;

const errorScript = (msg: string) =>
  `document.body.innerHTML = "";const p = document.body.appendChild(document.createElement("pre"));` +
  `p.style.cssText = "color:#f49ca2;padding:16px;white-space:pre-wrap;font:13px ui-monospace,monospace";` +
  `p.textContent = ${JSON.stringify(msg)};new EventSource("/__reload").addEventListener("reload", () => location.reload());`;

const build = async () => {
  const started = performance.now();
  try {
    const [js, styles] = await Promise.all([
      Bun.build({
        entrypoints: [join(ROOT, "dev/main.tsx"), join(ROOT, "src/sim/sim.worker.ts")],
        target: "browser",
        format: "esm",
        sourcemap: "inline",
        naming: { entry: "[name].[ext]", asset: "[name].[ext]" },
        define: { "import.meta.env.DEV": "true", "process.env.NODE_ENV": JSON.stringify("development") },
        plugins: [wasmBytes],
        throw: false,
      }),
      postcss(postcssConfig.plugins).process(await Bun.file(CSS_ENTRY).text(), { from: CSS_ENTRY }),
    ]);
    if (!js.success) throw new AggregateError(js.logs, js.logs.map(String).join("\n"));
    files = new Map(js.outputs.map((o) => [`/${o.path.replace(/^\.\//, "")}`, o]));
    css = styles.css;
    buildError = null;
    console.log(`built in ${Math.round(performance.now() - started)} ms`);
  } catch (e) {
    buildError = e instanceof Error ? e.message : String(e);
    console.error(`build failed:\n${buildError}`);
  }
};

const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const sse = (s: string) => new TextEncoder().encode(s);
const reloadAll = () => {
  for (const c of clients) c.enqueue(sse("event: reload\ndata: \n\n"));
};

let timer: Timer | undefined;
const onChange = () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await build();
    reloadAll();
  }, 80);
};
for (const dir of ["src", "assets", "dev"]) watch(join(ROOT, dir), { recursive: true }, onChange);
const simCorePkg = resolve(ROOT, "../sim-core/pkg");
if (existsSync(simCorePkg)) watch(simCorePkg, onChange);

await build();

const js = (body: string | Blob) => new Response(body, { headers: { "content-type": "text/javascript; charset=utf-8" } });

Bun.serve({
  port,
  idleTimeout: 0, // SSE を切らない
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/") return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (pathname === "/kcsim.css") return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
    if (pathname === "/state.json") return new Response(Bun.file(STATE_FILE));
    if (pathname === "/__reload") {
      let self: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => {
          clients.add((self = c));
          c.enqueue(sse(": connected\n\n")); // 最初の 1 バイトを送ってヘッダを確定させる
        },
        cancel: () => void clients.delete(self),
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }
    if (pathname.startsWith("/maps/")) {
      const f = Bun.file(join(MAPS_DIR, pathname.slice("/maps/".length)));
      return (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 });
    }
    if (buildError && pathname === "/main.js") return js(errorScript(buildError));
    const out = files.get(pathname);
    if (out) return pathname.endsWith(".js") ? js(out) : new Response(out);
    return new Response("not found", { status: 404 });
  },
});

console.log(`Local: http://localhost:${port}/`);
