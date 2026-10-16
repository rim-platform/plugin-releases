# Releases

A [RIM](https://github.com/rim-platform) plugin that watches the GitHub releases of up to 10
public repositories and posts them into a conversation. Its panel shows each repository's
latest release (version, date, and whether it is a pre-release) with the earlier ones folded
under a count. It starts with the project's own repositories, `rim-platform/rim-ui`,
`rim-platform/rim-server`, `rim-platform/plugin-github-prs` and `rim-platform/plugin-k8s-pods`;
add and remove repositories as you like. It is a `WebSandboxed` plugin built on
[`@rim-platform/plugin-sdk`](https://www.npmjs.com/package/@rim-platform/plugin-sdk): it runs in
a sandboxed frame of the app, on the web and on the desktop alike.

## What it asks for

RIM shows the plugin as one that "Runs sandboxed in this app. It cannot read your files, run
programs, or use your RIM session. It reaches RIM only through the permissions below." It asks
for three permissions:

- **Render UI Panels** (`ui.panel`), to show the list in its **Releases** panel.
- **Connect to listed sites** (`network.fetch`), so it can send and receive data from
  `api.github.com` (the releases). The frame's content security policy blocks every other
  site.
- **Send Chat Messages** (`chat.write`), so **Releases: Post to this conversation** can post
  the releases. The app says it as "Post as you: this plugin sends messages in your name,
  except in encrypted DMs and groups." The plugin posts only when you run that command, only
  into the conversation (or thread) open at the time, and only in plaintext conversations: it
  does not ask for `chat.write.encrypted`, so in an encrypted DM or group the app refuses and
  the command says so. It does not ask for `chat.read` and never reads your messages.

It uses no token, so it sees public repositories only. GitHub allows 60 requests an hour per
IP address without one, so the plugin fetches the list when it starts, every 10 minutes while
its panel is open, and at most every 2 minutes when you ask; it stops asking and says so when
GitHub refuses. Your list of repositories is kept in the app's plugin store for your account
on that device. Until you change it, the list is the four project repositories; a list you
emptied stays empty.

## What it does

| Command                                                        | What it does                                                                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Releases: Refresh** (`refresh`)                              | Fetches the latest releases again. Keybind capable.                                                              |
| **Releases: Add repository** (`add_repo`)                      | Adds `owner/name` (or a `https://github.com/owner/name` link), at most 10.                                      |
| **Releases: Remove repository** (`remove_repo`)                | Removes a repository.                                                                                            |
| **Releases: Post to this conversation** (`releases.post`)      | Posts one message per repository with its latest release; `repo` picks one repository on the list. Offered only while a conversation is open. |
| **Releases: Latest** (`releases.latest`)                       | Answers the latest release of each repository as its result, for the palette, macros and other plugins, and refreshes the panel. |

A posted release is plain text:

```text
🚀 rim-ui 0.0.2 is out
Desktop installers
https://github.com/rim-platform/rim-ui/releases/tag/v0.0.2
```

The second line is the release's name, or the first line of its notes when the name is only the
tag, cut to 200 characters; a pre-release says `(pre-release)` after the version. Drafts are never
shown or posted. The command reuses releases fetched in the last 2 minutes and fetches the list
again otherwise.

The **Releases** panel opens next to the tool panel. Add a repository at the top, remove one
with **×**; <kbd>r</kbd> refreshes and <kbd>/</kbd> jumps to the field. The panel has no links:
following one would navigate the panel's frame, which closes it.

## Install

Each way ends the same: RIM shows the plugin and its permissions, you approve them, enable the
plugin and open **Releases** from the side rail.

- **Install from git URL** (desktop): Settings → Plugins → Install from git URL, with
  `https://github.com/rim-platform/plugin-releases.git`. The desktop takes
  `rim-plugin.json`, the committed `main.mjs` and `panels/` from the checkout and leaves the
  rest of the repository out.
- **Install from link** (web and desktop): Settings → Plugins → Install from link, with the
  link a [release](https://github.com/rim-platform/plugin-releases/releases) gives:
  `https://github.com/rim-platform/plugin-releases/releases/download/v<version>/chat.rim.releases-<version>.rimbundle#sha256=<hash>`.
  The app checks that the bundle hashes to the value after `#sha256=` before it installs
  anything. Install from link with a GitHub release asset works on the desktop
  once it fetches links natively (a rim-ui issue); in the browser, install from a workspace
  registry or from a host that sends CORS headers.
- **Workspace registry**: when a workspace recommends or requires the plugin, the command
  palette's "Workspace plugins" offers it with its publisher's signature, and a required one
  is offered when the workspace opens. The app verifies the signed statement before it
  installs the exact version the workspace pinned.

## Develop

Node 22.18 or newer.

```sh
npm ci                 # install the SDK, esbuild and the test tools
npm test               # the plugin over a MessageChannel with a pretend GitHub and chat, and the panel in jsdom
npm run typecheck      # tsc with the strict settings plugins use
npm run lint
npm run format:check
npm run build          # bundle src/main.ts into main.mjs; commit the result
npm run check          # main.mjs and panels/ match a fresh build, as CI checks
npm run bundle         # dist/chat.rim.releases-<version>.rimbundle, and its sha256
```

```text
rim-plugin.json     the manifest the app installs by
main.mjs            the built plugin, committed; npm run build writes it
panels/releases/    the panel page (plain HTML and JS, rendered with textContent only)
src/main.ts         the entry the build starts from
src/plugin.ts       the commands, the stored list, the refresh rules, the posts and the panel state
src/github.ts       the GitHub REST calls and what GitHub's refusals mean
```

A release is a tag `v<version>` matching the version in `rim-plugin.json` and `package.json`,
with a section for it in `CHANGELOG.md`. `CONTRIBUTING.md` has the rules for a pull request.

## License

Apache License 2.0, see `LICENSE` and `NOTICE`.
