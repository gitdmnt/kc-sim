// Source download + revision lookup for ingest jobs.

export interface GithubFile {
  owner: string;
  repo: string;
  ref: string;
  path: string;
}

export const rawUrl = (f: GithubFile) => `https://raw.githubusercontent.com/${f.owner}/${f.repo}/${f.ref}/${f.path}`;

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "kc-sim-ingest" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

/**
 * Revision of a GitHub file: sha of the last commit touching it (GitHub API, unauthenticated,
 * 60 req/h; GITHUB_TOKEN is used when set), else `sha256:<content hash>`.
 */
export async function githubRevision(f: GithubFile, content: string): Promise<string> {
  const headers: Record<string, string> = { "User-Agent": "kc-sim-ingest", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const url = `https://api.github.com/repos/${f.owner}/${f.repo}/commits?path=${encodeURIComponent(f.path)}&sha=${f.ref}&per_page=1`;
    const res = await fetch(url, { headers });
    if (res.ok) {
      const commits = (await res.json()) as { sha: string }[];
      if (commits[0]?.sha) return commits[0].sha;
    }
  } catch {
    // fall through to the content hash
  }
  return `sha256:${new Bun.CryptoHasher("sha256").update(content).digest("hex")}`;
}

/** Downloads a GitHub file and resolves its revision. */
export async function fetchGithub(f: GithubFile): Promise<{ text: string; url: string; revision: string }> {
  const url = rawUrl(f);
  const text = await fetchText(url);
  return { text, url, revision: await githubRevision(f, text) };
}
