// GitHub Actions job summary: markdown appended to $GITHUB_STEP_SUMMARY when set (always echoed to stdout).
import { appendFileSync } from "node:fs";

export function appendSummary(markdown: string): void {
  console.log(markdown);
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
}
