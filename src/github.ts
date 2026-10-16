// The GitHub REST API calls of the plugin: the latest releases of a public
// repository, without a token, and what GitHub's refusals mean for a person.

/** One published release, as the panel shows it and the plugin posts it. */
export interface Release {
  /** The tag, such as `v0.0.2`. */
  tag: string;
  /** The tag without a leading `v`, such as `0.0.2`. */
  version: string;
  /** The release's title, or `""`. */
  name: string;
  /** The first line of the release notes, as plain text, or `""`. */
  firstLine: string;
  /** Only ever a `https://github.com/<repo>/releases/` URL. */
  url: string;
  /** RFC 3339, or `""` when GitHub sent none. */
  publishedAt: string;
  prerelease: boolean;
}

/** GitHub said no; `rateLimitedUntil` is set when the hourly limit is used up. */
export class GitHubError extends Error {
  readonly rateLimitedUntil: number | null;

  constructor(message: string, rateLimitedUntil: number | null = null) {
    super(message);
    this.name = "GitHubError";
    this.rateLimitedUntil = rateLimitedUntil;
  }
}

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** `owner/name` trimmed, or null when it is not a repository name. */
export function normalizeRepo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const repo = value
    .trim()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\/+$/, "");
  return REPO.test(repo) && !repo.endsWith(".git") ? repo : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first line of markdown notes that has text, without heading or list markers. */
function firstLineOf(notes: unknown): string {
  if (typeof notes !== "string") return "";
  for (const line of notes.split(/\r?\n/)) {
    const text = line
      .replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*)/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text;
  }
  return "";
}

/** The release's page, from GitHub's `html_url` when it is one, else built from the tag. */
function releaseUrl(repo: string, tag: string, htmlUrl: unknown): string {
  const prefix = `https://github.com/${repo}/releases/`;
  if (
    typeof htmlUrl === "string" &&
    htmlUrl.toLowerCase().startsWith(prefix.toLowerCase()) &&
    !/\s/.test(htmlUrl)
  ) {
    return htmlUrl;
  }
  return `${prefix}tag/${encodeURIComponent(tag)}`;
}

/** The published releases in a `GET /repos/{owner}/{repo}/releases` answer, drafts left out. */
export function parseReleases(repo: string, body: unknown): Release[] {
  if (!Array.isArray(body))
    throw new GitHubError("GitHub sent something other than a list of releases.");
  return body
    .filter(isRecord)
    .filter((release) => release.draft !== true)
    .filter((release) => typeof release.tag_name === "string" && release.tag_name.trim() !== "")
    .map((release) => {
      const tag = String(release.tag_name).trim();
      return {
        tag,
        version: tag.replace(/^v(?=\d)/, ""),
        name: typeof release.name === "string" ? release.name.replace(/\s+/g, " ").trim() : "",
        firstLine: firstLineOf(release.body),
        url: releaseUrl(repo, tag, release.html_url),
        publishedAt: typeof release.published_at === "string" ? release.published_at : "",
        prerelease: release.prerelease === true,
      };
    });
}

function clock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Fetch the latest published releases of `repo`, newest first. */
export async function fetchReleases(repo: string, fetchImpl: typeof fetch): Promise<Release[]> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=5`, {
      headers: { Accept: "application/vnd.github+json" },
    });
  } catch {
    throw new GitHubError("GitHub could not be reached.");
  }
  if (response.ok) return parseReleases(repo, await response.json());
  const remaining = response.headers.get("x-ratelimit-remaining");
  if (
    (response.status === 403 || response.status === 429) &&
    (remaining === "0" || response.status === 429)
  ) {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const until = Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + 60 * 60 * 1000;
    throw new GitHubError(
      `GitHub refused: the 60 requests an hour it allows without a token are used up. Try again after ${clock(until)}.`,
      until,
    );
  }
  if (response.status === 404) throw new GitHubError(`${repo} was not found, or it is private.`);
  throw new GitHubError(`GitHub answered ${response.status} for ${repo}.`);
}
