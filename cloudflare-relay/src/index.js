import { DurableObject } from "cloudflare:workers";

const MAX_CONNECTIONS = 8;
const ROOM_RE = /^[A-Z0-9-]{1,40}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
    if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS) {
      return new Response("Room is full", { status: 429 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const id = crypto.randomUUID();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, role, joined: false });

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
