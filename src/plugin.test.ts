// Tests the Releases plugin over a MessageChannel, as its frame runs, with a
// pretend GitHub, the host's store and its chat: no RIM app and no network needed.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { startTestHost, validateManifest } from "@rim-platform/plugin-sdk/testing";

import { INVALID_TOKEN_MESSAGE } from "./github.ts";

import {
  createPlugin,
  DEFAULT_REPOS,
  MAX_REPOS,
  PANEL_ID,
  REFRESH_FLOOR_MS,
  TOKEN_SETTING,
  UNREADABLE_RELEASES_MESSAGE,
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

const TOKEN = "github_pat_11ABCDEFG0123456789_secretpart";

interface FakeGitHub {
  fetch: typeof fetch;
  requests: string[];
  /** The `Authorization` header of each request, or null when it had none. */
  authorizations: (string | null)[];
  /** Answer the next requests with GitHub's hourly-limit refusal. */
  limit: () => void;
  /** Answer the next requests that carry this token with 401; null stops it. */
  reject: (token: string | null) => void;
}

function fakeGitHub(): FakeGitHub {
  const requests: string[] = [];
  const authorizations: (string | null)[] = [];
  let limited = false;
  let rejected: string | null = null;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(Object.keys(headers).every((name) => ["Accept", "Authorization"].includes(name))).toBe(
      true,
    );
    authorizations.push(headers.Authorization ?? null);
    if (rejected !== null && headers.Authorization === `Bearer ${rejected}`) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }
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
    if (repo === "acme/garbled") return new Response("<html>not json</html>", { status: 200 });
    const releases = RELEASES[repo];
    return releases ? Response.json(releases) : new Response("{}", { status: 404 });
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    requests,
    authorizations,
    limit: () => {
      limited = true;
    },
    reject: (token) => {
      rejected = token;
    },
  };
}

interface StartOptions {
  stored?: unknown;
  principal?: null;
  granted?: string[];
  /** Answers `rim.chat.post_message`; the default gives each post a new id. */
  post?: (params: PostParams) => unknown;
  /** The saved settings; without them `rim.settings.get` gets `METHOD_NOT_FOUND`. */
  settings?: Record<string, unknown>;
  /** Answers `rim.settings.get` in place of `settings`. */
  readSettings?: () => unknown;
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
  const storeWrites: unknown[] = [];
  const panels: PanelState[] = [];
  const posts: PostParams[] = [];
  const host = startTestHost(createPlugin({ fetch: github.fetch, now: () => clock.now }), {
    transport: "port",
    manifestPath: MANIFEST,
    grantedCapabilities: options.granted ?? ["ui.panel", "network.fetch", "chat.write"],
    ...(options.principal === null ? { principal: null } : {}),
    ...(options.settings ? { settings: options.settings } : {}),
    onRequest(method, params) {
      const p = params as { key: string; value?: unknown; panel_id: string; state: PanelState };
      if (method === "rim.storage.get") return { value: store.get(p.key) ?? null };
      if (method === "rim.storage.set") {
        storeWrites.push(params);
        store.set(p.key, p.value);
        return { ok: true };
      }
      if (method === "rim.chat.post_message") {
        const post = params as PostParams;
        posts.push(post);
        return options.post ? options.post(post) : { id: `msg-${posts.length}` };
      }
      if (method === "rim.ui.update_panel" && p.panel_id === PANEL_ID) panels.push(p.state);
      if (method === "rim.settings.get") {
        if (options.readSettings) return options.readSettings();
        throw { code: -32601, message: "method not found: rim.settings.get" };
      }
      return { ok: true };
    },
  });
  return {
    host,
    github,
    clock,
    store,
    storeWrites,
    panels,
    posts,
    panel: () => panels.at(-1) as PanelState,
  };
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
    expect(manifest.settings_schema).toEqual([
      expect.objectContaining({
        key: TOKEN_SETTING,
        value_type: "string",
        is_secret: true,
        placeholder: "github_pat_…",
      }),
    ]);
    expect(manifest.settings_schema[0]).not.toHaveProperty("default");
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
      "Fetched less than 2 minutes ago. GitHub allows 60 requests an hour without a token; add one in this plugin's settings in the RIM desktop app (the Plugins menu → Releases Settings, or Settings → Plugins).",
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
      /^GitHub refused: the 60 requests an hour it allows without a token are used up\. Try again after \d\d:\d\d, or add a GitHub token in this plugin's settings in the RIM desktop app \(the Plugins menu → Releases Settings, or Settings → Plugins\)\.$/,
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

