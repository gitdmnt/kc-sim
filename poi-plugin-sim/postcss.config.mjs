import tailwind from "@tailwindcss/postcss";
import kcsimScope from "./postcss-kcsim-scope.mjs";

// 順序が重要: Tailwind が生成した後でスコープを付ける。
export default {
  plugins: [tailwind(), kcsimScope()],
};
