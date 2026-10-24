// Quest master data (docs/DATA_SOURCES.md §14) -> quests. Four GitHub files (~1.6 MB) and the hand-authored
// overrides (shared/quest/overrides.json), one D1 batch; run daily by .github/workflows/jobs.yml so clients read the
// merged list from the worker instead of the upstream repos.
import { execStatements } from "./lib/d1";
import { fetchGithub, type GithubFile } from "./lib/fetch";
import { sourceUpsert, upsert } from "./lib/sql";
import { QUEST_SOURCE_KEYS, kc3QuestMeta, kc3QuestTranslations, kcwikiQuestData, mergeQuests } from "../src/quests";
import { kcanotifyQuests } from "../src/questRewards";
import { QUEST_OVERRIDES_PATH, parseQuestOverrides } from "../src/questOverrides";

const META = { owner: "KC3Kai", repo: "KC3Kai", ref: "master", path: "src/data/quests_meta.json" } satisfies GithubFile;
const JP = { owner: "KC3Kai", repo: "kc3-translations", ref: "master", path: "data/jp/quests.json" } satisfies GithubFile;
const KCWIKI = { owner: "kcwikizh", repo: "kcwiki-quest-data", ref: "gh-pages", path: "data.json" } satisfies GithubFile;
const KCANOTIFY = { owner: "antest1", repo: "kcanotify-gamedata", ref: "master", path: "files/quests-jp.json" } satisfies GithubFile;

export async function ingestQuests(): Promise<void> {
  const [meta, jp, kcwiki, kcanotify] = await Promise.all([fetchGithub(META), fetchGithub(JP), fetchGithub(KCWIKI), fetchGithub(KCANOTIFY)]);
  const overridesText = await Bun.file(QUEST_OVERRIDES_PATH).text();
  const { quests, stats } = mergeQuests({
    kc3Meta: kc3QuestMeta.parse(JSON.parse(meta.text)),
    kc3Jp: kc3QuestTranslations.parse(JSON.parse(jp.text)),
    kcwiki: kcwikiQuestData.parse(JSON.parse(kcwiki.text)),
    kcanotify: kcanotifyQuests.parse(JSON.parse(kcanotify.text)),
    overrides: parseQuestOverrides(JSON.parse(overridesText)),
  });
  // A broken upstream must not wipe the served list.
  if (stats.quests < 300 || stats.edges < 300) throw new Error(`implausible quest data: ${JSON.stringify(stats)}`);
  const files = [[META, meta], [JP, jp], [KCWIKI, kcwiki], [KCANOTIFY, kcanotify]] as const;
  await execStatements("quests", [
    ...files.map(([f, got], i) => sourceUpsert({
      key: QUEST_SOURCE_KEYS[i]!, name: `${f.owner}/${f.repo} ${f.path}`, url: `https://github.com/${f.owner}/${f.repo}/blob/${f.ref}/${f.path}`,
      licence: "MIT", revision: got.revision,
    })),
    sourceUpsert({
      key: QUEST_SOURCE_KEYS[4], name: "kc-sim shared/quest/overrides.json (hand-authored, zekamashi.net as reference)",
      url: "https://zekamashi.net/", licence: "ours (structured facts; no text copied)",
      revision: `sha256:${new Bun.CryptoHasher("sha256").update(overridesText).digest("hex")}`,
    }),
    "DELETE FROM quests;",
    ...upsert("quests", quests.map((q) => ({
      id: q.id, code: q.code, name: q.name, detail: q.detail, memo: q.memo, pre: q.pre, requirements: q.requirements,
      rewards: q.rewards ?? null, override: q.override ?? null,
    })), ["id"]),
  ]);
  const { noRewards, ...counts } = stats;
  console.log(`quests: ${JSON.stringify(counts)}`);
  console.log(
    `rewards: ${stats.withRewards}/${stats.quests} (override ${stats.overriddenRewards}, kcanotify ${stats.rewardsKcanotify}, ` +
      `kcwiki ${stats.rewardsKcwiki}, KC3 memo ${stats.rewardsKc3Memo}); none: ${noRewards.map((id) => quests.find((q) => q.id === id)?.code ?? `#${id}`).join(", ") || "-"}`,
  );
}

if (import.meta.main) await ingestQuests();
