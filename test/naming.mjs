// Name-collision tests: several pis in one directory derive the same name, so
// registration has to claim a free slot and resolution must refuse to guess.
//
// Runs against a throwaway HOME with real listening sockets, so it never
// touches ~/.claude/sessions. Needs Node >= 20.19 for --experimental-strip-types:
//   node --experimental-strip-types test/naming.mjs
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import test from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "pi-agent-link-naming-"));
process.env.HOME = home;
const REG = path.join(home, ".claude", "sessions");
mkdirSync(REG, { recursive: true });

// CLAUDE_REGISTRY is resolved at import time, so HOME must be set first.
const { firstFreeName, losesNameRace, listClaudeSessions, resolveTarget, peerLabel, planDedupe } =
  await import("../claude-protocol.ts");

const servers = [];
/** Register a peer backed by a real socket, so the liveness probe passes. */
async function peer({ pid, name, startedAt = Date.now(), cwd = "/tmp/work" }) {
  const sock = path.join(home, `${pid}.sock`);
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(sock, resolve));
  servers.push(server);
  writeFileSync(
    path.join(REG, `${pid}.json`),
    JSON.stringify({
      pid, name, cwd, startedAt, status: "idle", entrypoint: "pi",
      sessionId: `session-${pid}`, messagingSocketPath: sock,
    }),
  );
  return sock;
}

test("firstFreeName suffixes only once a slot is taken", () => {
  assert.equal(firstFreeName("pi-dotfiles", []), "pi-dotfiles");
  assert.equal(firstFreeName("pi-dotfiles", ["pi-other"]), "pi-dotfiles");
  assert.equal(firstFreeName("pi-dotfiles", ["pi-dotfiles"]), "pi-dotfiles-2");
  assert.equal(firstFreeName("pi-dotfiles", ["pi-dotfiles", "pi-dotfiles-2"]), "pi-dotfiles-3");
  // Gaps left by exited sessions get reused.
  assert.equal(firstFreeName("pi-dotfiles", ["pi-dotfiles", "pi-dotfiles-3"]), "pi-dotfiles-2");
});

test("the oldest session keeps a contested name, pid breaks ties", () => {
  const self = { startedAt: 100, pid: 500 };
  assert.equal(losesNameRace(self, { startedAt: 99, pid: 900 }), true, "older rival wins");
  assert.equal(losesNameRace(self, { startedAt: 101, pid: 1 }), false, "newer rival yields");
  assert.equal(losesNameRace(self, { startedAt: 100, pid: 499 }), true, "tie: lower pid wins");
  assert.equal(losesNameRace(self, { startedAt: 100, pid: 501 }), false);
  // Exactly one winner: the comparison is a total order, never mutual.
  const a = { startedAt: 100, pid: 500 }, b = { startedAt: 100, pid: 501 };
  assert.notEqual(losesNameRace(a, b), losesNameRace(b, a));
});

test("duplicate names resolve to an error, not an arbitrary session", async () => {
  await peer({ pid: 900001, name: "pi-work", startedAt: 1 });
  await peer({ pid: 900002, name: "pi-work", startedAt: 2 });
  await peer({ pid: 900003, name: "pi-solo", startedAt: 3 });

  const rows = await listClaudeSessions({});
  assert.equal(rows.length, 3);

  const dupe = await resolveTarget("pi-work");
  assert.equal(dupe.target, undefined, "must not silently pick one");
  assert.match(dupe.error, /matches 2 live sessions/);
  // Newest first, matching the list ordering.
  assert.deepEqual(dupe.candidates, ["pi-work (pid 900002)", "pi-work (pid 900001)"]);

  const byPid = await resolveTarget("900002");
  assert.equal(byPid.target.pid, 900002, "pid is the escape hatch");
  const bySession = await resolveTarget("session-900001");
  assert.equal(bySession.target.pid, 900001);
  const unique = await resolveTarget("pi-solo");
  assert.equal(unique.target.pid, 900003);

  // Prefix matching still works, and still refuses to guess.
  assert.equal((await resolveTarget("pi-s")).target.pid, 900003);
  assert.match((await resolveTarget("pi-")).error, /matches 3 live sessions/);
  assert.match((await resolveTarget("nope")).error, /no live Claude session/);
});

test("labels stay clean when names are unique", async () => {
  const rows = await listClaudeSessions({});
  const solo = rows.find((r) => r.name === "pi-solo");
  assert.equal(peerLabel(solo, rows), "pi-solo");
});

test("dedupe moves the newer duplicates and leaves everything else alone", () => {
  const rows = [
    { pid: 1, name: "pi-work", startedAt: 10, entrypoint: "pi", nameSource: "derived", sock: "a", cwd: "/w", status: "idle" },
    { pid: 2, name: "pi-work", startedAt: 20, entrypoint: "pi", nameSource: "derived", sock: "b", cwd: "/w", status: "idle" },
    { pid: 3, name: "pi-work", startedAt: 30, entrypoint: "pi", nameSource: "derived", sock: "c", cwd: "/w", status: "idle" },
    { pid: 4, name: "pi-solo", startedAt: 40, entrypoint: "pi", nameSource: "derived", sock: "d", cwd: "/s", status: "idle" },
  ];
  assert.deepEqual(
    planDedupe(rows).map((p) => `${p.peer.pid}:${p.from}->${p.to}`),
    ["2:pi-work->pi-work-2", "3:pi-work->pi-work-3"],
    "oldest keeps the name; the rest take free slots",
  );

  // An existing -2 is part of the same series, so the mover skips to -3.
  const withSuffix = [
    rows[0],
    { ...rows[1], name: "pi-work-2" },
    rows[2],
  ];
  assert.deepEqual(planDedupe(withSuffix).map((p) => p.to), ["pi-work-3"]);

  // Names the user chose, and peers that are not pi, are never touched.
  const protectedRows = [
    rows[0],
    { ...rows[1], nameSource: "user" },
    { ...rows[2], entrypoint: "claude" },
  ];
  assert.deepEqual(planDedupe(protectedRows), []);
  assert.deepEqual(planDedupe([rows[3]]), [], "unique names need no plan");
});

test.after(() => { for (const s of servers) s.close(); });
