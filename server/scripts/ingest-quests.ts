// Quest master data (docs/DATA_SOURCES.md §14) -> quests. Three GitHub files (~1.1 MB), one D1 batch; run daily by
// .github/workflows/jobs.yml so clients read the merged list from the worker instead of the upstream repos.
import { execStatements } from "./lib/d1";
import { fetchGithub, type GithubFile } from "./lib/fetch";
import { sourceUpsert, upsert } from "./lib/sql";
import { QUEST_SOURCE_KEYS, kc3QuestMeta, kc3QuestTranslations, kcwikiQuestData, mergeQuests } from "../src/quests";

const META = { owner: "KC3Kai", repo: "KC3Kai", ref: "master", path: "src/data/quests_meta.json" } satisfies GithubFile;
const JP = { owner: "KC3Kai", repo: "kc3-translations", ref: "master", path: "data/jp/quests.json" } satisfies GithubFile;
const KCWIKI = { owner: "kcwikizh", repo: "kcwiki-quest-data", ref: "gh-pages", path: "data.json" } satisfies GithubFile;

export async function ingestQuests(): Promise<void> {
  const [meta, jp, kcwiki] = await Promise.all([fetchGithub(META), fetchGithub(JP), fetchGithub(KCWIKI)]);
  const { quests, stats } = mergeQuests({
    kc3Meta: kc3QuestMeta.parse(JSON.parse(meta.text)),
    kc3Jp: kc3QuestTranslations.parse(JSON.parse(jp.text)),
    kcwiki: kcwikiQuestData.parse(JSON.parse(kcwiki.text)),
  });
  // A broken upstream must not wipe the served list.
  if (stats.quests < 300 || stats.edges < 300) throw new Error(`implausible quest data: ${JSON.stringify(stats)}`);
  const files = [[META, meta], [JP, jp], [KCWIKI, kcwiki]] as const;
  await execStatements("quests", [
    ...files.map(([f, got], i) => sourceUpsert({
      key: QUEST_SOURCE_KEYS[i]!, name: `${f.owner}/${f.repo} ${f.path}`, url: `https://github.com/${f.owner}/${f.repo}/blob/${f.ref}/${f.path}`,
      licence: "MIT", revision: got.revision,
    })),
    "DELETE FROM quests;",
    ...upsert("quests", quests.map((q) => ({
      id: q.id, code: q.code, name: q.name, detail: q.detail, memo: q.memo, pre: q.pre, requirements: q.requirements,
    })), ["id"]),
  ]);
  console.log(`quests: ${JSON.stringify(stats)}`);
}

if (import.meta.main) await ingestQuests();
