// Reply-relay tests: a `send` exchange has to settle after one round-trip.
//
// Two pi sessions that message each other used to lock together permanently.
// Every inbound armed a reply, and a relayed reply arrives as an ordinary
// inbound, so A's answer became B's prompt and B's answer became A's prompt,
// forever, whatever the content. These tests drive the real helpers rather than
// re-implementing the rule, so the loop cannot come back unnoticed.
//
// Pure functions only, no sockets and no HOME:
//   node --experimental-strip-types test/relay.mjs
import assert from "node:assert/strict";
import test from "node:test";

const { shouldArmReply, frameInbound, REPLY_MODE, buildEnvelope, stripEnvelope } =
  await import("../claude-protocol.ts");

const SOCK = "uds:/tmp/pi-claude-link-test.sock";

test("a fresh message from a socket peer arms a reply", () => {
  assert.equal(shouldArmReply(SOCK, undefined), true);
});

test("a relayed reply does not arm another reply", () => {
  assert.equal(shouldArmReply(SOCK, REPLY_MODE), false);
});

test("non-socket senders never arm a reply", () => {
  assert.equal(shouldArmReply("cli", undefined), false);
  assert.equal(shouldArmReply("", undefined), false);
});

test("from-mode survives the envelope round-trip", () => {
  const wire = buildEnvelope({ from: SOCK, fromName: "pi-b", fromMode: REPLY_MODE, body: "done" });
  const env = stripEnvelope(wire);
  assert.equal(env.fromMode, REPLY_MODE);
  assert.equal(env.body, "done");
});

test("reply framing tells the model not to answer", () => {
  const fresh = frameInbound({ who: "pi-b", body: "hi" });
  const reply = frameInbound({ who: "pi-b", body: "hi" });
  assert.match(fresh, /relayed back to the sender/);
  assert.equal(reply, fresh);

  const marked = frameInbound({ who: "pi-b", body: "hi", fromMode: REPLY_MODE });
  assert.match(marked, /do not reply/);
  assert.doesNotMatch(marked, /relayed back to the sender/);
});

// The whole point: simulate the exchange and show it terminates. Each session
// is a set of armed senders; a turn relays its answer to everyone armed, then
// disarms. Before the fix this ran until the step cap.
test("a send exchange settles after one round-trip", () => {
  const A = { sock: "uds:/tmp/a.sock", armed: new Set() };
  const B = { sock: "uds:/tmp/b.sock", armed: new Set() };

  /** Deliver one message; returns true if the receiver will answer back. */
  const deliver = (to, fromSock, fromMode) => {
    if (!shouldArmReply(fromSock, fromMode)) return false;
    to.armed.add(fromSock);
    return true;
  };
  /** Run the receiver's turn: relay to everyone armed, then disarm. */
  const turn = (self, peer) => {
    const targets = [...self.armed];
    self.armed.clear();
    return targets.map(() => deliver(peer, self.sock, REPLY_MODE));
  };

  // A sends to B. B arms.
  assert.equal(deliver(B, A.sock, undefined), true);
  assert.equal(B.armed.size, 1);

  // B answers. The reply reaches A but must not arm A.
  assert.deepEqual(turn(B, A), [false]);
  assert.equal(A.armed.size, 0, "a relayed reply must not arm an answer");
  assert.equal(B.armed.size, 0, "B disarms after answering once");

  // A's next turn has nobody to relay to, so the exchange is over.
  assert.deepEqual(turn(A, B), []);
  assert.equal(B.armed.size, 0);
});

test("both sides opening at once still settle", () => {
  // A and B message each other simultaneously: each arms once, each answers
  // once, and both replies are terminal. Four messages total, then silence.
  const A = { sock: "uds:/tmp/a.sock", armed: new Set() };
  const B = { sock: "uds:/tmp/b.sock", armed: new Set() };
  const arm = (to, from, mode) => shouldArmReply(from, mode) && to.armed.add(from);

  arm(B, A.sock, undefined);
  arm(A, B.sock, undefined);
  assert.equal(A.armed.size, 1);
  assert.equal(B.armed.size, 1);

  for (const [self, peer] of [[A, B], [B, A]]) {
    const targets = [...self.armed];
    self.armed.clear();
    for (const _ of targets) arm(peer, self.sock, REPLY_MODE);
  }
  assert.equal(A.armed.size, 0);
  assert.equal(B.armed.size, 0);
});
