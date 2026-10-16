// Tests the Releases plugin over a MessageChannel, as its frame runs, with a
// pretend GitHub, the host's store and its chat: no RIM app and no network needed.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { startTestHost, validateManifest } from "@rim-platform/plugin-sdk/testing";

import {
  createPlugin,
  DEFAULT_REPOS,
  MAX_REPOS,
  PANEL_ID,
  REFRESH_FLOOR_MS,
  type LatestRelease,
  type PanelState,
} from "./plugin.ts";

const MANIFEST = `${import.meta.dirname}/../rim-plugin.json`;
const T0 = Date.parse("2026-10-16T12:00:00Z");
const CONVERSATION = { conversation_id: "conv-1" };

type RawRelease = Record<string, unknown>;

/** GitHub's releases of each repository; a repository missing here answers 404. */
const RELEASES: Record<string, RawRelease[]> = {
  "rim-platform/rim-ui": [
    { tag_name: "v0.1.0", name: "Unfinished", draft: true },
    {
      tag_name: "v0.0.2",
      name: "Desktop installers",
      body: "### Added\n\n- Installers",
      html_url: "https://github.com/rim-platform/rim-ui/releases/tag/v0.0.2",
      published_at: "2026-10-16T09:00:00Z",
      prerelease: false,
    },
    {
      tag_name: "v0.0.1",
      name: "v0.0.1",
      html_url: "https://github.com/rim-platform/rim-ui/releases/tag/v0.0.1",
      published_at: "2026-10-01T09:00:00Z",
    },
  ],
  "rim-platform/rim-server": [
    {
      tag_name: "v0.0.3-rc.1",
      name: "v0.0.3-rc.1",
      body: `Ping <@rimp1_someone> about ${"a very long line ".repeat(20)}`,
      html_url: "https://github.com/rim-platform/rim-server/releases/tag/v0.0.3-rc.1",
      published_at: "2026-10-15T09:00:00Z",
      prerelease: true,
    },
  ],
  "rim-platform/plugin-github-prs": [],
  "rim-platform/plugin-k8s-pods": [
    {
      tag_name: "v0.0.1",
      name: "",
      body: "",
      html_url: "https://github.com/rim-platform/plugin-k8s-pods/releases/tag/v0.0.1",
      published_at: "2026-10-14T09:00:00Z",
    },
  ],
};

const RIM_UI_POST =
  "🚀 rim-ui 0.0.2 is out\nDesktop installers\nhttps://github.com/rim-platform/rim-ui/releases/tag/v0.0.2";

interface FakeGitHub {
  fetch: typeof fetch;
  requests: string[];
  /** Answer the next requests with GitHub's hourly-limit refusal. */
  limit: () => void;
}

function fakeGitHub(): FakeGitHub {
  const requests: string[] = [];
  let limited = false;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    expect(init?.headers).toEqual({ Accept: "application/vnd.github+json" });
    if (limited) {
      return new Response("{}", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String((T0 + 3_600_000) / 1000),
        },
      });
    }
    const repo = /repos\/([^/]+\/[^/]+)\/releases\?per_page=5$/.exec(url)?.[1] ?? "";
    const releases = RELEASES[repo];
    return releases ? Response.json(releases) : new Response("{}", { status: 404 });
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    requests,
    limit: () => {
      limited = true;
    },
  };
}

interface StartOptions {
  stored?: unknown;
  principal?: null;
  granted?: string[];
  /** Answers `rim.chat.post_message`; the default gives each post a new id. */
  post?: (params: PostParams) => unknown;
}

interface PostParams {
  conversationId: string;
  body: string;
  threadId?: string;
}

function start(options: StartOptions = {}) {
  const github = fakeGitHub();
  const clock = { now: T0 };
  const store = new Map<string, unknown>([["repos", options.stored ?? null]]);
  const panels: PanelState[] = [];
  const posts: PostParams[] = [];
  const host = startTestHost(createPlugin({ fetch: github.fetch, now: () => clock.now }), {
    transport: "port",
    manifestPath: MANIFEST,
    grantedCapabilities: options.granted ?? ["ui.panel", "network.fetch", "chat.write"],
    ...(options.principal === null ? { principal: null } : {}),
    onRequest(method, params) {
      const p = params as { key: string; value?: unknown; panel_id: string; state: PanelState };
      if (method === "rim.storage.get") return { value: store.get(p.key) ?? null };
      if (method === "rim.storage.set") {
        store.set(p.key, p.value);
        return { ok: true };
      }
      if (method === "rim.chat.post_message") {
        const post = params as PostParams;
        posts.push(post);
        return options.post ? options.post(post) : { id: `msg-${posts.length}` };
      }
      if (method === "rim.ui.update_panel" && p.panel_id === PANEL_ID) panels.push(p.state);
      return { ok: true };
    },
  });
  return { host, github, clock, store, panels, posts, panel: () => panels.at(-1) as PanelState };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((done) => setTimeout(done, 5));
  expect(check()).toBe(true);
}

