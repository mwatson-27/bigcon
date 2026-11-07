import { DurableObject } from "cloudflare:workers";

const MAX_CONNECTIONS = 8;
const DISCORD_CLIENT_ID = "1565709969913815060";
const UNJOINED_TTL_MS = 10_000;
const ROOM_RE = /^[A-Z0-9-]{1,40}$/;
// A room's host claim lapses once the room has had no connected sockets for this long.
const CLAIM_IDLE_MS = 10 * 60_000;
const CLAIM_KEY = "claim";
const SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/;

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Compare without bailing out at the first differing character.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Discord Embedded App SDK OAuth code exchange. Keep the client secret
    // in a Worker secret; never send it to the Activity/browser.
    if (url.pathname === "/api/token") {
      const cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Cache-Control": "no-store",
      };
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: cors });
      }
      if (request.method !== "POST") {
        return Response.json({ error: "Method not allowed" }, { status: 405, headers: cors });
      }
      if (!env.DISCORD_CLIENT_SECRET) {
        return Response.json({ error: "Discord OAuth is not configured on the relay." }, { status: 503, headers: cors });
      }
      let body;
      try {
        const raw = await request.text();
        if (raw.length > 8192) throw new Error("Request too large");
        body = JSON.parse(raw);
      } catch {
        return Response.json({ error: "Invalid request body." }, { status: 400, headers: cors });
      }
      const code = typeof body?.code === "string" ? body.code.trim() : "";
      if (!code || code.length > 2048) {
        return Response.json({ error: "A valid Discord authorisation code is required." }, { status: 400, headers: cors });
      }

      const form = new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://127.0.0.1",
      });
      let discordResponse;
      try {
        discordResponse = await fetch("https://discord.com/api/v10/oauth2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
        });
      } catch {
        return Response.json({ error: "Could not contact Discord OAuth." }, { status: 502, headers: cors });
      }
      const tokenData = await discordResponse.json().catch(() => ({}));
      if (!discordResponse.ok || !tokenData.access_token) {
        return Response.json({
          error: "Discord rejected the authorisation code.",
          detail: tokenData.error_description || tokenData.error || "OAuth token exchange failed.",
        }, { status: 401, headers: cors });
      }
      return Response.json({ access_token: tokenData.access_token }, { headers: cors });
    }

    if (url.pathname === "/api/notify") {
      const cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Cache-Control": "no-store",
      };
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405, headers: cors });
      if (!env.DISCORD_BOT_TOKEN) return Response.json({ error: "Discord bot is not configured. Add DISCORD_BOT_TOKEN to the Worker secrets." }, { status: 503, headers: cors });
      const authorization = request.headers.get("Authorization") || "";
      const accessToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
      if (!accessToken || accessToken.length > 4096) return Response.json({ error: "Discord Activity authentication is required." }, { status: 401, headers: cors });
      let body;
      try {
        const raw = await request.text();
        if (raw.length > 8192) throw new Error("Request too large");
        body = JSON.parse(raw);
      } catch {
        return Response.json({ error: "Invalid request body." }, { status: 400, headers: cors });
      }
      const channelId = typeof body?.channel_id === "string" ? body.channel_id : "";
      if (!/^\d{17,20}$/.test(channelId)) return Response.json({ error: "A valid Activity channel ID is required." }, { status: 400, headers: cors });

      // Validate the caller's short-lived Activity OAuth token and make sure it
      // was issued to THIS application, so tokens from other Discord apps
      // cannot be used to make the bot post.
      let identityResponse;
      try {
        identityResponse = await fetch("https://discord.com/api/v10/oauth2/@me", {
          headers: { Authorization: "Bearer " + accessToken },
        });
      } catch {
        return Response.json({ error: "Could not validate Discord Activity authentication." }, { status: 502, headers: cors });
      }
      if (!identityResponse.ok) return Response.json({ error: "Discord Activity authentication expired or was rejected." }, { status: 401, headers: cors });
      const identity = await identityResponse.json().catch(() => ({}));
      if (identity?.application?.id !== DISCORD_CLIENT_ID) {
        return Response.json({ error: "Token was not issued to this Activity." }, { status: 403, headers: cors });
      }

      const event = body?.event;
      let content = "";
      if (event?.type === "turn") {
        const turn = Number(event.turn);
        const player = typeof event.player === "string" ? event.player.trim().slice(0, 80) : "";
        if (!Number.isSafeInteger(turn) || turn < 1 || !player) return Response.json({ error: "Invalid turn notification." }, { status: 400, headers: cors });
        content = "🔔 **THE BIG CON — Turn " + turn + "**\nIt is **" + player.replace(/[@<>]/g, "") + "**’s turn.";
      } else if (event?.type === "game_over") {
        const winner = typeof event.winner === "string" ? event.winner.trim().slice(0, 80) : "";
        const scores = Array.isArray(event.scores) ? event.scores.slice(0, 8) : [];
        if (!winner) return Response.json({ error: "Invalid game-end notification." }, { status: 400, headers: cors });
        const scoreLines = scores.map((score) => {
          const name = typeof score?.name === "string" ? score.name.trim().slice(0, 60).replace(/[@<>]/g, "") : "Player";
          const money = Number(score?.money);
          return name + ": $" + (Number.isFinite(money) ? Math.max(0, Math.min(999999, Math.floor(money))) : 0);
        });
        content = "🏆 **THE BIG CON — Game over**\n**" + winner.replace(/[@<>]/g, "") + "** wins the con!" +
          (scoreLines.length ? "\n\nFinal standings:\n" + scoreLines.map((line, i) => (i + 1) + ". " + line).join("\n") : "");
      } else {
        return Response.json({ error: "Unsupported notification type." }, { status: 400, headers: cors });
      }

      let discordResponse;
      try {
        discordResponse = await fetch("https://discord.com/api/v10/channels/" + channelId + "/messages", {
          method: "POST",
          headers: {
            Authorization: "Bot " + env.DISCORD_BOT_TOKEN,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
        });
      } catch {
        return Response.json({ error: "Could not contact Discord's message API." }, { status: 502, headers: cors });
      }
      if (!discordResponse.ok) {
        const detail = await discordResponse.json().catch(() => ({}));
        return Response.json({
          error: "Discord could not post to this Activity channel.",
          detail: detail.message || ("Discord HTTP " + discordResponse.status),
        }, { status: discordResponse.status === 403 ? 403 : 502, headers: cors });
      }
      return Response.json({ ok: true }, { headers: cors });
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "bigcon-relay" });
    }
    const match = url.pathname.match(/^\/ws\/([^/]+)$/);
    if (!match) return new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    let room;
    try { room = decodeURIComponent(match[1]).toUpperCase(); } catch { room = ""; }
    if (!ROOM_RE.test(room)) return new Response("Invalid room code", { status: 400 });
    const role = url.searchParams.get("role");
    if (role !== "host" && role !== "guest") {
      return new Response("role must be host or guest", { status: 400 });
    }
    const id = env.BIGCON_ROOMS.idFromName(room);
    return env.BIGCON_ROOMS.get(id).fetch(request);
  },
};

