// Tests the GitHub calls with a pretend fetch: what a releases answer becomes,
// and what each of GitHub's refusals tells the person.
import { describe, expect, it } from "vitest";

import {
  credentialsFor,
  fetchReleases,
  GitHubError,
  INVALID_TOKEN_MESSAGE,
  normalizeRepo,
  parseReleases,
  requestHeaders,
} from "./github.ts";

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

  it("refuses . and .. as a name, which would point the request at another path", () => {
    for (const bad of ["owner/.", "owner/..", "https://github.com/owner/..", " owner/../ "]) {
      expect(normalizeRepo(bad)).toBeNull();
    }
    expect(normalizeRepo("owner/.github")).toBe("owner/.github");
    expect(normalizeRepo("owner/...")).toBe("owner/...");
  });
});

describe("credentialsFor", () => {
  it("trims the token and counts an empty one as unset", () => {
    expect(credentialsFor("  github_pat_abc\n")).toEqual({
      kind: "token",
      token: "github_pat_abc",
    });
    for (const unset of [undefined, null, "", "  \n", 7]) {
      expect(credentialsFor(unset)).toEqual({ kind: "none" });
      expect(credentialsFor(unset, true)).toEqual({ kind: "locked" });
    }
  });

  it("calls a token with anything but visible ASCII invalid", () => {
    for (const bad of [
      "github_pat_a b",
      "github_pat_a\nb",
      "github_pat_á",
      "tab\there",
      "x".repeat(1025),
    ]) {
      expect(credentialsFor(bad)).toEqual({ kind: "invalid" });
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

describe("requestHeaders", () => {
  const credentials = { kind: "token", token: "github_pat_abc" } as const;

  it("adds the bearer token only for https://api.github.com", () => {
    expect(
      requestHeaders(new URL("https://api.github.com/repos/a/b/releases"), credentials),
    ).toEqual({
      Accept: "application/vnd.github+json",
      Authorization: "Bearer github_pat_abc",
    });
    for (const elsewhere of [
      "http://api.github.com/repos/a/b/releases",
      "https://api.github.com:8443/repos/a/b/releases",
      "https://api.github.com.evil.example/repos/a/b/releases",
      "https://evil.example/https://api.github.com/",
      "https://github.com/a/b/releases",
    ]) {
      expect(requestHeaders(new URL(elsewhere), credentials)).toEqual({
        Accept: "application/vnd.github+json",
      });
    }
  });

  it("adds no token without one", () => {
    const url = new URL("https://api.github.com/repos/a/b/releases");
    for (const kind of ["none", "locked", "invalid"] as const) {
      expect(requestHeaders(url, { kind })).toEqual({ Accept: "application/vnd.github+json" });
    }
  });
});

describe("fetchReleases", () => {
  const TOKEN = "github_pat_11ABCDEFG0123456789_secretpart";
  const reset = Date.parse("2026-10-16T13:05:00Z");
  const date = new Date(reset);
  const at = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const limited = () =>
    answer(
      403,
      { message: "API rate limit exceeded" },
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset / 1000) },
    );

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
    for (const credentials of [{ kind: "none" }, { kind: "locked" }] as const) {
      await fetchReleases(REPO, github.fetch, credentials);
      expect(github.requests.at(-1)?.[1]).toEqual({
        headers: { Accept: "application/vnd.github+json" },
      });
    }
  });

  it("sends the token as a bearer token when there is one", async () => {
    const github = answer(200, [{ tag_name: "v0.0.1" }]);
    await fetchReleases(REPO, github.fetch, { kind: "token", token: TOKEN });
    expect(github.requests).toEqual([
      [
        "https://api.github.com/repos/rim-platform/rim-ui/releases?per_page=5",
        { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${TOKEN}` } },
      ],
    ]);
  });

  it("refuses an invalid token without asking GitHub", async () => {
    const github = answer(200, []);
    const refusal = await fetchReleases(REPO, github.fetch, { kind: "invalid" }).catch(
      (error: unknown) => error as GitHubError,
    );
    expect(refusal).toMatchObject({
      message:
        "The GitHub token in this plugin's settings is not valid; paste it again or clear it in the RIM desktop app (Plugin settings in the Releases panel's header, or Settings → Plugins).",
      tokenRejected: true,
    });
    expect((refusal as GitHubError).message).toBe(INVALID_TOKEN_MESSAGE);
    expect(github.requests).toEqual([]);
  });

  it("says when the hourly limit is used up, and until when", async () => {
    const refusal = await fetchReleases(REPO, limited().fetch).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(GitHubError);
    expect((refusal as GitHubError).message).toBe(
      `GitHub refused: the 60 requests an hour it allows without a token are used up. Try again after ${at}, or add a GitHub token in this plugin's settings in the RIM desktop app (Plugin settings in the Releases panel's header, or Settings → Plugins).`,
    );
    expect((refusal as GitHubError).rateLimitedUntil).toBe(reset);
  });

  it("says the token could not be read, or was used up, rather than to add one", async () => {
    await expect(fetchReleases(REPO, limited().fetch, { kind: "locked" })).rejects.toMatchObject({
      message: `GitHub refused: the 60 requests an hour it allows without a token are used up, and the plugin could not read your GitHub token because the app's secret vault is locked; unlock your system keyring. Try again after ${at}.`,
      rateLimitedUntil: reset,
    });
    const withToken = await fetchReleases(REPO, limited().fetch, {
      kind: "token",
      token: TOKEN,
    }).catch((error: unknown) => error as GitHubError);
    expect(withToken).toMatchObject({
      message: `GitHub refused: the requests an hour it allows with your token are used up. Try again after ${at}.`,
      rateLimitedUntil: reset,
    });
    expect((withToken as GitHubError).message).not.toContain(TOKEN);
  });

  it("says when GitHub rejects the token, without naming it", async () => {
    const github = answer(401, { message: "Bad credentials" });
    const refusal = await fetchReleases(REPO, github.fetch, { kind: "token", token: TOKEN }).catch(
      (error: unknown) => error as GitHubError,
    );
    expect(refusal).toMatchObject({
      message:
        "GitHub rejected the token in this plugin's settings: it may have expired or been revoked. Replace it in the RIM desktop app (Plugin settings in the Releases panel's header, or Settings → Plugins).",
      tokenRejected: true,
      rateLimitedUntil: null,
    });
    expect(JSON.stringify(refusal) + String(refusal)).not.toContain(TOKEN);
    await expect(fetchReleases(REPO, github.fetch)).rejects.toMatchObject({
      message: "GitHub answered 401 for rim-platform/rim-ui.",
      tokenRejected: false,
    });
  });

  it("names a missing repository, another refusal and an unreachable GitHub", async () => {
    await expect(fetchReleases(REPO, answer(404, {}).fetch)).rejects.toThrow(
      "rim-platform/rim-ui was not found, or it is private.",
    );
    await expect(
      fetchReleases(REPO, answer(404, {}).fetch, { kind: "token", token: TOKEN }),
    ).rejects.toThrow("rim-platform/rim-ui was not found, or your token cannot read it.");
    const forbidden = answer(403, {}, { "x-ratelimit-remaining": "12" });
    await expect(fetchReleases(REPO, forbidden.fetch)).rejects.toMatchObject({
      message: "GitHub answered 403 for rim-platform/rim-ui.",
      rateLimitedUntil: null,
    });
    const offline = (async () => {
      throw new TypeError(`Failed to fetch with Bearer ${TOKEN}`);
    }) as typeof fetch;
    await expect(fetchReleases(REPO, offline, { kind: "token", token: TOKEN })).rejects.toThrow(
      /^GitHub could not be reached\.$/,
    );
  });
});
