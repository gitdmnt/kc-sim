/**
 * Tailwind の出力を `.kcsim` 配下に閉じ込める PostCSS プラグイン。
 *  - @layer を展開する (poi 側の未レイヤーなスタイルに負けないよう、詳細度で勝つため)
 *  - :root / :host / html / body → .kcsim
 *  - それ以外のセレクタ → `.kcsim <selector>`
 * @keyframes / @font-face / @property 内のルールは触らない。
 */
const SCOPE = ".kcsim";
const ROOTS = new Set([":root", ":host", "html", "body"]);

const scopeSelector = (sel) => {
  const s = sel.trim();
  if (ROOTS.has(s)) return SCOPE;
  if (s === SCOPE || s.startsWith(`${SCOPE} `) || s.startsWith(`${SCOPE}.`) || s.startsWith(`${SCOPE}:`)) {
    return s;
  }
  return `${SCOPE} ${s}`;
};

const insideSkipped = (rule) => {
  for (let p = rule.parent; p; p = p.parent) {
    if (p.type === "atrule" && /^(-\w+-)?(keyframes|font-face|property|page)$/i.test(p.name)) return true;
  }
  return false;
};

export default function kcsimScope() {
  return {
    postcssPlugin: "postcss-kcsim-scope",
    OnceExit(root) {
      root.walkAtRules("layer", (at) => {
        if (at.nodes) at.replaceWith(at.nodes);
        else at.remove();
      });
      root.walkRules((rule) => {
        if (insideSkipped(rule)) return;
        rule.selectors = [...new Set(rule.selectors.map(scopeSelector))];
      });
    },
  };
}
kcsimScope.postcss = true;
