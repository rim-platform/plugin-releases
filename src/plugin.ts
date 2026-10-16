// The Releases plugin: a WebSandboxed plugin that keeps up to 10 public
// repositories in the host's store, shows their latest GitHub releases in its
// panel and posts them into the open conversation. It talks only to
// api.github.com, without a token, so it fetches at most every 2 minutes and
// says when GitHub refuses.

import {
  definePlugin,
  ErrorCode,
  HostRequestError,
  PluginError,
  type Host,
} from "@rim-platform/plugin-sdk";

import { fetchReleases, GitHubError, normalizeRepo, type Release } from "./github.ts";

export const PLUGIN_ID = "chat.rim.releases";
export const PANEL_ID = "releases";
export const MAX_REPOS = 10;
/** The shortest time between two fetches of the list, to stay under GitHub's hourly limit. */
export const REFRESH_FLOOR_MS = 2 * 60 * 1000;
/** The longest text of the line under a posted release's title. */
export const MAX_SUMMARY_LENGTH = 200;
const STORAGE_KEY = "repos";
/** The list a person starts with until they save one of their own: the project's repositories. */
export const DEFAULT_REPOS: readonly string[] = [
  "rim-platform/rim-ui",
  "rim-platform/rim-server",
  "rim-platform/plugin-github-prs",
  "rim-platform/plugin-k8s-pods",
];

/** One repository in the panel, its published releases newest first. */
export interface RepoState {
  repo: string;
  releases: Release[];
  error: string | null;
}

/** What the panel shows; the plugin publishes it whole with `rim.ui.update_panel`. */
export interface PanelState {
  repos: RepoState[];
  maxRepos: number;
  fetchedAt: string | null;
  loading: boolean;
  /** A line for the person: GitHub refused, or the list was fetched a moment ago. */
  notice: string | null;
  signedIn: boolean;
}

/** One repository's latest release, as `releases.latest` answers it. */
export interface LatestRelease {
  repo: string;
  release: Release | null;
  error: string | null;
}

export interface PluginOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

/** `text` cut to at most `max` characters, ending in an ellipsis when it was cut. */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** The line under the title: the release's name, else the first line of its notes. */
function summaryOf(release: Release): string {
  const named = release.name && release.name !== release.tag && release.name !== release.version;
  // A `<@…>` token in GitHub's text would mention someone in the conversation.
  return clip((named ? release.name : release.firstLine).replace(/<@/g, "< @"), MAX_SUMMARY_LENGTH);
}

/** The plain-text message that announces `release` of `repo`. */
export function releaseMessage(repo: string, release: Release): string {
  const name = repo.slice(repo.indexOf("/") + 1);
  const title = `🚀 ${name} ${release.version} is out${release.prerelease ? " (pre-release)" : ""}`;
  const summary = summaryOf(release);
  return [title, ...(summary ? [summary] : []), release.url].join("\n");
}

/** A failed post as the person reads it, after `posted` messages went out. */
function postFailure(error: unknown, posted: number): PluginError {
  let text: string;
  let code: number = ErrorCode.PLUGIN_ERROR;
  if (error instanceof HostRequestError && error.code === ErrorCode.CAPABILITY_DENIED) {
    text = error.message.includes("encrypted")
      ? "This conversation is encrypted, and the plugin posts only in plaintext conversations."
      : "Posting needs the Send Chat Messages permission.";
    code = error.code;
  } else if (error instanceof HostRequestError && error.code === ErrorCode.RATE_LIMITED) {
    text = "The app allows 120 posts a minute; try again shortly.";
    code = error.code;
  } else {
    // A host refusal reads "<method> failed (<code>): <reason>"; the person needs the reason.
    const reason = error instanceof Error ? error.message : String(error);
    text = `The app did not post the message: ${reason.replace(/^\S+ failed \(-?\d+\): /, "")}`;
    if (error instanceof HostRequestError) code = error.code;
  }
  return new PluginError(posted > 0 ? `${text} ${posted} posted before it.` : text, { code });
}

/** The open conversation the host added to a command's arguments, and its thread. */
function conversationOf(args: Readonly<Record<string, unknown>>): {
  conversationId: string;
  threadId: string | null;
} {
  const { conversation_id: conversationId, thread_id: threadId } = args;
  if (typeof conversationId !== "string" || conversationId.trim() === "") {
    throw new PluginError("Open a conversation to post releases into it.", {
      code: ErrorCode.INVALID_PARAMS,
    });
  }
  if (threadId !== undefined && threadId !== null && (typeof threadId !== "string" || !threadId)) {
    throw new PluginError("thread_id must be the id of the open thread.", {
      code: ErrorCode.INVALID_PARAMS,
    });
  }
  return { conversationId, threadId: typeof threadId === "string" ? threadId : null };
}

