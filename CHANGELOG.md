# Changelog

What changes between releases of the Releases plugin, for the people who use it and the
workspaces that recommend it. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); a release is the tag `v<version>`,
the version in `rim-plugin.json` and in `package.json`.

## How entries are written

- A pull request that changes what a user or a workspace sees adds its line under `Unreleased`
  in the same pull request. Refactors, tests and internal documentation do not.
- Each line goes under one heading: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` or
  `Security`. It says what changed for the reader, not how it was built.
- A change to the plugin's permissions or commands names them: a new permission makes every
  install ask again.
- At release time `Unreleased` becomes `## [<version>] - <YYYY-MM-DD>` and a new empty
  `Unreleased` starts above it.

## [Unreleased]

## [0.0.2] - 2026-10-20

### Added

- A **GitHub token** setting (`github_token`, secret), in the RIM desktop app only. A
  fine-grained token with read-only access to public repositories raises GitHub's limit from 60
  to 5,000 requests an hour; it is kept in the app's secret vault on this device and sent only
  to `api.github.com`. The web app keeps no secret settings, so there the plugin asks without
  one, as before. Saving, replacing or clearing the token fetches the list again, and a token
  that is not valid is never sent.

### Changed

- When GitHub's hourly limit is used up, the message suggests adding a token in the plugin's
  settings. It says instead when the token could not be read (the secret vault is locked), and
  a token GitHub rejects is named as rejected.

### Fixed

- A repository named `.` or `..`, such as `owner/..`, is refused instead of being asked for at
  another GitHub path.
- A post refused for want of permission names the permission as the app's prompt does, **Post
  as you**, instead of "Send Chat Messages".

## [0.0.1] - 2026-10-16

### Added

- The Releases plugin, first released from its own repository. It watches the GitHub releases
  of up to 10 public repositories in its **Releases** panel, with the commands **Releases:
  Refresh**, **Add repository**, **Remove repository**, **Post to this conversation** and
  **Latest**. It asks for `ui.panel`, `network.fetch` and `chat.write`, and talks only to
  `api.github.com`, without a token.
- **Releases: Post to this conversation** posts one plain-text message per repository with
  its latest release into the open conversation or thread; it is offered only while a
  conversation is open and posts only in plaintext conversations.
- A new list starts with the project's own repositories, `rim-platform/rim-ui`,
  `rim-platform/rim-server`, `rim-platform/plugin-github-prs` and
  `rim-platform/plugin-k8s-pods`, until you save one of your own.
- The repository holds the built plugin at its root (`rim-plugin.json`, `main.mjs` and
  `panels/`), so the desktop installs it from its git URL; each release attaches a
  `.rimbundle` for Install from link.

[Unreleased]: https://github.com/rim-platform/plugin-releases/compare/v0.0.2...master
[0.0.2]: https://github.com/rim-platform/plugin-releases/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/rim-platform/plugin-releases/releases/tag/v0.0.1