/** Start the plugin and wait for its first fetch of the list to finish. */
async function started(options: StartOptions = {}) {
  const t = start(options);
  expect((await t.host.handshake()).accepted).toBe(true);
  await until(() => t.panels.some((p) => !p.loading && p.fetchedAt !== null));
  return t;
}

describe("releases plugin", () => {
  it("has a manifest the host installs once bundled", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    expect(() =>
      validateManifest(manifest, { forbiddenOrigins: ["https://rim.example"] }),
    ).not.toThrow();
    const post = manifest.commands.find((c: { id: string }) => c.id === "releases.post");
    expect(post.required_context).toEqual(["conversation"]);
    expect(post.arguments.map((a: { name: string }) => a.name)).toEqual(["repo"]);
  });

  it("starts with the project's repositories and shows their latest releases", async () => {
    const t = await started();
    const state = t.panel();
    expect(state.repos.map((r) => [r.repo, r.releases.map((x) => x.tag), r.error])).toEqual([
      ["rim-platform/rim-ui", ["v0.0.2", "v0.0.1"], null],
      ["rim-platform/rim-server", ["v0.0.3-rc.1"], null],
      ["rim-platform/plugin-github-prs", [], null],
      ["rim-platform/plugin-k8s-pods", ["v0.0.1"], null],
    ]);
    expect(state.repos[1].releases[0].prerelease).toBe(true);
    expect(t.github.requests).toEqual(
      DEFAULT_REPOS.map((repo) => `https://api.github.com/repos/${repo}/releases?per_page=5`),
    );
    await t.host.shutdown();
  });

  it("refreshes at most every 2 minutes", async () => {
    const t = await started({ stored: ["rim-platform/rim-ui"] });
    const early = await t.host.execute("refresh");
    expect(early.result?.message).toBe(
      "Fetched less than 2 minutes ago. GitHub allows 60 requests an hour without a token.",
    );
    expect(t.panel().notice).toBe(early.result?.message);
    expect(t.github.requests).toHaveLength(1);
    t.clock.now += REFRESH_FLOOR_MS;
    expect((await t.host.execute("refresh")).result?.message).toBe(
      "Latest releases of 1 of 1 repository",
    );
    expect(t.panel().notice).toBeNull();
    expect(t.github.requests).toHaveLength(2);
    await t.host.shutdown();
  });

  it("says when GitHub refuses and stops asking until the limit resets", async () => {
    const t = start({ stored: ["rim-platform/rim-ui", "rim-platform/rim-server"] });
    t.github.limit();
    await t.host.handshake();
    await until(() => typeof t.panel()?.notice === "string");
    expect(t.panel().notice).toMatch(
      /^GitHub refused: the 60 requests an hour it allows without a token are used up\./,
    );
    expect(t.github.requests).toHaveLength(1);
    t.clock.now += REFRESH_FLOOR_MS;
    expect((await t.host.execute("refresh")).result?.message).toMatch(/^GitHub refused/);
    const latest = await t.host.execute("releases.latest");
    expect(latest.result?.message).toMatch(/^GitHub refused/);
    const post = await t.host.execute("releases.post", CONVERSATION);
    expect(post.error?.message).toMatch(/^Nothing to post\. GitHub refused/);
    expect(t.github.requests).toHaveLength(1);
    expect(t.posts).toEqual([]);
    await t.host.shutdown();
  });

  it("keeps a saved list, even an emptied one, and holds at most 10", async () => {
    const t = await started();
    for (const repo of DEFAULT_REPOS) await t.host.execute("remove_repo", { repo });
    expect(t.store.get("repos")).toEqual([]);
    await t.host.shutdown();

    const emptied = start({ stored: [] });
    await emptied.host.handshake();
    await until(() => emptied.panels.length > 0);
    expect(emptied.panel().repos).toEqual([]);
    expect(emptied.github.requests).toHaveLength(0);
    expect((await emptied.host.execute("releases.post", CONVERSATION)).error?.message).toBe(
      "No repositories yet: add one in the panel.",
    );

    const added = await emptied.host.execute("add_repo", {
      repo: "https://github.com/rim-platform/rim-ui/",
    });
    expect(added.result?.message).toBe("Added rim-platform/rim-ui");
    expect(emptied.store.get("repos")).toEqual(["rim-platform/rim-ui"]);
    expect(emptied.panel().repos[0].releases).toHaveLength(2);
    expect(
      (await emptied.host.execute("add_repo", { repo: "RIM-platform/rim-ui" })).result?.message,
    ).toBe("RIM-platform/rim-ui is already in the list");
    expect((await emptied.host.execute("add_repo", { repo: "not a repo" })).error).toMatchObject({
      code: -32602,
    });
    for (let i = 1; i < MAX_REPOS; i++)
      await emptied.host.execute("add_repo", { repo: `acme/repo-${i}` });
    expect(emptied.store.get("repos")).toHaveLength(MAX_REPOS);
    expect(emptied.panel().repos[1].error).toBe("acme/repo-1 was not found, or it is private.");
    expect(
      (await emptied.host.execute("add_repo", { repo: "acme/one-too-many" })).error?.message,
    ).toBe("The list holds at most 10 repositories; remove one first.");
    expect(
      (await emptied.host.execute("remove_repo", { repo: "rim-platform/RIM-UI" })).result?.message,
    ).toBe("Removed rim-platform/RIM-UI");
    expect(emptied.store.get("repos")).not.toContain("rim-platform/rim-ui");
    await emptied.host.shutdown();
  });

  it("keeps no list while nobody is signed in", async () => {
    const t = start({ stored: ["rim-platform/rim-ui"], principal: null });
    await t.host.handshake();
    await until(() => t.panels.length > 0);
    expect(t.panel()).toMatchObject({ signedIn: false, repos: [] });
    expect((await t.host.execute("add_repo", { repo: "rim-platform/rim-ui" })).error?.message).toBe(
      "Sign in to keep a list of repositories.",
    );
    expect((await t.host.execute("releases.post", CONVERSATION)).error?.message).toBe(
      "Sign in to keep a list of repositories.",
    );
    expect((await t.host.execute("releases.latest")).result?.payload).toEqual([]);
    expect(t.github.requests).toHaveLength(0);
    await t.host.shutdown();
  });

  it("posts the latest release of each repository into the open conversation", async () => {
    const t = await started();
    const answer = await t.host.execute("releases.post", CONVERSATION);
    expect(t.posts).toEqual([
      { conversationId: "conv-1", body: RIM_UI_POST },
      {
        conversationId: "conv-1",
        body:
          "🚀 rim-server 0.0.3-rc.1 is out (pre-release)\n" +
          `Ping < @rimp1_someone> about ${"a very long line ".repeat(20)}`.slice(0, 199) +
          "…\nhttps://github.com/rim-platform/rim-server/releases/tag/v0.0.3-rc.1",
      },
      {
        conversationId: "conv-1",
        body: "🚀 plugin-k8s-pods 0.0.1 is out\nhttps://github.com/rim-platform/plugin-k8s-pods/releases/tag/v0.0.1",
      },
    ]);
    expect(answer.result).toEqual({
      payload: {
        posted: [
          { repo: "rim-platform/rim-ui", tag: "v0.0.2", messageId: "msg-1" },
          { repo: "rim-platform/rim-server", tag: "v0.0.3-rc.1", messageId: "msg-2" },
          { repo: "rim-platform/plugin-k8s-pods", tag: "v0.0.1", messageId: "msg-3" },
        ],
      },
      message: "Posted 3 releases. rim-platform/plugin-github-prs has no published release.",
    });
    // The list was fetched a moment ago, so posting asked GitHub nothing more.
    expect(t.github.requests).toHaveLength(DEFAULT_REPOS.length);
    await t.host.shutdown();
  });

  it("posts one repository into the open thread, after fetching a stale list again", async () => {
    const t = await started();
    t.clock.now += REFRESH_FLOOR_MS;
    const answer = await t.host.execute("releases.post", {
      ...CONVERSATION,
      thread_id: "thread-9",
      repo: "https://github.com/rim-platform/RIM-UI",
    });
    expect(answer.result?.message).toBe("Posted 1 release");
    expect(t.posts).toEqual([
      { conversationId: "conv-1", body: RIM_UI_POST, threadId: "thread-9" },
    ]);
    expect(t.github.requests).toHaveLength(2 * DEFAULT_REPOS.length);
    await t.host.shutdown();
  });

  it("refuses to post without an open conversation or for a repository off the list", async () => {
    const t = await started();
    for (const args of [{}, { conversation_id: "" }, { conversation_id: 7 }]) {
      expect((await t.host.execute("releases.post", args)).error).toEqual({
        code: -32602,
        message: "Open a conversation to post releases into it.",
      });
    }
    expect(
      (await t.host.execute("releases.post", { ...CONVERSATION, thread_id: 3 })).error?.message,
    ).toBe("thread_id must be the id of the open thread.");
    expect(
      (await t.host.execute("releases.post", { ...CONVERSATION, repo: "acme/other" })).error,
    ).toEqual({ code: -32602, message: "acme/other is not on the list; add it first." });
    expect(
      (
        await t.host.execute("releases.post", {
          ...CONVERSATION,
          repo: "rim-platform/plugin-github-prs",
        })
      ).error?.message,
    ).toBe("Nothing to post. rim-platform/plugin-github-prs has no published release.");
    expect(t.posts).toEqual([]);
    await t.host.shutdown();
  });

  it("says why the app did not post: no permission, or an encrypted conversation", async () => {
    const denied = await started({ granted: ["ui.panel", "network.fetch"] });
    expect((await denied.host.execute("releases.post", CONVERSATION)).error).toEqual({
      code: -32000,
      message: "Posting needs the Send Chat Messages permission.",
    });
    await denied.host.shutdown();

    const encrypted = await started({
      post: (params) => {
        if (params.body.includes("rim-server")) {
          throw { code: -32000, message: "capability denied: chat.write.encrypted" };
        }
        return { id: "msg-1" };
      },
    });
    expect((await encrypted.host.execute("releases.post", CONVERSATION)).error).toEqual({
      code: -32000,
      message:
        "This conversation is encrypted, and the plugin posts only in plaintext conversations. 1 posted before it.",
    });
    await encrypted.host.shutdown();

    const limited = await started({
      post: () => {
        throw { code: -32001, message: "rate limited: chat.write" };
      },
    });
    expect((await limited.host.execute("releases.post", CONVERSATION)).error).toEqual({
      code: -32001,
      message: "The app allows 120 posts a minute; try again shortly.",
    });
    await limited.host.shutdown();

    const uncached = await started({
      post: () => {
        throw {
          code: -32603,
          message: "conversation not cached yet",
          data: { reason: "notCached" },
        };
      },
    });
    expect((await uncached.host.execute("releases.post", CONVERSATION)).error).toEqual({
      code: -32603,
      message: "The app did not post the message: conversation not cached yet",
    });
    await uncached.host.shutdown();
  });

  it("answers the latest release of each repository and refreshes the panel", async () => {
    const t = await started({ stored: ["rim-platform/rim-ui", "acme/private"] });
    t.clock.now += REFRESH_FLOOR_MS;
    const before = t.panels.length;
    const answer = await t.host.execute("releases.latest");
    const payload = answer.result?.payload as LatestRelease[];
    expect(payload).toEqual([
      {
        repo: "rim-platform/rim-ui",
        release: {
          tag: "v0.0.2",
          version: "0.0.2",
          name: "Desktop installers",
          firstLine: "Added",
          url: "https://github.com/rim-platform/rim-ui/releases/tag/v0.0.2",
          publishedAt: "2026-10-16T09:00:00Z",
          prerelease: false,
        },
        error: null,
      },
      {
        repo: "acme/private",
        release: null,
        error: "acme/private was not found, or it is private.",
      },
    ]);
    expect(answer.result?.message).toBe("Latest releases of 2 repositories");
    expect(t.github.requests).toHaveLength(4);
    expect(t.panels.length).toBeGreaterThan(before);
    expect(t.panel().fetchedAt).toBe(new Date(t.clock.now).toISOString());
    await t.host.shutdown();
  });
});