/** A fresh plugin. Tests pass a fake `fetch` and clock. */
export function createPlugin(options: PluginOptions = {}) {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  let repos: RepoState[] = [];
  let signedIn = false;
  let fetchedAt: number | null = null;
  let rateLimitedUntil = 0;
  let loading = false;
  let notice: string | null = null;
  let panelDenied = false;
  // The fetch of the whole list in progress, so a command arriving meanwhile waits for it.
  let fetching: Promise<void> = Promise.resolve();
  // Commands wait for the saved list, so one that arrives right after the
  // handshake or a sign-in does not race with loading it.
  let loaded: Promise<void> = Promise.resolve();

  const state = (): PanelState => ({
    repos,
    maxRepos: MAX_REPOS,
    fetchedAt: fetchedAt === null ? null : new Date(fetchedAt).toISOString(),
    loading,
    notice,
    signedIn,
  });

  const latest = (): LatestRelease[] =>
    repos.map((r) => ({ repo: r.repo, release: r.releases[0] ?? null, error: r.error }));

  async function publish(host: Host): Promise<void> {
    if (panelDenied) return;
    try {
      await host.panels.set(PANEL_ID, state());
    } catch (error) {
      if (error instanceof HostRequestError && error.code === ErrorCode.CAPABILITY_DENIED) {
        panelDenied = true;
        host.log.warn("the panel needs the ui.panel permission");
        return;
      }
      host.log.warn(`could not update the panel: ${(error as Error).message}`);
    }
  }

  /**
   * The signed-in user's repositories from the host's store, or {@link DEFAULT_REPOS} when
   * they never saved a list; none when nobody is signed in.
   */
  async function load(host: Host): Promise<void> {
    signedIn = host.principal !== null;
    fetchedAt = null;
    notice = null;
    if (!signedIn) {
      repos = [];
      return;
    }
    try {
      const stored = await host.storage.get(STORAGE_KEY);
      const names = Array.isArray(stored)
        ? stored.map(normalizeRepo).filter((r): r is string => r !== null)
        : [...DEFAULT_REPOS];
      repos = names.slice(0, MAX_REPOS).map((repo) => ({ repo, releases: [], error: null }));
    } catch (error) {
      repos = [];
      host.log.warn(`could not read the saved repositories: ${(error as Error).message}`);
    }
  }

  async function save(host: Host): Promise<void> {
    await host.storage.set(
      STORAGE_KEY,
      repos.map((r) => r.repo),
    );
  }

  /** Fetch `targets`, stopping at the first refusal of the hourly limit. */
  async function fetchRepos(host: Host, targets: RepoState[]): Promise<void> {
    if (now() < rateLimitedUntil) return;
    loading = true;
    await publish(host);
    for (const target of targets) {
      try {
        target.releases = await fetchReleases(target.repo, fetchImpl);
        target.error = null;
      } catch (error) {
        const refusal = error instanceof GitHubError ? error : new GitHubError(String(error));
        if (refusal.rateLimitedUntil !== null) {
          rateLimitedUntil = refusal.rateLimitedUntil;
          notice = refusal.message;
          break;
        }
        target.error = refusal.message;
      }
    }
    loading = false;
  }

  /** Fetch the whole list now and publish it. */
  function fetchAll(host: Host): Promise<void> {
    notice = null;
    fetchedAt = now();
    fetching = fetchRepos(host, repos).then(() => publish(host));
    return fetching;
  }

  /** Fetch the list unless it was fetched under 2 minutes ago or GitHub said wait. */
  async function ensureFresh(host: Host): Promise<void> {
    if (repos.length === 0 || now() < rateLimitedUntil) return;
    if (fetchedAt !== null && now() - fetchedAt < REFRESH_FLOOR_MS) {
      await fetching;
      return;
    }
    await fetchAll(host);
  }

  /** Fetch every repository, unless the list was fetched under 2 minutes ago or GitHub said wait. */
  async function refresh(host: Host): Promise<string> {
    if (repos.length === 0) {
      await publish(host);
      return "No repositories yet: add one in the panel.";
    }
    if (now() < rateLimitedUntil) {
      await publish(host);
      return notice ?? "GitHub refused; try again later.";
    }
    if (fetchedAt !== null && now() - fetchedAt < REFRESH_FLOOR_MS) {
      await fetching;
      notice =
        "Fetched less than 2 minutes ago. GitHub allows 60 requests an hour without a token.";
      await publish(host);
      return notice;
    }
    await fetchAll(host);
    const found = repos.filter((r) => r.releases.length > 0).length;
    return (
      notice ??
      `Latest releases of ${found} of ${repos.length} repositor${repos.length === 1 ? "y" : "ies"}`
    );
  }

  function repoArgument(args: Readonly<Record<string, unknown>>): string {
    const repo = normalizeRepo(args.repo);
    if (!repo) {
      throw new PluginError("repo must be a repository as owner/name, such as rust-lang/rust", {
        code: ErrorCode.INVALID_PARAMS,
      });
    }
    return repo;
  }

  /** The listed repositories `args.repo` picks: the one it names, or all when it is left out. */
  function targetsOf(args: Readonly<Record<string, unknown>>): RepoState[] {
    if (args.repo === undefined || args.repo === null || args.repo === "") return repos;
    const repo = repoArgument(args);
    const listed = repos.find((r) => r.repo.toLowerCase() === repo.toLowerCase());
    if (!listed) {
      throw new PluginError(`${repo} is not on the list; add it first.`, {
        code: ErrorCode.INVALID_PARAMS,
      });
    }
    return [listed];
  }

  function requireSignIn(): void {
    if (!signedIn) throw new PluginError("Sign in to keep a list of repositories.");
  }

  return definePlugin({
    id: PLUGIN_ID,
    commands: {
      refresh: {
        async run({ host }) {
          await loaded;
          const message = await refresh(host);
          return { payload: state(), message };
        },
      },
      add_repo: {
        async run({ host, args }) {
          await loaded;
          requireSignIn();
          const repo = repoArgument(args);
          if (repos.some((r) => r.repo.toLowerCase() === repo.toLowerCase())) {
            return { payload: state(), message: `${repo} is already in the list` };
          }
          if (repos.length >= MAX_REPOS) {
            throw new PluginError(
              `The list holds at most ${MAX_REPOS} repositories; remove one first.`,
            );
          }
          const added: RepoState = { repo, releases: [], error: null };
          repos = [...repos, added];
          await save(host);
          await fetchRepos(host, [added]);
          await publish(host);
          return { payload: state(), message: added.error ?? notice ?? `Added ${repo}` };
        },
      },
      remove_repo: {
        async run({ host, args }) {
          await loaded;
          requireSignIn();
          const repo = repoArgument(args);
          repos = repos.filter((r) => r.repo.toLowerCase() !== repo.toLowerCase());
          await save(host);
          await publish(host);
          return { payload: state(), message: `Removed ${repo}` };
        },
      },
      "releases.post": {
        async run({ host, args }) {
          await loaded;
          const { conversationId, threadId } = conversationOf(args);
          requireSignIn();
          const targets = targetsOf(args);
          if (targets.length === 0) {
            throw new PluginError("No repositories yet: add one in the panel.");
          }
          await ensureFresh(host);
          const posted: { repo: string; tag: string; messageId: string }[] = [];
          const missing: RepoState[] = [];
          for (const target of targets) {
            const release = target.releases[0];
            if (!release) {
              missing.push(target);
              continue;
            }
            try {
              const { id } = await host.chat.postMessage(
                conversationId,
                releaseMessage(target.repo, release),
                threadId === null ? {} : { threadId },
              );
              posted.push({ repo: target.repo, tag: release.tag, messageId: id });
            } catch (error) {
              throw postFailure(error, posted.length);
            }
          }
          const why = missing.map((r) => r.error ?? `${r.repo} has no published release.`);
          if (posted.length === 0) {
            throw new PluginError(`Nothing to post. ${notice ?? why.join(" ")}`);
          }
          const count = `Posted ${posted.length} release${posted.length === 1 ? "" : "s"}`;
          return {
            payload: { posted },
            message: missing.length === 0 ? count : `${count}. ${why.join(" ")}`,
          };
        },
      },
      "releases.latest": {
        async run({ host }) {
          await loaded;
          await ensureFresh(host);
          await publish(host);
          const message =
            notice ??
            `Latest releases of ${repos.length} repositor${repos.length === 1 ? "y" : "ies"}`;
          return { payload: latest(), message };
        },
      },
    },
    async onReady(host) {
      loaded = load(host);
      await loaded;
      await refresh(host);
    },
    async onPrincipalChanged(_principal, host) {
      loaded = load(host);
      await loaded;
      await refresh(host);
    },
  });
}
