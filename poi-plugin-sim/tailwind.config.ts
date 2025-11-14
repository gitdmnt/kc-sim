/** @type {import('tailwindcss').Config} */
export default {
  // スキャン対象をsrcディレクトリ内のファイルと、ルートのindex.htmlに限定します。
  // これにより、不要なファイルのスキャンを防ぎ、パフォーマンスを向上させます。
  content: ["./src/**/*.{js,ts,jsx,tsx}", "./index.html"],
  theme: {
    extend: {},
  },
  plugins: [],
};
