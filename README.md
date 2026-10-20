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
- **Post as you** (`chat.write`): "this plugin sends messages in your name, except in
  encrypted DMs and groups." It lets **Releases: Post to this conversation** post the
  releases. The plugin posts only when you run that command, only
  into the conversation (or thread) open at the time, and only in plaintext conversations: it
  does not ask for `chat.write.encrypted`, so in an encrypted DM or group the app refuses and
  the command says so. It does not ask for `chat.read` and never reads your messages.

Reading its own settings, the optional [GitHub token](#github-token), needs no permission.

GitHub allows 60 requests an hour per IP address without a token, and 5,000 an hour with one,
so the plugin fetches the list when it starts, every 10 minutes while its panel is open, and at
most every 2 minutes when you ask; it stops asking and says so when GitHub refuses. Your list
of repositories is kept in the app's plugin store for your account on that device. Until you
change it, the list is the four project repositories; a list you emptied stays empty.

## GitHub token

Use a **fine-grained personal access token** with Repository access **Public repositories**
(read-only) and an **expiry date**. That is all the plugin needs, and it is the only kind of
token to give it: see the warning about private repositories below.

Without a token the plugin shares GitHub's limit of 60 requests an hour with everything else on
your network address, and a list of 10 repositories uses 10 of them per refresh. When GitHub
refuses, the panel says until when and suggests adding a token. The token is a setting of the
**RIM desktop app** only: the web app keeps no secret settings, so its settings form says the
token needs the desktop app, and there the plugin always asks GitHub without one.

To add one, on the desktop:

1. On GitHub, open Settings → Developer settings → Personal access tokens → **Fine-grained
   tokens** → **Generate new token**.
2. Give it a name and an **expiry date**. Under **Repository access** choose **Public
   repositories (read-only)**: that is all the plugin reads
   (`GET /repos/{owner}/{repo}/releases`), and it needs no permissions beyond it.
3. Generate it and copy it (`github_pat_…`).
4. In RIM, open the plugin's settings: **Plugin settings** in the **Releases** panel's header,
   **Settings** on its row in Settings → Plugins, or **Plugin settings: Releases** in the
   command palette. Paste the token into **GitHub token** and save. The plugin fetches the
   list again with it straight away.

Keep the token public-only. A token with access to private repositories lets the plugin read their
releases too, and **Releases: Post to this conversation** would then post a private release's
tag, title and the first line of its notes into the conversation, where every member sees it.

Where the token goes:

- It is kept in the desktop app's encrypted secret vault, for your account on this device. It
  is never synced and never sent to the RIM server, and it is deleted when you uninstall the
  plugin. Once saved, the form only says it is set, with **Replace** and **Clear**.
- The plugin sends it only to `api.github.com`, as `Authorization: Bearer`. It never keeps it
  in its store, never logs, shows or posts it, and never puts it in a message or an answer; the
  panel never receives it.
- A token with anything but visible ASCII in it (a space, a line break, an accented letter) is
  never sent, and the plugin does not ask without it either: the panel and every command say
  the token is not valid and to paste it again or clear it, until you do. When GitHub rejects
  the token (expired or revoked), the panel says so; replace it in the same form.
- While the desktop cannot open its secret vault (a locked system keyring), the plugin asks
  without the token, and when GitHub refuses it says the token could not be read rather than
  to add one; it reads the token again on the next refresh.

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

Each way ends the same: RIM shows the plugin and its permissions, **Approve and turn on**
grants the ones you leave ticked and starts the plugin, and **Releases** in the side rail's
**Plugins** menu, or **Open Releases** in the command palette, opens its panel.

- **Install from git URL** (desktop): Settings → Plugins → Install from git URL, with
  `https://github.com/rim-platform/plugin-releases.git`. The desktop takes
  `rim-plugin.json`, the committed `main.mjs` and `panels/` from the checkout and leaves the
  rest of the repository out.
- **Install from link** (web and desktop): Settings → Plugins → Install from link, with the
  link a [release](https://github.com/rim-platform/plugin-releases/releases) gives:
  `https://github.com/rim-platform/plugin-releases/releases/download/v<version>/chat.rim.releases-<version>.rimbundle#sha256=<hash>`.
  The app checks that the bundle hashes to the value after `#sha256=` before it installs
  anything. The desktop app fetches the link itself, so a release link installs there. GitHub
  serves release assets without CORS headers, so the web app cannot fetch them: in the
  browser, install from a workspace registry or from a host that sends CORS headers.
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
