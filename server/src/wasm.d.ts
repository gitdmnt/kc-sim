// wrangler's CompiledWasm module rule: `import m from "x.wasm?module"` yields a compiled module. (The
// `?module` form avoids wasm-pack's own `x.wasm.d.ts`, which describes the instance exports instead.)
declare module "*.wasm?module" {
  const module: WebAssembly.Module;
  export default module;
}
