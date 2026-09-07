/**
 * pi-agent-link — mesh a pi coding-agent session with Claude Code.
 *
 * On session start this extension registers the pi session as a peer in Claude's
 * cross-session registry (so it appears in Claude's /list-agents) and binds a
 * socket that speaks Claude's wire protocol. Inbound messages from Claude are
 * injected into the live pi session in real time; the pi model can list and
 * message agent sessions via the `agent-link` tool.
 *
 * Runs in-process; no daemon, no external transport — Claude's registry is the hub.
 */

import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  ccSocksDir, bindSocket, registerPeer, updatePeer, deregisterPeer,
  firstFreeName, losesNameRace,
  listClaudeSessions, resolveTarget, sendToClaude, stripEnvelope, receiptFrame, sendFrame,
  peerLabel, planDedupe, renamePeer,
  shouldArmReply, frameInbound, REPLY_MODE, ASK_MODE,
  slugFromCwd, peerNameBySock, HOME,
} from "./claude-protocol.ts";
import path from "node:path";
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Server } from "node:net";

// Debug logging: enabled by env PI_AGENT_LINK_DEBUG or the sentinel /tmp/pi-agent-link-debug.on
// (pi may not propagate env to extensions in all modes, so the sentinel is handy).
const dbg = (...a: unknown[]) => {
  if (!(process.env.PI_AGENT_LINK_DEBUG || existsSync("/tmp/pi-agent-link-debug.on"))) return;
  try { appendFileSync("/tmp/pi-agent-link-debug.log", `[pi-agent-link ${new Date().toISOString()}] ${a.join(" ")}\n`); } catch { /* */ }
};

interface AskWaiter { resolve: (body: string) => void; timer: NodeJS.Timeout; }
interface PendingReply { hops: number; who: string; receivedAt: number; preview: string; }

