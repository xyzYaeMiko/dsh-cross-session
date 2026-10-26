# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-26

### Added

- Settings page under **Settings → Cross-Session Chat** (browser half registered
  through the `settings.section` slot, English/Chinese labels).
- Toolset switch: all four tools (default) or only `session_send`.
- "Open to every session" switch plus a checkbox session whitelist; sessions
  outside the whitelist — and their subagents — get no cross-session tools.
- Host policy that applies the settings to every live Agent via a scoped
  `tools.restrict({ deny })` layer, re-applies on save, and also covers cold
  sessions on resume.
- `GET/POST /api/cross-session/settings` route (same-origin check + Host trust
  fence) and the `$DSH_HOME/cross-session/settings.json` document with atomic
  writes.
- Debranded plugin icon and a release-ready repository layout (CI, changelog).

### Changed

- `session_read` never returns chain of thought: reasoning blocks and inline
  `<thinking>`/`<reasoning>` wrappers are stripped; new `final_only` parameter
  returns only the last assistant answer.
- `session_send` gained `force_insert`: when the target is running, the plugin
  cancels the current turn with `keepInbox: true`, keeps the target's own queued
  input, and makes the message the next turn. An idle target is never
  interrupted (`interrupted: false`).

### Fixed

- `session_read` handles live derived history that contains non-user/assistant
  rows (system, developer, tool) without schema failures.
- The settings route waits for the `webServer` service (`ctx.inject`) and is
  registered as an exact path, so it works regardless of plugin activation order.

## [0.1.0]

- Initial plugin: `session_list`, `session_read`, `session_ask`, `session_send`
  with discovery/resume tiers, relay attribution, hop guard, and bounded waits.
