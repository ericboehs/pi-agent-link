# Contributing

Thanks for your interest! This is a small, dependency-free pi extension.

## Layout

- `index.ts` — the extension (default-exported `ExtensionAPI` factory).
- `claude-protocol.ts` — Claude Code's cross-session wire protocol (registry, sockets,
  envelope). The single place to update if Claude's protocol changes.
- `skills/pi-claude-link/SKILL.md` — teaches the pi model to use the `claude-link` tool.
- `test/` — end-to-end harnesses driving a real pi rpc session.

No build step: pi runs the TypeScript directly.

## Dependencies

There are none to install. `typebox` and `@earendil-works/*` are peer dependencies
that pi hands to extensions as virtual modules from its own bundle, so `.npmrc`
sets `legacy-peer-deps=true` to stop npm auto-installing ~180 MB into every clone
that nothing imports. Plain `node` cannot resolve those specifiers here — only pi
can, which is the point.

To typecheck locally you do need them on disk:

```bash
npm install --no-save --legacy-peer-deps=false   # ~180 MB, then delete node_modules
npx tsc --noEmit -p tsconfig.json
```

## Running the tests

Requires pi installed and a **Node ≥ 20.19** (pi crashes on older Node). If the `pi`
on your PATH runs on an older Node, point `PI_CMD` at a compatible one:

```bash
export PI_CMD="$HOME/.nvm/versions/node/v22.16.0/bin/node \
               $(npm root -g)/@earendil-works/pi-coding-agent/dist/cli.js"

node --experimental-strip-types test/reg-test.mjs     # registration + cleanup
node --experimental-strip-types test/roundtrip.mjs    # inbound relay + outbound tool
node --experimental-strip-types --test test/naming.mjs  # name collisions (no pi needed)
```

`reg-test` and `roundtrip` load this extension with `-e`, which clashes with an
installed copy of the same package. Point pi at a scratch config dir to avoid it:

```bash
PI_CODING_AGENT_DIR=/tmp/pi-scratch node --experimental-strip-types test/reg-test.mjs
```

The harnesses only use throwaway sessions/listeners — they never message your real
sessions. Set `PI_CLAUDE_LINK_DEBUG=1` (or `touch /tmp/pi-claude-link-debug.on`) for
logs at `/tmp/pi-claude-link-debug.log`.

## Guidelines

- Keep `claude-protocol.ts` free of pi/agent imports (Node built-ins only) so it stays
  portable and testable.
- Prefer small, verifiable changes; run both harnesses before opening a PR.
- Be mindful of the security model (see `SECURITY.md`) — don't add paths that let
  untrusted/automated input reach an agent unprompted.

By contributing you agree your contributions are licensed under the MIT License.