  describe("the GitHub token setting", () => {
    const AUTHORIZED = `Bearer ${TOKEN}`;

    /** Every frame the plugin sent holds no part of the token. */
    function expectTokenKept(t: ReturnType<typeof start>, ...tokens: string[]) {
      const sent = JSON.stringify(t.host.frames);
      for (const token of [TOKEN, ...tokens]) {
        expect(sent).not.toContain(token);
        expect(sent).not.toContain(token.slice(-12));
      }
    }

    it("asks without a token while none is saved, or on a host without settings", async () => {
      for (const settings of [undefined, {}, { [TOKEN_SETTING]: "  " }]) {
        const t = await started(settings ? { settings } : {});
        expect(t.github.authorizations).toEqual(DEFAULT_REPOS.map(() => null));
        await t.host.shutdown();
      }
    });

    it("sends the saved token as a bearer token, and nowhere else", async () => {
      const t = await started({ settings: { [TOKEN_SETTING]: ` ${TOKEN}\n` } });
      expect(t.github.authorizations).toEqual(DEFAULT_REPOS.map(() => AUTHORIZED));
      t.clock.now += REFRESH_FLOOR_MS;
      await t.host.execute("refresh");
      expect((await t.host.execute("refresh")).result?.message).toBe(
        "Fetched less than 2 minutes ago.",
      );
      await t.host.execute("add_repo", { repo: "acme/missing" });
      expect(t.panel().repos.at(-1)?.error).toBe(
        "acme/missing was not found, or your token cannot read it.",
      );
      await t.host.execute("releases.post", CONVERSATION);
      expect(t.github.authorizations.every((header) => header === AUTHORIZED)).toBe(true);
      expect(t.posts.length).toBeGreaterThan(0);
      expectTokenKept(t);
      await t.host.shutdown();
    });

    it("fetches the list again when the token is saved, replaced or cleared", async () => {
      const t = await started();
      const fetched = () => t.github.requests.length;
      expect(fetched()).toBe(DEFAULT_REPOS.length);

      t.host.changeSettings({ [TOKEN_SETTING]: TOKEN });
      await until(() => fetched() === 2 * DEFAULT_REPOS.length && !t.panel().loading);
      expect(t.github.authorizations.slice(-DEFAULT_REPOS.length)).toEqual(
        DEFAULT_REPOS.map(() => AUTHORIZED),
      );

      // A save that leaves the token as it was fetches nothing.
      t.host.changeSettings({ [TOKEN_SETTING]: TOKEN, unknown_key: true });
      await new Promise((done) => setTimeout(done, 20));
      expect(fetched()).toBe(2 * DEFAULT_REPOS.length);

      const replaced = "github_pat_22ZYXWVU9876543210_otherpart";
      t.host.changeSettings({ [TOKEN_SETTING]: replaced });
      await until(() => fetched() === 3 * DEFAULT_REPOS.length && !t.panel().loading);
      expect(t.github.authorizations.at(-1)).toBe(`Bearer ${replaced}`);

      t.host.changeSettings({});
      await until(() => fetched() === 4 * DEFAULT_REPOS.length && !t.panel().loading);
      expect(t.github.authorizations.slice(-DEFAULT_REPOS.length)).toEqual(
        DEFAULT_REPOS.map(() => null),
      );
      t.clock.now += REFRESH_FLOOR_MS;
      await t.host.execute("refresh");
      expect(t.github.authorizations.at(-1)).toBeNull();
      expectTokenKept(t, replaced);
      await t.host.shutdown();
    });

    it("asks again with a newly saved token after GitHub's limit without one", async () => {
      const t = start({ stored: ["rim-platform/rim-ui", "rim-platform/rim-server"] });
      t.github.limit();
      await t.host.handshake();
      await until(() => typeof t.panel()?.notice === "string");
      expect(t.panel().notice).toMatch(
        /add a GitHub token in this plugin's settings in the RIM desktop app/,
      );
      expect(t.github.requests).toHaveLength(1);

      t.host.changeSettings({ [TOKEN_SETTING]: TOKEN });
      await until(() => t.github.requests.length === 2 && !t.panel().loading);
      expect(t.github.authorizations).toEqual([null, AUTHORIZED]);
      expect(t.panel().notice).toBe(
        `GitHub refused: the requests an hour it allows with your token are used up. Try again after ${new Date(T0 + 3_600_000).toTimeString().slice(0, 5)}.`,
      );
      expectTokenKept(t);
      await t.host.shutdown();
    });

    it("says when GitHub rejects the token and stops asking with it for the list", async () => {
      const t = start({ settings: { [TOKEN_SETTING]: TOKEN } });
      t.github.reject(TOKEN);
      await t.host.handshake();
      await until(() => typeof t.panel()?.notice === "string" && !t.panel().loading);
      const rejected =
        "GitHub rejected the token in this plugin's settings: it may have expired or been revoked. Replace it in the RIM desktop app (the Plugins menu → Releases Settings, or Settings → Plugins).";
      expect(t.panel().notice).toBe(rejected);
      expect(t.github.requests).toHaveLength(1);
      expect(t.panel().repos.every((r) => r.error === null && r.releases.length === 0)).toBe(true);
      expect((await t.host.execute("releases.post", CONVERSATION)).error?.message).toBe(
        `Nothing to post. ${rejected}`,
      );
      expect((await t.host.execute("releases.latest")).result?.message).toBe(rejected);

      t.github.reject(null);
      t.host.changeSettings({ [TOKEN_SETTING]: "github_pat_33NEWTOKEN_fresh" });
      await until(() => t.panel().notice === null && !t.panel().loading);
      expect(t.panel().repos[0].releases.map((r) => r.tag)).toEqual(["v0.0.2", "v0.0.1"]);
      expectTokenKept(t);
      await t.host.shutdown();
    });

    it("asks without a token while the vault is locked, and says so when GitHub refuses", async () => {
      const vault = { locked: true };
      const t = start({
        stored: ["rim-platform/rim-ui"],
        readSettings: () => {
          if (vault.locked) {
            throw {
              code: -32603,
              message: "the secret vault cannot be opened",
              data: { reason: "secretsLocked" },
            };
          }
          return { values: { [TOKEN_SETTING]: TOKEN } };
        },
      });
      await t.host.handshake();
      await until(() => t.panels.some((p) => !p.loading && p.fetchedAt !== null));
      expect(t.github.authorizations).toEqual([null]);
      expect(t.host.logs.map((l) => l.message)).toContain(
        "the GitHub token could not be read: the app's secret vault is locked",
      );

      t.github.limit();
      t.clock.now += REFRESH_FLOOR_MS;
      const refused = await t.host.execute("refresh");
      expect(refused.result?.message).toMatch(
        /^GitHub refused: the 60 requests an hour it allows without a token are used up, and the plugin could not read your GitHub token because the app's secret vault is locked; unlock your system keyring\. Try again after \d\d:\d\d\.$/,
      );
      expect(refused.result?.message).not.toMatch(/add a GitHub token/);

      // Once the vault opens, the next refresh reads the token and asks with it.
      vault.locked = false;
      t.clock.now += REFRESH_FLOOR_MS;
      await t.host.execute("refresh");
      expect(t.github.authorizations).toEqual([null, null, AUTHORIZED]);
      expectTokenKept(t);
      await t.host.shutdown();
    });

    it("reads the new account's token when another account signs in", async () => {
      const t = await started({ stored: ["rim-platform/rim-ui"], settings: {} });
      t.host.notify("rim.principal.changed", {
        principal: { principalId: "rimp0_other", displayName: "Other" },
      });
      t.host.changeSettings({ [TOKEN_SETTING]: TOKEN });
      await until(() => t.github.requests.length >= 2 && !t.panel().loading);
      await new Promise((done) => setTimeout(done, 20));
      // One fetch for the new account, with its token: the change that follows the
      // sign-in brings the token the plugin already read.
      expect(t.github.authorizations).toEqual([null, AUTHORIZED]);
      expectTokenKept(t);
      await t.host.shutdown();
    });

    it("refuses an invalid token without sending it, and never repeats it", async () => {
      for (const bad of [`${TOKEN} extra`, `${TOKEN}\nX-Other: 1`, `${TOKEN}é`]) {
        const t = start({ settings: { [TOKEN_SETTING]: bad } });
        await t.host.handshake();
        await until(() => typeof t.panel()?.notice === "string" && !t.panel().loading);
        expect(t.panel().notice).toBe(INVALID_TOKEN_MESSAGE);
        expect(t.github.requests).toEqual([]);
        expect((await t.host.execute("releases.post", CONVERSATION)).error?.message).toBe(
          `Nothing to post. ${INVALID_TOKEN_MESSAGE}`,
        );
        expect((await t.host.execute("refresh")).result?.message).toBe(INVALID_TOKEN_MESSAGE);
        // It stays refused, without asking unauthenticated either, until the setting changes.
        t.clock.now += REFRESH_FLOOR_MS;
        expect((await t.host.execute("refresh")).result?.message).toBe(INVALID_TOKEN_MESSAGE);
        expect((await t.host.execute("releases.latest")).result?.message).toBe(
          INVALID_TOKEN_MESSAGE,
        );
        expect((await t.host.execute("add_repo", { repo: "acme/new" })).result?.message).toBe(
          INVALID_TOKEN_MESSAGE,
        );
        expect(t.github.requests).toEqual([]);
        expect(t.posts).toEqual([]);
        expectTokenKept(t);

        t.host.changeSettings({ [TOKEN_SETTING]: TOKEN });
        await until(() => t.github.requests.length === 5 && !t.panel().loading);
        expect(t.panel().notice).toBeNull();
        expect(t.github.authorizations).toEqual(
          [...DEFAULT_REPOS, "acme/new"].map(() => AUTHORIZED),
        );
        await t.host.shutdown();
      }
    });

    it("keeps the token out of the store, the panel, the logs, posts and every answer", async () => {
      const t = await started({ settings: { [TOKEN_SETTING]: TOKEN } });
      const answers: unknown[] = [];
      const run = async (command: string, args: Record<string, unknown> = {}) =>
        answers.push(await t.host.execute(command, args));
      await run("add_repo", { repo: "acme/missing" });
      await run("add_repo", { repo: "acme/garbled" });
      await run("add_repo", { repo: "owner/.." });
      await run("remove_repo", { repo: "acme/missing" });
      await run("remove_repo", { repo: "acme/garbled" });
      await run("refresh");
      await run("releases.post", CONVERSATION);
      await run("releases.latest");
      t.github.reject(TOKEN);
      t.clock.now += REFRESH_FLOOR_MS;
      await run("refresh");
      await run("releases.post", { ...CONVERSATION, repo: "rim-platform/plugin-github-prs" });
      t.github.reject(null);
      t.github.limit();
      t.clock.now += REFRESH_FLOOR_MS;
      await run("refresh");
      await run("releases.post", CONVERSATION);

      const seen = {
        store: t.storeWrites,
        panels: t.panels,
        logs: t.host.logs,
        posts: t.posts,
        answers,
      };
      expect(seen.store).toHaveLength(4);
      expect(t.store.get("repos")).toEqual(DEFAULT_REPOS);
      expect(seen.panels.length).toBeGreaterThan(0);
      expect(seen.posts.length).toBeGreaterThan(0);
      for (const [channel, value] of Object.entries(seen)) {
        const text = JSON.stringify(value);
        expect(text, channel).not.toContain(TOKEN);
        expect(text, channel).not.toContain(TOKEN.slice(-12));
      }
      expect(JSON.stringify(answers)).toContain("GitHub rejected the token");
      expectTokenKept(t);
      await t.host.shutdown();
    });

    it("shows a fixed message when GitHub's answer cannot be read", async () => {
      const t = await started({ stored: ["acme/garbled"], settings: { [TOKEN_SETTING]: TOKEN } });
      expect(t.panel().repos[0].error).toBe(UNREADABLE_RELEASES_MESSAGE);
      expect(JSON.stringify(t.host.frames)).not.toMatch(/JSON|Unexpected token|SyntaxError/);
      expectTokenKept(t);
      await t.host.shutdown();
    });

    it("refuses . and .. as a repository name", async () => {
      const t = await started({ settings: { [TOKEN_SETTING]: TOKEN } });
      for (const repo of ["owner/..", "owner/.", "https://github.com/rim-platform/.."]) {
        expect((await t.host.execute("add_repo", { repo })).error).toMatchObject({
          code: -32602,
        });
      }
      expect(t.github.requests).toHaveLength(DEFAULT_REPOS.length);
      expect(t.store.get("repos")).toBeNull();
      await t.host.shutdown();
    });
  });
});
