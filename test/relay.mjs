// Reply-relay tests: an exchange has to terminate, and a plain `send` must not
// produce an answer at all.
//
// Two pi sessions that message each other used to lock together permanently.
// Every inbound armed a reply, and `relayReply` ships the session's *turn
// output* — which is the agent's report to its own user, not a message aimed at
// the peer. So each side kept answering the other's user-facing summary, and
// content was irrelevant: even "idle" is turn output worth relaying. Marking
// replies terminal bounded it at one round-trip; requiring ASK_MODE removes the
// mechanism, and MAX_HOPS bounds whatever a mislabelling peer does next.
//
// These tests drive the real helpers rather than re-implementing the rule.
//
// Pure functions only, no sockets and no HOME:
//   node --experimental-strip-types test/relay.mjs
import assert from "node:assert/strict";
import test from "node:test";

const { shouldArmReply, frameInbound, REPLY_MODE, ASK_MODE, MAX_HOPS, buildEnvelope, stripEnvelope } =
  await import("../claude-protocol.ts");

const SOCK = "uds:/tmp/pi-agent-link-test.sock";

test("a plain send never arms an answer", () => {
  assert.equal(shouldArmReply(SOCK, undefined), false);
});

test("a blocked ask arms exactly one answer", () => {
  assert.equal(shouldArmReply(SOCK, ASK_MODE), true);
});

test("a relayed reply does not arm another reply", () => {
  assert.equal(shouldArmReply(SOCK, REPLY_MODE), false);
});

test("the hop cap stops a peer that mislabels replies as asks", () => {
  assert.equal(shouldArmReply(SOCK, ASK_MODE, MAX_HOPS - 1), true);
  assert.equal(shouldArmReply(SOCK, ASK_MODE, MAX_HOPS), false);
  assert.equal(shouldArmReply(SOCK, ASK_MODE, MAX_HOPS + 7), false);
});

test("non-socket senders never arm a reply", () => {
  assert.equal(shouldArmReply("cli", ASK_MODE), false);
  assert.equal(shouldArmReply("", ASK_MODE), false);
});

test("from-mode and hops survive the envelope round-trip", () => {
  const wire = buildEnvelope({ from: SOCK, fromName: "pi-b", fromMode: REPLY_MODE, hops: 1, body: "done" });
  const env = stripEnvelope(wire);
  assert.equal(env.fromMode, REPLY_MODE);
  assert.equal(env.hops, 1);
  assert.equal(env.body, "done");

  const plain = stripEnvelope(buildEnvelope({ from: SOCK, body: "hi" }));
  assert.equal(plain.fromMode, undefined);
  assert.equal(plain.hops, undefined, "absent hops must not become 0 by accident");
});

test("each framing matches what the channel actually does", () => {
  const send = frameInbound({ who: "pi-b", body: "hi" });
  assert.match(send, /Nothing you write goes back automatically/);

  const ask = frameInbound({ who: "pi-b", body: "hi", fromMode: ASK_MODE });
  assert.match(ask, /blocked waiting/);
  assert.match(ask, /relayed back/);

  const reply = frameInbound({ who: "pi-b", body: "hi", fromMode: REPLY_MODE });
  assert.match(reply, /do not reply/);
  assert.doesNotMatch(reply, /relayed back/);

  for (const f of [send, ask, reply]) assert.doesNotMatch(f, /Claude Code/, "peers are pi sessions too");
});

// The whole point: simulate the exchange and show it terminates. Each session
// is a map of armed senders; a turn relays its answer to everyone armed, then
// disarms. Before the fix this ran until the step cap.
test("a plain send produces no answer at all", () => {
  const A = { sock: "uds:/tmp/a.sock", armed: new Map() };
  const B = { sock: "uds:/tmp/b.sock", armed: new Map() };

  /** Deliver one message; returns true if the receiver will answer back. */
  const deliver = (to, fromSock, fromMode, hops) => {
    if (!shouldArmReply(fromSock, fromMode, hops)) return false;
    to.armed.set(fromSock, (hops ?? 0) + 1);
    return true;
  };

  assert.equal(deliver(B, A.sock, undefined), false, "send must not arm");
  assert.equal(B.armed.size, 0);
});

test("an ask settles after exactly one round-trip", () => {
  const A = { sock: "uds:/tmp/a.sock", armed: new Map() };
  const B = { sock: "uds:/tmp/b.sock", armed: new Map() };

  const deliver = (to, fromSock, fromMode, hops) => {
    if (!shouldArmReply(fromSock, fromMode, hops)) return false;
    to.armed.set(fromSock, (hops ?? 0) + 1);
    return true;
  };
  /** Run the receiver's turn: relay to everyone armed, then disarm. */
  const turn = (self, peer) => {
    const targets = [...self.armed];
    self.armed.clear();
    return targets.map(([, hops]) => deliver(peer, self.sock, REPLY_MODE, hops));
  };

  // A asks B. B arms.
  assert.equal(deliver(B, A.sock, ASK_MODE, 0), true);
  assert.equal(B.armed.size, 1);

  // B answers. The reply reaches A but must not arm A.
  assert.deepEqual(turn(B, A), [false]);
  assert.equal(A.armed.size, 0, "a relayed reply must not arm an answer");
  assert.equal(B.armed.size, 0, "B disarms after answering once");

  // A's next turn has nobody to relay to, so the exchange is over.
  assert.deepEqual(turn(A, B), []);
  assert.equal(B.armed.size, 0);
});

test("both sides asking at once still settle", () => {
  // A and B ask each other simultaneously: each arms once, each answers once,
  // and both replies are terminal. Four messages total, then silence.
  const A = { sock: "uds:/tmp/a.sock", armed: new Map() };
  const B = { sock: "uds:/tmp/b.sock", armed: new Map() };
  const arm = (to, from, mode, hops) =>
    shouldArmReply(from, mode, hops) && to.armed.set(from, (hops ?? 0) + 1);

  arm(B, A.sock, ASK_MODE, 0);
  arm(A, B.sock, ASK_MODE, 0);
  assert.equal(A.armed.size, 1);
  assert.equal(B.armed.size, 1);

  for (const [self, peer] of [[A, B], [B, A]]) {
    const targets = [...self.armed];
    self.armed.clear();
    for (const [, hops] of targets) arm(peer, self.sock, REPLY_MODE, hops);
  }
  assert.equal(A.armed.size, 0);
  assert.equal(B.armed.size, 0);
});

test("a peer that answers every reply with an ask still terminates", () => {
  // The failure the hop cap exists for: a broken or old implementation marks
  // its relayed answers ASK_MODE, so the terminal check never fires. Hops keep
  // climbing because each relay carries its predecessor's count.
  let hops = 0;
  let exchanges = 0;
  while (shouldArmReply(SOCK, ASK_MODE, hops)) {
    hops += 1;
    if (++exchanges > 50) break;
  }
  assert.equal(exchanges, MAX_HOPS, "the cap has to bound it");
  assert.ok(exchanges < 50, "and it must not run away");
});