export default function piMeshExtension(pi: ExtensionAPI) {
  let started = false;
  let server: Server | undefined;
  let sockPath = "";
  let ownFrom = "";
  let selfName = "";
  let sessionCwd = "";
  const pid = process.pid;
  let lastCtx: ExtensionContext | undefined;

  const fallbackName = () => `pi-${slugFromCwd(sessionCwd || process.cwd())}`;

  // Derived names come from the directory, so every pi in one checkout wants
  // the same one. Claim the first free slot instead of shipping a duplicate.
  const startedAt = Date.now();
  let nameSource: "user" | "derived" = "derived";
  const liveNames = async (): Promise<string[]> =>
    (await listClaudeSessions({ excludeSock: sockPath })).map((r) => r.name);

  /**
   * Two pis starting in the same instant can claim the same slot, so re-check
   * after registering: the oldest keeps the name (pid breaks ties) and the
   * others move on. Both sides read the same registry values, so exactly one
   * winner emerges per round and the loop converges.
   */
  async function settleNameRace(): Promise<void> {
    for (let attempt = 0; attempt < 5 && nameSource === "derived"; attempt++) {
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 150));
      const rows = await listClaudeSessions({ excludeSock: sockPath });
      const rivals = rows.filter((r) => r.name === selfName);
      if (!rivals.some((rival) => losesNameRace({ startedAt, pid }, rival))) return;
      selfName = firstFreeName(fallbackName(), rows.map((r) => r.name));
      await updatePeer(pid, { name: selfName, nameSource: "derived" }).catch(() => {});
      syncSummaryFile();
      persistDerivedName();
      dbg(`yielded a contested name, now ${selfName}`);
    }
  }

  // Apply a (possibly cleared) pi session name to our peer identity. Once we've
  // registered, push it to Claude's registry so /list-agents updates live.
  async function applyName(name?: string): Promise<void> {
    const trimmed = (name || "").trim();
    // A name the user chose is theirs verbatim; only derived names get suffixed.
    const next = trimmed || firstFreeName(fallbackName(), started ? await liveNames() : []);
    if (next === selfName) return;
    selfName = next;
    nameSource = trimmed ? "user" : "derived";
    if (started) {
      await updatePeer(pid, { name: selfName, nameSource }).catch(() => {});
      syncSummaryFile();
      if (nameSource === "derived") persistDerivedName();
      dbg(`renamed peer to ${selfName}`);
      if (nameSource === "derived") await settleNameRace();
    }
  }

  // Stamp derived peer names onto the session so psst /resume show `pi-dotfiles-2`
  // after the process exits (instead of a short uuid). Never overwrite a name
  // the user set with `/name` or `--name`.
  function persistDerivedName(): void {
    if (nameSource !== "derived" || !selfName) return;
    const current = (pi.getSessionName() || "").trim();
    if (current === selfName) return;
    const base = fallbackName();
    // Don't clobber a real `/name`. Stale derived stamps (`pi-dotfiles` before
    // the uniqueness race) are in the same series and may be replaced.
    if (current && current !== base && !current.startsWith(`${base}-`)) return;
    try { pi.setSessionName(selfName); } catch { /* */ }
  }

  // Senders blocked in `ask`, with enough metadata for `pending` and `reply`.
  const pendingReplies = new Map<string, PendingReply>();
  // Blocking `ask` waiters, keyed by the target's socket path.
  const askWaiters = new Map<string, AskWaiter[]>();
  let peerStatus = "idle";
  const activeTools = new Map<string, string>();

  async function setPeerStatus(status: string): Promise<void> {
    if (!started || status === peerStatus) return;
    peerStatus = status;
    syncSummaryFile();
    await updatePeer(pid, { status }).catch(() => {});
  }

  // ---- shared-cache mirror (for psst; ~/.claude stays Claude's) -------------
  // psst must not read ~/.claude (guarded on this machine), so we mirror the
  // name/status/summary triple into a neutral cache file that psst can read.
  // Same layout root both sides: $XDG_CACHE_HOME/agent-link/summaries | ~/.cache/…
  function summaryCacheDir(): string {
    const base = process.env.XDG_CACHE_HOME || path.join(HOME, ".cache");
    return path.join(base, "agent-link", "summaries");
  }
  const summaryFile = () => path.join(summaryCacheDir(), `${pid}.json`);
  let lastSummary = "";

  function syncSummaryFile(): void {
    if (!started) return;
    try {
      mkdirSync(summaryCacheDir(), { recursive: true });
      const body = JSON.stringify({
        pid, name: selfName, cwd: sessionCwd, status: peerStatus,
        summary: lastSummary, updatedAt: Date.now(),
      });
      // Atomic write (tmp + rename) so readers never see a torn file.
      const tmp = `${summaryFile()}.${process.pid}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, summaryFile());
    } catch { /* best effort */ }
  }

  function clearSummaryFile(): void {
    try { unlinkSync(summaryFile()); } catch { /* */ }
  }

  // ---- activity summary (Claude agent-view style row text) -----------------
  // Two tiers, mirroring Claude Code's agent view: an instant snippet written
  // from the session's own output, then an async small-model one-liner at end
  // of turn. A `turnSeq` counter keeps a slow polish from overwriting a newer
  // turn's state.
  const SUMMARY_ENABLED = process.env.PI_AGENT_LINK_SUMMARY !== "0";
  // Local-first default: free, no subscription. Override with e.g.
  // PI_AGENT_LINK_SUMMARY_MODEL=anthropic/claude-haiku-4-5.
  const SUMMARY_MODEL = process.env.PI_AGENT_LINK_SUMMARY_MODEL || "ollama/glm-5.3-flash";
  let turnSeq = 0;

  const oneLine = (t: string, max = 120) => t.replace(/\s+/g, " ").trim().slice(0, max);

  async function publishSummary(text: string): Promise<void> {
    const line = oneLine(text);
    if (!line || !started) return;
    lastSummary = line;
    dbg(`summary: ${line}`);
    syncSummaryFile();
    await updatePeer(pid, { summary: line }).catch(() => {});
  }

  function pickSummaryModel(ctx: ExtensionContext): any {
    const reg: any = ctx.modelRegistry;
    if (typeof reg?.find === "function" && SUMMARY_MODEL.includes("/")) {
      const [provider, id] = SUMMARY_MODEL.split("/", 2);
      const found = reg.find(provider, id);
      if (found) return found;
    }
    const avail: any[] = typeof reg?.getAvailable === "function" ? reg.getAvailable() : [];
    // Cheap-class fallback (Claude: "no Haiku-class model → use the main model").
    return avail.find((m) => /flash|haiku|mini|nano|lite/i.test(String(m?.id || ""))) || ctx.model;
  }

  async function polishSummary(ctx: ExtensionContext, seq: number, text: string): Promise<void> {
    if (!SUMMARY_ENABLED || !text) return;
    const model = pickSummaryModel(ctx);
    if (!model) return;
    dbg(`polishing summary with ${model.id ?? model}`);
    try {
      const res: any = await (ctx.modelRegistry as any).complete(
        model,
        {
          messages: [
            {
              role: "user",
              content:
                "You write one-line status summaries for a coding-agent session picker. " +
                "Given the agent's latest response, write ONE short line (max 10 words) describing " +
                "what it just did, produced, or is asking about. Plain text only — no quotes, no trailing period, no markdown.\n\n" +
                `Response:\n${text.slice(0, 2000)}`,
            },
          ],
        },
        { maxTokens: 60, reasoning: "minimal", cacheRetention: "none", signal: AbortSignal.timeout(20_000), sessionId: randomUUID() },
      );
      const out = (res?.content || [])
        .filter((c: any) => c?.type === "text")
        .map((c: any) => c.text)
        .join(" ")
        .trim();
      if (!out || seq !== turnSeq) return; // stale: a newer turn superseded it
      dbg(`polished summary: ${out}`);
      await publishSummary(out);
    } catch { /* summary is best-effort; the snippet stands */ }
  }

  // Instant summary from the prompt that just started the turn.
  async function publishPromptSummary(ctx: ExtensionContext): Promise<void> {
    try {
      const branch: any[] = ctx.sessionManager.getBranch() || [];
      for (let i = branch.length - 1; i >= 0; i--) {
        const e: any = branch[i];
        const m = e?.message;
        if (e?.type !== "message" || m?.role !== "user") continue;
        const c = m.content;
        const t = typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ")
            : "";
        if (t.trim()) { await publishSummary(`▸ ${oneLine(t, 100)}`); return; }
      }
    } catch { /* best effort */ }
  }

  const notify = (m: string, level: "info" | "warning" | "error" = "info") => {
    try { lastCtx?.ui.notify(m, level); } catch { /* no UI */ }
  };

  // ---- inbound: a peer frame arrived on our socket -------------------------
  function onFrame(frame: any): void {
    if (frame?.type === "control" && frame.action === "rename" && typeof frame.name === "string") {
      selfName = frame.name;
      updatePeer(pid, { name: frame.name }).catch(() => {});
      syncSummaryFile();
      return;
    }
    if (frame?.type !== "user") return;
    const raw = frame.message?.content;
    if (typeof raw !== "string" || !raw) return;

    const env = stripEnvelope(raw);
    const fromAddr: string = frame.from || env.from || "";
    const targetSock = fromAddr.startsWith("uds:") ? fromAddr.slice(4) : "";
    // Prefer the registry name (matches Claude's /list-agents) over the envelope
    // from-name, which can be a stale/verbose session title.
    const who = peerNameBySock(targetSock) || env.fromName || targetSock || fromAddr || "another agent";

    // If this is the reply to a blocking `ask`, resolve the waiter instead of injecting.
    const waiters = targetSock ? askWaiters.get(targetSock) : undefined;
    if (waiters && waiters.length) {
      const w = waiters.shift()!;
      clearTimeout(w.timer);
      if (!waiters.length) askWaiters.delete(targetSock);
      w.resolve(env.body);
      ackDelivered(fromAddr, frame.msg_id);
      return;
    }

    // Normal inbound: inject into the live pi session (real-time).
    const framed = frameInbound({ who, body: env.body, fromMode: env.fromMode });

    const idle = lastCtx?.isIdle?.() ?? true;
    dbg(`inbound from ${who} (${fromAddr}) idle=${idle}: ${env.body.slice(0, 60)}`);
    try {
      // sendUserMessage always triggers a turn; when busy, steer into the current one.
      pi.sendUserMessage(framed, idle ? undefined : { deliverAs: "steer" });
      // Only a blocked `ask` earns an automatic answer. A plain send is
      // fire-and-forget: without this, our report to our own user gets
      // scraped and delivered to the peer as though it were a message.
      if (shouldArmReply(fromAddr, env.fromMode, env.hops)) {
        pendingReplies.set(fromAddr, {
          hops: (env.hops ?? 0) + 1,
          who,
          receivedAt: Date.now(),
          preview: env.body.replace(/\s+/g, " ").trim().slice(0, 80),
        });
      }
      ackDelivered(fromAddr, frame.msg_id);
      notify(`agent-link: message from ${who}`, "info");
    } catch (e) { dbg(`inject failed: ${(e as Error).message}`); }
  }

  function ackDelivered(fromAddr: string, origMsgId?: string) {
    if (typeof fromAddr === "string" && fromAddr.startsWith("uds:")) {
      sendFrame(fromAddr.slice(4), receiptFrame({
        status: "delivered", from: ownFrom, origMsgId,
        reason: "Delivered to the pi session.",
      })).catch(() => {});
    }
  }

  // ---- reply relay: after the pi turn answers, send its text back ----------
  function lastAssistantText(messages: AgentEndEvent["messages"]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m: any = messages[i];
      if (!m || m.role !== "assistant") continue;
      const c = m.content;
      if (typeof c === "string") return c.trim() || undefined;
      if (Array.isArray(c)) {
        const t = c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n").trim();
        if (t) return t;
      }
    }
    return undefined;
  }

  function relayReply(event: AgentEndEvent) {
    if (!pendingReplies.size) return;
    const answer = lastAssistantText(event.messages || []);
    if (!answer) return;
    const targets = [...pendingReplies];
    pendingReplies.clear();
    dbg(`relaying reply to ${targets.length} sender(s): ${answer.slice(0, 60)}`);
    for (const [from, pending] of targets) {
      if (!from.startsWith("uds:")) continue;
      sendToClaude({
        sock: from.slice(4), body: answer, from: ownFrom, fromName: selfName,
        fromMode: REPLY_MODE, hops: pending.hops,
      }).catch(() => {});
    }
  }

  // ---- lifecycle -----------------------------------------------------------
  async function start(ctx: ExtensionContext) {
    lastCtx = ctx;
    if (started) return;
    started = true;
    sessionCwd = ctx.cwd || process.cwd();
    const cwd = sessionCwd;
    const sessionId = ctx.sessionManager.getSessionId() || undefined;
    sockPath = path.join(ccSocksDir(), `${pid}.sock`);
    ownFrom = `uds:${sockPath}`;
    const chosen = (pi.getSessionName() || "").trim();
    nameSource = chosen ? "user" : "derived";
    selfName = chosen || firstFreeName(fallbackName(), await liveNames());
    try {
      server = await bindSocket(sockPath, (frame) => onFrame(frame));
      peerStatus = "idle";
      await registerPeer({ pid, sessionId, name: selfName, cwd, sockPath, status: peerStatus, startedAt, nameSource });
      syncSummaryFile();
      dbg(`started name=${selfName} pid=${pid} sock=${sockPath} session=${sessionId}`);
      if (nameSource === "derived") {
        persistDerivedName();
        void settleNameRace().then(() => persistDerivedName());
      }
      // Startup banner is off by default; opt in via env PI_AGENT_LINK_BANNER
      // or the sentinel /tmp/pi-agent-link-banner.on.
      if (process.env.PI_AGENT_LINK_BANNER || existsSync("/tmp/pi-agent-link-banner.on"))
        notify(`pi-agent-link active as "${selfName}" — reachable from Claude Code /list-agents`, "info");
    } catch (e) {
      started = false;
      notify(`pi-agent-link failed to start: ${(e as Error).message}`, "error");
    }
  }

  async function stop() {
    try { server?.close(); } catch { /* */ }
    clearSummaryFile();
    await deregisterPeer(pid, sockPath).catch(() => {});
  }

  pi.on("session_start", async (_e, ctx) => { await start(ctx); });
  pi.on("turn_start", async (_e, ctx) => {
    lastCtx = ctx;
    if (!started) await start(ctx);
    // Catch a name that landed after session_start (e.g. --name applied late).
    else await applyName(pi.getSessionName() ?? undefined);
    turnSeq++;
    await setPeerStatus("thinking");
    void publishPromptSummary(ctx);
  });
  pi.on("session_info_changed", async (event, ctx) => {
    lastCtx = ctx;
    if (!started) await start(ctx);
    await applyName((event as { name?: string })?.name);
  });
  pi.on("tool_execution_start", async (event, ctx) => {
    lastCtx = ctx;
    activeTools.set(event.toolCallId, event.toolName);
    await setPeerStatus(`tool:${event.toolName}`);
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    lastCtx = ctx;
    activeTools.delete(event.toolCallId);
    const remaining = [...activeTools.values()].at(-1);
    await setPeerStatus(remaining ? `tool:${remaining}` : "thinking");
  });
  pi.on("agent_end", async (event, ctx) => {
    lastCtx = ctx;
    relayReply(event);
    // Row summary: instant snippet from our own output, then async model polish.
    const out = lastAssistantText(event.messages || []);
    if (out) {
      const seq = turnSeq;
      void publishSummary(out).then(() => polishSummary(ctx, seq, out));
    }
  });
  pi.on("agent_settled", async (_event, ctx) => {
    lastCtx = ctx;
    activeTools.clear();
    await setPeerStatus("idle");
  });
  pi.on("session_shutdown", async () => { await stop(); });

  // ---- outbound: the model-facing tool ------------------------------------
  const PARAMS = Type.Object({
    action: Type.Union([
      Type.Literal("list"), Type.Literal("send"), Type.Literal("ask"),
      Type.Literal("reply"), Type.Literal("pending"),
    ], { description: "list sessions; send fire-and-forget; ask and wait; reply to a pending ask; list pending asks" }),
    to: Type.Optional(Type.String({ description: "Target name or id; optional to disambiguate reply" })),
    message: Type.Optional(Type.String({ description: "Message text for send, ask, or reply" })),
  });

  const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], details: {}, ...(isError && { isError: true }) });

  pi.registerTool({
    name: "agent-link",
    label: "Agent Link",
    description:
      "Talk to agent sessions running on this machine: list, send, ask and wait, " +
      "reply to a pending ask, or list pending asks.",
    promptSnippet: "Message other agent sessions on this machine.",
    parameters: PARAMS,
    async execute(_id, params) {
      const excludeSock = sockPath;
      if (params.action === "list") {
        const rows = await listClaudeSessions({ excludeSock });
        if (!rows.length) return text("No live agent sessions found.");
        return text(`Live sessions (${rows.length}):\n` + rows.map((r) => {
          const bits = [peerLabel(r, rows), r.cwd, r.status];
          if (r.summary) bits.push(r.summary);
          return `- ${bits.join("  ·  ")}`;
        }).join("\n"));
      }
      if (params.action === "pending") {
        if (!pendingReplies.size) return text("No pending inbound asks.");
        const now = Date.now();
        const lines = [...pendingReplies.values()].map((p) => {
          const seconds = Math.max(0, Math.floor((now - p.receivedAt) / 1000));
          return `- ${p.who}  ·  ${seconds}s  ·  ${p.preview}`;
        });
        return text(`Pending asks (${lines.length}):\n${lines.join("\n")}`);
      }
      const to = String(params.to || "").trim();
      const message = String(params.message ?? "");
      if (!message) return text("Error: 'message' is required.", true);

      if (params.action === "reply") {
        let targetEntry: [string, PendingReply] | undefined;
        if (to) {
          const res = await resolveTarget(to, { excludeSock });
          if (res.error) {
            const hint = res.candidates?.length ? ` Available: ${res.candidates.join(", ")}.` : "";
            return text(`Error: ${res.error}.${hint}`, true);
          }
          const from = `uds:${res.target!.sock}`;
          const pending = pendingReplies.get(from);
          if (!pending) return text(`Error: no pending ask from "${res.target!.name}".`, true);
          targetEntry = [from, pending];
        } else if (pendingReplies.size === 1) {
          targetEntry = pendingReplies.entries().next().value;
        } else if (!pendingReplies.size) {
          return text("Error: no pending inbound asks.", true);
        } else {
          return text(`Error: multiple pending asks; specify 'to'. Pending: ${[...pendingReplies.values()].map((p) => p.who).join(", ")}.`, true);
        }
        const [from, pending] = targetEntry!;
        try {
          await sendToClaude({
            sock: from.slice(4), body: message, from: ownFrom, fromName: selfName,
            fromMode: REPLY_MODE, hops: pending.hops,
          });
          pendingReplies.delete(from);
          return text(`Replied to "${pending.who}".`);
        } catch (e) {
          return text(`Error replying to "${pending.who}": ${(e as Error).message}`, true);
        }
      }

      if (!to) return text("Error: 'to' is required.", true);
      const res = await resolveTarget(to, { excludeSock });
      if (res.error) {
        const hint = res.candidates?.length ? ` Available: ${res.candidates.join(", ")}.` : "";
        return text(`Error: ${res.error}.${hint}`, true);
      }
      const target = res.target!;
      if (params.action === "send") {
        try {
          await sendToClaude({ sock: target.sock, body: message, from: ownFrom, fromName: selfName });
          return text(`Delivered to "${target.name}". Nothing comes back automatically — use action:"ask" if you need an answer.`);
        } catch (e) {
          return text(`Error delivering to "${target.name}": ${(e as Error).message}`, true);
        }
      }
      // action === "ask": send, then block for the reply. ASK_MODE is what tells
      // the receiver somebody is waiting, and is the only thing that earns an
      // automatic relay of their next turn.
      try {
        await sendToClaude({ sock: target.sock, body: message, from: ownFrom, fromName: selfName, fromMode: ASK_MODE });
      } catch (e) {
        return text(`Error delivering to "${target.name}": ${(e as Error).message}`, true);
      }
      const reply = await new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => {
          const list = askWaiters.get(target.sock) || [];
          const idx = list.indexOf(waiter);
          if (idx >= 0) list.splice(idx, 1);
          resolve(null);
        }, 120000);
        const waiter: AskWaiter = { resolve: (b) => resolve(b), timer };
        const list = askWaiters.get(target.sock) || [];
        list.push(waiter);
        askWaiters.set(target.sock, list);
      });
      return reply === null
        ? text(`Sent to "${target.name}", but no reply within 120s.`)
        : text(`Reply from "${target.name}":\n${reply}`);
    },
  });

  // ---- convenience command -------------------------------------------------
  pi.registerCommand("agent-link", {
    description: "List Claude Code sessions you can message; 'dedupe' un-collides their names",
    handler: async (args, ctx) => {
      const rows = await listClaudeSessions({ excludeSock: sockPath });
      if (args.trim() === "dedupe") {
        // Include ourselves: our name is one of the ones that can collide.
        const all = [...rows, { pid, name: selfName, cwd: sessionCwd, status: peerStatus, sock: sockPath, startedAt, entrypoint: "pi", nameSource }];
        const plans = planDedupe(all);
        if (!plans.length) { ctx.ui.notify("No duplicate names among live sessions.", "info"); return; }
        const done: string[] = [];
        const failed: string[] = [];
        for (const plan of plans) {
          if (plan.peer.pid === pid) { selfName = plan.to; await updatePeer(pid, { name: selfName, nameSource: "derived" }).catch(() => {}); syncSummaryFile(); done.push(`${plan.from} → ${plan.to} (us)`); continue; }
          try {
            await renamePeer(plan.peer.sock, plan.to);
            done.push(`${plan.from} → ${plan.to} (pid ${plan.peer.pid})`);
          } catch (e) {
            failed.push(`${plan.from} (pid ${plan.peer.pid}): ${(e as Error).message}`);
          }
        }
        ctx.ui.notify(
          [done.length ? `Renamed:\n${done.map((d) => `  ${d}`).join("\n")}` : "", failed.length ? `Failed:\n${failed.map((f) => `  ${f}`).join("\n")}` : ""]
            .filter(Boolean).join("\n"),
          failed.length ? "warning" : "info",
        );
        return;
      }
      if (!rows.length) { ctx.ui.notify("No live Claude sessions found.", "info"); return; }
      ctx.ui.notify(`Reachable: ${rows.map((r) => `${peerLabel(r, rows)} [${r.status}]${r.summary ? ` — ${r.summary}` : ""}`).join(", ")}`, "info");
    },
  });
}
