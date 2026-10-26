# dsh-cross-session

<p align="center"><img src="icon.svg" width="112" height="112" alt="Cross-Session Chat icon"></p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Version" src="https://img.shields.io/badge/version-0.2.0-informational">
  <img alt="DSH" src="https://img.shields.io/badge/DSH-%E2%89%A5%200.2.1--rc.2-5b8cff">
</p>

A **generic** DeepSeek Harness (DSH) Host plugin. It gives an agent four
model-facing tools to discover, read, and talk to **other sessions** — ask a
question and get the answer back, or steer work that is already running.

It is a capability, not a workflow and not a personal setup: its only UI is one
Settings page, its only storage is its own settings document, and it hard-codes
nothing about a particular profile, user, or workspace. The only required Host
services are `ctx.tools` and `ctx.agents`; every richer capability is detected at
call time.

## Tools

| Tool | What it does |
|---|---|
| `session_list` | List other sessions: id, title, working directory, running/live/blank. |
| `session_read` | Read a session's recent user/assistant messages — read-only, does not wake it. Chain of thought is never returned (reasoning blocks and inline `<thinking>` wrappers are stripped); `final_only: true` returns just the last assistant answer. |
| `session_ask` | Deliver a message to a session, **wait for its AI to answer**, return that answer. |
| `session_send` | Deliver without waiting (`queue` a new turn, `steer` at the next step boundary, or `force_insert` for urgent delivery that interrupts the target's running turn). |

`session` accepts a session id, an exact title, or a unique title/working-directory
substring, e.g. `session_ask({ session: "Build pipeline", message: "Is the migration done?" })`.

## Settings page

Installing the plugin adds one page under **Settings** (nav entry
"Cross-Session Chat" / "跨会话对话", order 27). It edits the Host settings
document, and saved changes apply immediately — no restart for a settings change.

| Setting | Values | Effect |
|---|---|---|
| Toolset | *All four tools* (default) / *Only `session_send`* | Which tools the plugin exposes. In send-only mode `session_list`, `session_read` and `session_ask` never appear in any tool list. |
| Open to every session | on (default) / off | On: the whitelist is ignored and every session sees the toolset. Off: only whitelisted sessions see any cross-session tool. |
| Session whitelist | checkbox list of sessions | Shows title, working directory and run dot per session. Only checked sessions get tools; every other session — and its subagents — has an empty cross-session tool list. |

How visibility works: the four tools are registered once on the Host, then each
live Agent receives a scoped `tools.restrict({ deny })` layer computed from the
settings. Cold sessions are handled on resume (`agent/created`), and disposing an
Agent lifts its restriction. Internal subagent sessions are always restricted:
they are not interactive conversations and cannot use these tools regardless of
the settings. The settings document lives at
`$DSH_HOME/cross-session/settings.json`; the page talks to the Host through
`GET/POST /api/cross-session/settings` (same-origin check + Host trust fence).

## How it works

- **Discovery / resume**: `ctx.sessionController` when the deployment has it
  (Web/Desktop: titles, activity time, cold resume with the deployment's own
  agent-preset composition); otherwise `ctx.sessionQuery` (base profiles:
  cold-safe listing + title folding); otherwise the live `ctx.agents` registry.
- **Delivery**: `agent.followup(message)` or `agent.steer(message)` on the target
  session's live Agent. The message is an ordinary user message with durable
  source `{ kind: 'agent-message', form: 'relay', senderSessionId }` — the same
  attribution the built-in subagent relay uses. Clients that understand it show
  "message from another session"; the text prefix tells the target model.
- **Delivery tiers.** `queue` (default) appends a distinct next turn. `steer`
  injects at the target's next step boundary, so the message joins the context
  of its current turn. `force_insert: true` (urgent) aborts the target's active
  turn with `keepInbox: true` — its own queued input survives — and wakes it
  with this message as the next turn, so the text enters the model context
  without waiting for a long tool call or turn to finish. An idle target is not
  interrupted; the message just starts a turn.
- **Answer**: `session_ask` polls the target's derived history until its turn
  settles and returns the last non-empty assistant text.
- **Answer-only projection.** Both `session_ask` and `session_read` read only
  visible `text` blocks: `reasoning`/`thinking` content blocks never enter a tool
  result, and inline `<thinking>…</thinking>`-style wrappers inside text are
  stripped. `session_read({ final_only: true })` returns just the last assistant
  answer, so polling after `session_send` yields the output and nothing else.
- **No host-package imports.** The Host half only uses Node builtins
  (`node:crypto`, `node:fs`, `node:os`, `node:path`) and its own sibling settings
  module, so it loads from any directory (installed bundle, linked checkout,
  packed tarball).

## Compatibility tiers

| Deployment provides | You get |
|---|---|
| `ctx.tools` + `ctx.agents` | Core tools for sessions that are already live. |
| + `ctx.sessionQuery` (all `dsh-base` profiles) | Titles, cold-safe `session_list` / `session_read`; cold delivery via `ctx.agents.resume`. |
| + `ctx.sessionController` (Web/Desktop) | Activity ordering, exact run state, cold resume that restores the session's agent preset. |

A session recorded with an agent preset cannot be cold-resumed correctly without
`ctx.sessionController`; the plugin refuses with an explanation instead of
silently running it with a different composition.

## Safety

- **Top-level sessions only.** A delegated subagent (`session.header.origin ===
  'subagent'` or with a parent session) is refused, so delegation cannot escape
  its parent chain through this tool.
- **No self-relay.** A session cannot ask itself.
- **Ping-pong guard.** Each delivery records a relay depth (target depth =
  sender depth + 1); past `maxHops` (6) further relaying is refused.
- **Bounded waiting.** `session_ask` waits 120 s by default (max 300 s). A
  timeout does not cancel the target; the message stays delivered.
- The target session keeps its own sandbox, approvals, and tool policy; this
  plugin only delivers a message.

## Install

As a bundle, from this directory (links the checkout):

```
plugin_manager({ action: "install_bundle", target: "/absolute/path/to/dsh-cross-session" })
```

From a clone of this repository, point the same call at the checkout directory
(a linked install, so edits under the checkout are picked up on the next Host
start):

```bash
git clone https://github.com/<you>/dsh-cross-session.git
```

```
plugin_manager({ action: "install_bundle", target: "/absolute/path/to/dsh-cross-session" })
```

or from a package registry once published:

```
plugin_manager({ action: "install_bundle", target: "dsh-cross-session" })
```

Remove with `plugin_manager({ action: "remove_bundle", target: "dsh-cross-session" })`.

## Configuration

The bundle row may pass a config object; `lib/index.js` merges it over its
built-in policy and ignores unknown keys/types:

| Key | Default | Meaning |
|---|---|---|
| `maxHops` | `6` | relay depth before a conversation is refused |
| `maxAskSeconds` | `300` | hard cap for one `session_ask` wait |
| `defaultAskSeconds` | `120` | default wait |
| `maxListRows` | `60` | `session_list` page cap |
| `listScanLimit` | `200` | how many recent sessions listing/matching scans |
| `maxReadMessages` | `40` | `session_read` page cap |
| `maxReadChars` | `2000` | per-entry transcript truncation |
| `maxReplyChars` | `16000` | relayed reply truncation |
| `relayTtlMs` | `600000` | how long a relay keeps counting towards `maxHops` |

## Limits

- `session_ask` returns the final text of one settled turn. A long-running target
  may hit the timeout; poll with `session_read` afterwards.
- `queue` (default) waits behind whatever the target is doing; use `steer` to
  inject at its next step boundary, or `force_insert: true` when the message
  cannot wait — it aborts the target's current turn (queued input preserved) and
  makes this message the next turn. Forced inserts stop the target's current
  work, so use them only for genuinely urgent messages.
- If another process holds the target's write handle (e.g. a one-shot run), the
  cold resume fails with a writer-held error.
- No chat-surface UI: interactions happen through tool calls. The one UI the
  plugin adds is its Settings page; it never modifies the user's sessions except
  by delivering the message you asked it to deliver.
- Tool visibility is per live Agent. A settings change re-applies restrictions
  immediately to every live Agent; a cold session picks the policy up when it is
  resumed. The session that saves a whitelist not containing itself loses the
  tools on its next model request (the Settings page keeps working).

## Repository layout

| Path | Role |
|---|---|
| `lib/index.js` | Host half: tool definitions and execution, delivery tiers, discovery/resume, guards, settings policy, HTTP route. |
| `lib/settings.mjs` | Pure settings document: normalisation, whitelist → deny-list mapping, atomic JSON persistence. |
| `client.js` | Browser half: the Settings page (React, registered through the `settings.section` slot). |
| `cordis.patch.yml` | Bundle patch that activates the plugin in a profile. |
| `locale/` | Settings page labels (`en.json`, `zh.json`). |
| `icon.svg` | Plugin icon (512 viewBox). |
| `test/selfcheck.mjs` | Fake-Host self-check; needs no install and touches no profile. |

## Development

```bash
npm test          # same as: node test/selfcheck.mjs
```

The self-check needs no installation and changes no profile: it applies the
plugin to a fake Host context, exercises every tool and guard, and — when the
real `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-session` packages can be found
on the machine — cross-validates the tool schemas and the relay message against
the actual validators (skipped, not failed, when absent).

CI (`.github/workflows/selfcheck.yml`) runs the same check on Node 22 for every
push and pull request.

## Contributing

Issues and pull requests are welcome. Please keep the plugin generic: no
profile-specific paths, session ids, or personal configuration in the code or
tests.

## License

MIT.

---

# 中文说明

一个**通用**的 DSH Host 插件，只做一件事：让某个会话里的 AI 发现、读取并主动
跟**别的会话**对话。

- 四个工具：`session_list`（列会话）、`session_read`（只读看记录，不唤醒对方；**不含思维链**，`final_only: true` 只取最后一条 assistant 最终输出）、
  `session_ask`（发消息并等回答）、`session_send`（只投递，可 queue / steer / **`force_insert: true` 强插入**：对方在跑时中断当前轮、保留它自己的排队输入，把这条消息作为下一轮立刻放进上下文，适合"急事插队"）。
- 不绑定任何 profile、用户或工作目录；只强依赖 `ctx.tools` / `ctx.agents`，
  其余能力（`sessionController`、`sessionQuery`）在调用时按需探测，缺了就降级。
- **设置页**（设置 →「跨会话对话」，order 27）：①工具集开关＝"四个全开 / 只开 `session_send`"；
  ②"对所有会话开放"开关（开启时忽略白名单）；③会话白名单＝带标题/目录/运行状态勾选列表。
  白名单外（且未开启全局开放）的会话，以及它们的 subagent，工具列表里不会出现任何跨会话工具；
  保存后立即对全部 live Agent 生效，冷会话在 resume 时套用。设置存于
  `$DSH_HOME/cross-session/settings.json`，页面通过 `GET/POST /api/cross-session/settings` 读写。
- 消息以 relay 归属投递（与内建 subagent 中继同一种 source），Web UI 会显示
  “来自某个会话”，目标模型也能从正文前缀看出是谁发的。
- 安全边界：只允许顶层会话使用；不能发给自己；中继深度超过 6 层拒绝；
  `session_ask` 等待默认 120 秒、上限 300 秒，超时不取消对方。
- 安装：`git clone <repo>` 后
  `plugin_manager({ action: "install_bundle", target: "<克隆目录绝对路径>" })`；
  发布到 npm 后也可直接 `target: "dsh-cross-session"`。
- 仓库结构：Host 半端 `lib/index.js` + `lib/settings.mjs`，浏览器半端 `client.js`，
  bundle 补丁 `cordis.patch.yml`，图标 `icon.svg`，自检 `test/selfcheck.mjs`。
- 自检：`npm test`（即 `node test/selfcheck.mjs`；不需要安装，也不会改动任何
  profile；CI 会在 Node 22 上跑同一份检查）。
