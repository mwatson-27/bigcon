import { DurableObject } from "cloudflare:workers";

const MAX_CONNECTIONS = 8;
const DISCORD_CLIENT_ID = "1565709969913815060";
const UNJOINED_TTL_MS = 10_000;
const ROOM_RE = /^[A-Z0-9-]{1,40}$/;
const INSTANCE_RE = /^[A-Za-z0-9_-]{1,120}$/;

// Browser origins allowed to call the HTTP API. Discord serves the Activity
// from https://<client_id>.discordsays.com; nothing else calls these endpoints.
const ALLOWED_ORIGINS = new Set(["https://" + DISCORD_CLIENT_ID + ".discordsays.com"]);

// Per-channel notification limits, enforced by the NotifyLimiter Durable Object.
const NOTIFY_WINDOW_MS = 60_000;
const TURN_MIN_GAP_MS = 3_000;
const TURN_PER_WINDOW = 10;
const GAME_OVER_MIN_GAP_MS = 10_000;
const TOTAL_PER_WINDOW = 15;

function corsHeaders(request, allowHeaders) {
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": allowHeaders,
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
  const origin = request.headers.get("Origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Discord Embedded App SDK OAuth code exchange. Keep the client secret
    // in a Worker secret; never send it to the Activity/browser.
    if (url.pathname === "/api/token") {
      const cors = corsHeaders(request, "Content-Type");
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
      const cors = corsHeaders(request, "Content-Type, Authorization");
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
      const instanceId = typeof body?.instance_id === "string" ? body.instance_id : "";
      if (!INSTANCE_RE.test(instanceId)) return Response.json({ error: "A valid Activity instance ID is required." }, { status: 400, headers: cors });

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
      const userId = identity?.user?.id;
      if (typeof userId !== "string" || !userId) {
        return Response.json({ error: "Could not identify the Discord user." }, { status: 403, headers: cors });
      }

      // Bind the request to the caller's own Activity: the instance must exist
      // for this application, run in the claimed channel and include this user.
      // Otherwise any Activity user could make the bot post into any channel.
      let instanceResponse;
      try {
        instanceResponse = await fetch(
          "https://discord.com/api/v10/applications/" + DISCORD_CLIENT_ID + "/activity-instances/" + encodeURIComponent(instanceId),
          { headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN } },
        );
      } catch {
        return Response.json({ error: "Could not verify the Activity instance." }, { status: 502, headers: cors });
      }
      if (instanceResponse.status === 404) return Response.json({ error: "Activity instance not found." }, { status: 403, headers: cors });
      if (!instanceResponse.ok) return Response.json({ error: "Could not verify the Activity instance." }, { status: 502, headers: cors });
      const instance = await instanceResponse.json().catch(() => ({}));
      if (instance?.application_id !== undefined && instance.application_id !== DISCORD_CLIENT_ID) {
        return Response.json({ error: "Activity instance belongs to a different application." }, { status: 403, headers: cors });
      }
      if (instance?.location?.channel_id !== channelId) {
        return Response.json({ error: "Activity instance is not running in this channel." }, { status: 403, headers: cors });
      }
      if (!Array.isArray(instance.users) || !instance.users.includes(userId)) {
        return Response.json({ error: "You are not part of this Activity instance." }, { status: 403, headers: cors });
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

      // Per-channel rate limit (checked last so rejected requests spend no budget).
      if (!env.NOTIFY_LIMITER) return Response.json({ error: "Notification rate limiter is not configured." }, { status: 503, headers: cors });
      let verdict;
      try {
        verdict = await env.NOTIFY_LIMITER.get(env.NOTIFY_LIMITER.idFromName("notify:" + channelId)).take(event.type);
      } catch {
        return Response.json({ error: "Notification rate limiter unavailable." }, { status: 503, headers: cors });
      }
      if (!verdict?.ok) {
        const retryAfter = Math.max(1, Math.ceil(Number(verdict?.retryAfterMs) / 1000) || 1);
        return Response.json({ error: "Too many notifications for this channel." }, {
          status: 429,
          headers: { ...cors, "Retry-After": String(retryAfter) },
        });
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
    this.ctx.setWebSocketAutoResponse?.(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  sockets(role) {
    return this.ctx.getWebSockets().filter((ws) => {
      const a = ws.deserializeAttachment();
      return a?.role === role && ws.readyState === WebSocket.OPEN;
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

  webSocketMessage(ws, raw) {
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
      if (attachment.joined) return;
      const hosts = this.sockets("host");
      if (attachment.role === "guest" && !hosts.length) {
        this.send(ws, { type: "error", code: "peer-unavailable", message: "Room host is not connected" });
        ws.close(1013, "Host unavailable");
        return;
      }
      attachment.joined = true;
      ws.serializeAttachment(attachment);

      if (attachment.role === "host") {
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
      } else {
        const host = this.sockets("host")[0];
        if (!host) {
          this.send(ws, { type: "error", code: "peer-unavailable", message: "Room host is not connected" });
          ws.close(1013, "Host unavailable");
          return;
        }
        this.send(ws, { type: "ready", id: attachment.id });
        this.send(host, { type: "incoming", id: attachment.id });
      }
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

  webSocketClose(ws, code, reason) {
    const attachment = ws.deserializeAttachment();
    if (!attachment) return;
    if (attachment.role === "host") {
      // Guests can remain connected during the host's reconnect backoff.
      for (const guest of this.sockets("guest")) this.send(guest, { type: "host_lost" });
    } else {
      for (const host of this.sockets("host")) this.send(host, { type: "left", id: attachment.id });
    }
  }

  webSocketError(ws) {
    try { ws.close(1011, "Relay socket error"); } catch {}
  }
}

// One instance per Activity channel ("notify:<channel_id>"). Durable Object
// storage is the only state shared across Worker isolates, so the sliding
// window lives here. Only accepted notifications are recorded.
export class NotifyLimiter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  async take(kind) {
    const now = Date.now();
    const log = ((await this.ctx.storage.get("log")) || []).filter((e) => now - e[0] < NOTIFY_WINDOW_MS);
    const ofKind = log.filter((e) => e[1] === kind);
    const last = ofKind.length ? ofKind[ofKind.length - 1][0] : -Infinity;
    const gap = kind === "game_over" ? GAME_OVER_MIN_GAP_MS : TURN_MIN_GAP_MS;
    const cap = kind === "game_over" ? TOTAL_PER_WINDOW : TURN_PER_WINDOW;

    let waitMs = Math.max(0, last + gap - now);
    // Window full: wait until the oldest counted entry ages out.
    if (ofKind.length >= cap) waitMs = Math.max(waitMs, ofKind[0][0] + NOTIFY_WINDOW_MS - now);
    if (log.length >= TOTAL_PER_WINDOW) waitMs = Math.max(waitMs, log[0][0] + NOTIFY_WINDOW_MS - now);
    if (waitMs > 0) return { ok: false, retryAfterMs: waitMs };

    log.push([now, kind]);
    await this.ctx.storage.put("log", log);
    // Drop the record once the window has passed so idle channels cost nothing.
    await this.ctx.storage.setAlarm(now + NOTIFY_WINDOW_MS + 1_000);
    return { ok: true };
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
