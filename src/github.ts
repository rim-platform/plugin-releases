// The GitHub REST API calls of the plugin: the latest releases of a repository,
// with the user's token when they saved one, and what GitHub's refusals mean
// for a person.

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

/**
 * How the plugin asks GitHub: with the token from its settings, without one, or
 * without one because the host could not read the saved token (its secret vault is
 * locked). Only `token` sends anything; the other two differ in what a refusal says.
 */
export type Credentials =
  | { readonly kind: "token"; readonly token: string }
  | { readonly kind: "none" }
  | { readonly kind: "locked" };

/**
 * GitHub said no. `rateLimitedUntil` is set when the hourly limit is used up, and
 * `tokenRejected` when GitHub refused the token: both hold for every repository.
 */
export class GitHubError extends Error {
  readonly rateLimitedUntil: number | null;
  readonly tokenRejected: boolean;

  constructor(message: string, rateLimitedUntil: number | null = null, tokenRejected = false) {
    super(message);
    this.name = "GitHubError";
    this.rateLimitedUntil = rateLimitedUntil;
    this.tokenRejected = tokenRejected;
  }
}

/** Where the user saves the token, as the refusals name it. */
export const TOKEN_SETTING_PLACE =
  "the plugin's settings (the Plugins menu → Releases Settings, or Settings → Plugins) in the desktop app";

/** The message for an hourly limit that is used up until `at`, by how the plugin asked. */
function rateLimitMessage(credentials: Credentials, at: string): string {
  switch (credentials.kind) {
    case "token":
      return `GitHub refused: the requests an hour it allows with your token are used up. Try again after ${at}.`;
    case "locked":
      return (
        "GitHub refused: the 60 requests an hour it allows without a token are used up, and " +
        "the plugin could not read your GitHub token because the app's secret vault is locked; " +
        `unlock your system keyring. Try again after ${at}.`
      );
    case "none":
      return (
        "GitHub refused: the 60 requests an hour it allows without a token are used up. " +
        `Try again after ${at}, or add a GitHub token in ${TOKEN_SETTING_PLACE}.`
      );
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

/**
 * Fetch the latest published releases of `repo`, newest first, with `Authorization:
 * Bearer` when `credentials` holds a token. No message names the token.
 */
export async function fetchReleases(
  repo: string,
  fetchImpl: typeof fetch,
  credentials: Credentials = { kind: "none" },
): Promise<Release[]> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (credentials.kind === "token") headers.Authorization = `Bearer ${credentials.token}`;
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=5`, {
      headers,
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
    throw new GitHubError(rateLimitMessage(credentials, clock(until)), until);
  }
  if (response.status === 401 && credentials.kind === "token") {
    throw new GitHubError(
      `GitHub rejected the token in the plugin's settings: it may have expired or been revoked. Replace it in ${TOKEN_SETTING_PLACE}.`,
      null,
      true,
    );
  }
  if (response.status === 404) {
    throw new GitHubError(
      credentials.kind === "token"
        ? `${repo} was not found, or your token cannot read it.`
        : `${repo} was not found, or it is private.`,
    );
  }
  throw new GitHubError(`GitHub answered ${response.status} for ${repo}.`);
}
