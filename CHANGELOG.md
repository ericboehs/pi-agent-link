# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `reply` answers the sole pending inbound ask without reconstructing its sender;
  `to` disambiguates when multiple agents are waiting.
- `pending` lists unanswered inbound asks with sender, age, and a short preview.
- Pi peers now publish live `idle`, `thinking`, and `tool:<name>` status in Claude's
  session registry and `agent-link` session lists.

### Changed
- The package is now `pi-agent-link`, with `agent-link` and `/agent-link` as the
  model-facing tool and UI command. Claude-specific transport internals retain
  their descriptive names.
- Startup banner is now off by default. Opt in via env `PI_AGENT_LINK_BANNER`
  or the sentinel file `/tmp/pi-agent-link-banner.on`.

### Fixed
- Peer name now tracks the pi session's display name. Previously the name was
  captured once at `session_start`, so a name set via `/name`, `--name`, RPC, or
  `pi.setSessionName()` after that moment was ignored and the session appeared in
  Claude's `/list-agents` as the `pi-<cwd>` fallback. The extension now listens for
  `session_info_changed` (and reconciles on `turn_start`) and pushes the current
  name to Claude's registry so `/list-agents` updates live.

## [0.1.0] - 2026-08-08

Initial release.

### Added
- Pi sessions auto-register as peers in Claude Code's registry and appear in
  `/list-agents` (on `session_start`; cleaned up on `session_shutdown`).
- Real-time inbound: messages from Claude are injected into the live pi session via
  `pi.sendUserMessage` (idle → new turn; busy → steer), with delivery receipts.
- Reply relay: pi's answer is sent back to the originating Claude session on `agent_end`.
- Model-facing `claude-link` tool with `list` / `send` / `ask` (blocking) actions,
  a `/claude-link` command, and a bundled skill.
- Sender display names resolved from Claude's registry to match `/list-agents`.
- Dependency-free `claude-protocol.ts` port of Claude's cross-session wire protocol.

[0.1.0]: https://github.com/ericboehs/pi-agent-link/releases/tag/v0.1.0
