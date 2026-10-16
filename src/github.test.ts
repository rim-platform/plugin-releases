// Tests the GitHub calls with a pretend fetch: what a releases answer becomes,
// and what each of GitHub's refusals tells the person.
import { describe, expect, it } from "vitest";

import { fetchReleases, GitHubError, normalizeRepo, parseReleases } from "./github.ts";

const REPO = "rim-platform/rim-ui";

function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  const requests: Array<[string, RequestInit | undefined]> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push([String(input), init]);
    return Response.json(body, { status, headers });
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

describe("normalizeRepo", () => {
  it("takes owner/name or a github.com link and refuses anything else", () => {
    expect(normalizeRepo(" rim-platform/rim-ui ")).toBe("rim-platform/rim-ui");
    expect(normalizeRepo("https://github.com/rim-platform/rim-ui/")).toBe("rim-platform/rim-ui");
    for (const bad of ["rim-ui", "a/b/c", "owner/name.git", "http://github.com/a/b", "", 7, null]) {
      expect(normalizeRepo(bad)).toBeNull();
    }
  });
});

describe("parseReleases", () => {
  it("keeps published releases newest first, marks pre-releases and leaves drafts out", () => {
    const releases = parseReleases(REPO, [
      { tag_name: "v0.1.0", name: "Next", draft: true, prerelease: false },
      {
        tag_name: "v0.0.3-rc.1",
        name: "  Release\ncandidate ",
        body: "## Changed\n\n- Faster start",
        html_url: `https://github.com/${REPO}/releases/tag/v0.0.3-rc.1`,
        published_at: "2026-10-15T09:00:00Z",
        draft: false,
        prerelease: true,
      },
      {
        tag_name: "v0.0.2",
        name: "",
        body: "\n### Added\n\n- Desktop installers",
        html_url: `https://github.com/${REPO}/releases/tag/v0.0.2`,
        published_at: "2026-10-12T09:00:00Z",
      },
    ]);
    expect(releases).toEqual([
      {
        tag: "v0.0.3-rc.1",
        version: "0.0.3-rc.1",
        name: "Release candidate",
        firstLine: "Changed",
        url: `https://github.com/${REPO}/releases/tag/v0.0.3-rc.1`,
        publishedAt: "2026-10-15T09:00:00Z",
        prerelease: true,
      },
      {
        tag: "v0.0.2",
        version: "0.0.2",
        name: "",
        firstLine: "Added",
        url: `https://github.com/${REPO}/releases/tag/v0.0.2`,
        publishedAt: "2026-10-12T09:00:00Z",
        prerelease: false,
      },
    ]);
  });

  it("builds the release page itself when GitHub's link points anywhere else", () => {
    const [release] = parseReleases(REPO, [
      { tag_name: "release 1", html_url: "https://evil.example/rim-platform/rim-ui/releases/x" },
      { name: "no tag" },
      "not a release",
    ]);
    expect(release).toMatchObject({
      tag: "release 1",
      version: "release 1",
      name: "",
      firstLine: "",
      publishedAt: "",
      url: `https://github.com/${REPO}/releases/tag/release%201`,
    });
  });

  it("refuses an answer that is not a list", () => {
    expect(() => parseReleases(REPO, { message: "nope" })).toThrow(GitHubError);
  });
});

describe("fetchReleases", () => {
  it("asks for the five latest releases, without a token", async () => {
    const github = answer(200, [{ tag_name: "v0.0.1" }]);
    const releases = await fetchReleases(REPO, github.fetch);
    expect(releases.map((r) => r.tag)).toEqual(["v0.0.1"]);
    expect(github.requests).toEqual([
      [
        "https://api.github.com/repos/rim-platform/rim-ui/releases?per_page=5",
        { headers: { Accept: "application/vnd.github+json" } },
      ],
    ]);
  });

  it("says when the hourly limit is used up, and until when", async () => {
    const reset = Date.parse("2026-10-16T13:05:00Z");
    const github = answer(
      403,
      { message: "API rate limit exceeded" },
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset / 1000) },
    );
    const refusal = await fetchReleases(REPO, github.fetch).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(GitHubError);
    const date = new Date(reset);
    const at = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    expect((refusal as GitHubError).message).toBe(
      `GitHub refused: the 60 requests an hour it allows without a token are used up. Try again after ${at}.`,
    );
    expect((refusal as GitHubError).rateLimitedUntil).toBe(reset);
  });

  it("names a missing repository, another refusal and an unreachable GitHub", async () => {
    await expect(fetchReleases(REPO, answer(404, {}).fetch)).rejects.toThrow(
      "rim-platform/rim-ui was not found, or it is private.",
    );
    const forbidden = answer(403, {}, { "x-ratelimit-remaining": "12" });
    await expect(fetchReleases(REPO, forbidden.fetch)).rejects.toMatchObject({
      message: "GitHub answered 403 for rim-platform/rim-ui.",
      rateLimitedUntil: null,
    });
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    await expect(fetchReleases(REPO, offline)).rejects.toThrow("GitHub could not be reached.");
  });
});