export class BigConRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    // In-memory only: both guard work inside a single awake period, which can
    // never span a hibernation. The claim itself lives in storage.
    this.hostQueue = Promise.resolve();
    this.joining = new WeakSet();
    this.ctx.setWebSocketAutoResponse?.(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  // Joined, open sockets of a role. A socket that has not completed "join" (for
  // a host: has not proven the room secret) is never a routing target.
  sockets(role) {
    return this.ctx.getWebSockets().filter((ws) => {
      const a = ws.deserializeAttachment();
      return a?.role === role && a.joined && ws.readyState === WebSocket.OPEN;
    });
  }

  send(ws, payload) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    const hosts = this.sockets("host");
    // Cheap early refusal while a host is connected. The host secret can't be
    // checked here (it travels in the join message, not the URL); the join
    // handler verifies it and re-checks this under a lock.
    if (role === "host" && hosts.length) {
      return new Response("Room already has a host", { status: 409 });
    }
    if (role === "guest" && !hosts.length) {
      return new Response("Room host is not connected", { status: 404 });
    }
    // Drop sockets that never sent "join" so idle connections can't hold a room full.
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && !a.joined && Date.now() - (a.t || 0) > UNJOINED_TTL_MS) {
        try { ws.close(1008, "Join timeout"); } catch {}
      }
    }
    if (this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN).length >= MAX_CONNECTIONS) {
      return new Response("Room is full", { status: 429 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const id = crypto.randomUUID();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, role, joined: false, t: Date.now() });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      if (typeof raw !== "string" || raw.length > 256_000) {
        ws.close(1009, "Message too large");
        return;
      }
      msg = JSON.parse(raw);
    } catch {
      this.send(ws, { type: "error", code: "bad-message", message: "Invalid JSON" });
      return;
    }

    const attachment = ws.deserializeAttachment();
    if (!attachment) return;

    if (msg.type === "join") {
      if (attachment.joined || this.joining.has(ws)) return;
      if (attachment.role === "host") {
        this.joining.add(ws);
        // One host join at a time, so two racing joins can't both claim the room.
        const run = this.hostQueue.then(() => this.joinHost(ws, attachment, msg.secret));
        this.hostQueue = run.catch(() => {});
        try {
          await run;
        } catch {
          this.send(ws, { type: "error", code: "internal", message: "Could not join the room" });
          try { ws.close(1011, "Internal error"); } catch {}
        } finally {
          this.joining.delete(ws);
        }
        return;
      }
      const host = this.sockets("host")[0];
      if (!host) {
        this.send(ws, { type: "error", code: "peer-unavailable", message: "Room host is not connected" });
        ws.close(1013, "Host unavailable");
        return;
      }
      attachment.joined = true;
      ws.serializeAttachment(attachment);
      this.send(ws, { type: "ready", id: attachment.id });
      this.send(host, { type: "incoming", id: attachment.id });
      return;
    }

    if (!attachment.joined) return;
    if (msg.type === "data") {
      const target = msg.target;
      const recipient = attachment.role === "guest"
        ? this.sockets("host")[0]
        : this.sockets("guest").find((candidate) => candidate.deserializeAttachment()?.id === target);
      if (recipient) this.send(recipient, {
        type: "data",
        source: attachment.role === "guest" ? attachment.id : undefined,
        data: msg.data,
      });
      return;
    }

    if (msg.type === "leave" && attachment.role === "host") {
      const guest = this.sockets("guest").find((candidate) => candidate.deserializeAttachment()?.id === msg.target);
      if (guest) guest.close(1000, "Host closed connection");
    }
  }

  reject(ws, code, message, closeReason) {
    this.send(ws, { type: "error", code, message });
    try { ws.close(1008, closeReason); } catch {}
  }

  // Host join: the first host to join claims the room by storing a hash of its
  // secret. Later hosts must present the same secret until the claim lapses.
  async joinHost(ws, attachment, secret) {
    if (typeof secret !== "string" || !SECRET_RE.test(secret)) {
      this.reject(ws, "host-secret-required",
        "A host secret is required to host a room. Reload the page to update.", "Host secret required");
      return;
    }
    const hash = await sha256Hex(secret);
    if (ws.readyState !== WebSocket.OPEN) return; // went away while hashing

    let claim = await this.ctx.storage.get(CLAIM_KEY);
    if (claim?.idleSince && Date.now() - claim.idleSince >= CLAIM_IDLE_MS) claim = null; // lapsed
    if (claim && !safeEqual(claim.hash, hash)) {
      this.reject(ws, "room-claimed",
        "This room code is already claimed by another host. Pick a different code.", "Room claimed");
      return;
    }
    if (this.sockets("host").some((h) => h !== ws)) {
      this.reject(ws, "host-taken", "Room already has a host", "Host taken");
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;

    if (!claim || claim.idleSince) {
      await this.ctx.storage.put(CLAIM_KEY, { hash, idleSince: null });
      await this.ctx.storage.deleteAlarm();
    }
    if (ws.readyState !== WebSocket.OPEN) return;

    attachment.joined = true;
    ws.serializeAttachment(attachment);
    this.send(ws, { type: "ready", id: attachment.id });
    // Preserve guest sockets across a host transport reconnect. Re-announce
    // each guest so the host can rebuild its per-player connection objects.
    for (const guest of this.sockets("guest")) {
      const a = guest.deserializeAttachment();
      if (a?.joined) {
        this.send(ws, { type: "incoming", id: a.id });
        this.send(guest, { type: "host_back" });
      }
    }
  }

  async webSocketClose(ws, code, reason) {
    const attachment = ws.deserializeAttachment();
    if (!attachment) return;
    // Sockets that never joined (including rejected hosts) are invisible to the room.
    if (attachment.joined) {
      if (attachment.role === "host") {
        // Guests can remain connected during the host's reconnect backoff.
        for (const guest of this.sockets("guest")) this.send(guest, { type: "host_lost" });
      } else {
        for (const host of this.sockets("host")) this.send(host, { type: "left", id: attachment.id });
      }
    }
    await this.markIdleIfEmpty(ws);
  }

  // Start the claim's expiry clock when the last socket leaves. It is never
  // restarted while running, so stray connections can't keep an abandoned code locked.
  async markIdleIfEmpty(closing) {
    if (this.ctx.getWebSockets().some((s) => s !== closing && s.readyState === WebSocket.OPEN)) return;
    const claim = await this.ctx.storage.get(CLAIM_KEY);
    if (!claim || claim.idleSince) return;
    const idleSince = Date.now();
    await this.ctx.storage.put(CLAIM_KEY, { ...claim, idleSince });
    await this.ctx.storage.setAlarm(idleSince + CLAIM_IDLE_MS);
  }

  async alarm() {
    const claim = await this.ctx.storage.get(CLAIM_KEY);
    if (!claim?.idleSince) return;
    if (this.ctx.getWebSockets().some((s) => s.readyState === WebSocket.OPEN)) return;
    const due = claim.idleSince + CLAIM_IDLE_MS;
    if (Date.now() >= due) await this.ctx.storage.delete(CLAIM_KEY);
    else await this.ctx.storage.setAlarm(due);
  }

  webSocketError(ws) {
    try { ws.close(1011, "Relay socket error"); } catch {}
  }
}
