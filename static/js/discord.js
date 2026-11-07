if (IS_DISCORD_ACTIVITY) {

/* Discord Embedded App SDK — loaded only for Discord Activity sessions. */
{
  // WebRTC and direct-browser networking are deliberately not supported.
  (async () => {
    const appId = "1565709969913815060";
    const inviteButton = document.getElementById("btnDiscordInvite");
    const shareButton = document.getElementById("btnDiscordShare");
    try {
      // Load the official SDK from this Activity's own static assets.
      const { DiscordSDK, patchUrlMappings } = await import("/static/discord-sdk.bundle.js");
      // Route Cloudflare WebSocket traffic through Discord's Activity proxy.
      // Configure /relay -> bigconhosting.wax-no-bones.workers.dev in Developer Portal.
      patchUrlMappings([
        { prefix: "/title-assets", target: "raw.githubusercontent.com/waxmotson/The-big-con-desktop/master" },
        { prefix: "/characters", target: "raw.githubusercontent.com/waxmotson/bigcon/main/characters" },
        { prefix: "/relay", target: "bigconhosting.wax-no-bones.workers.dev" },
        { prefix: "/", target: "thebigcon.onrender.com" }
      ]);
      const discordSdk = new DiscordSDK(appId);
      await discordSdk.ready();
      window.bigconDiscordSDK = discordSdk;

      // The Embedded App SDK handles its own OAuth redirect. Exchange the
      // returned one-time code on the Cloudflare Worker, then authenticate
      // the SDK before attempting Rich Presence updates.
      try {
        const { code } = await discordSdk.commands.authorize({
          client_id: appId,
          response_type: "code",
          state: crypto.randomUUID(),
          prompt: "none",
          scope: ["identify", "rpc.activities.write"]
        });
        const tokenResponse = await fetch("/relay/api/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({ code })
        });
        const tokenData = await tokenResponse.json().catch(() => ({}));
        if (!tokenResponse.ok || !tokenData.access_token) {
          throw new Error(tokenData.error || "Discord token exchange failed (HTTP " + tokenResponse.status + ").");
        }
        const auth = await discordSdk.commands.authenticate({
          access_token: tokenData.access_token
        });
        if (!auth) throw new Error("Discord SDK authentication returned no user.");
        Presence.attachDiscordSDK(discordSdk, tokenData.access_token);
        console.info("[BigCon Discord] Rich Presence authorised and SDK authenticated.");
      } catch (presenceError) {
        console.warn("[BigCon Discord] Rich Presence permission unavailable:", presenceError);
        const status = document.getElementById("netStatus");
        if (status) {
          status.textContent = "Discord connected; Rich Presence unavailable: " +
            (presenceError?.message || String(presenceError));
          status.classList.remove("err");
        }
      }

      if (inviteButton) {
        inviteButton.style.display = "inline-block";
        inviteButton.addEventListener("click", async () => {
          inviteButton.disabled = true;
          try {
            await discordSdk.commands.openInviteDialog();
          } catch (error) {
            console.warn("[BigCon Discord] Invite dialog unavailable:", error);
          } finally {
            inviteButton.disabled = false;
          }
        });
      }

      if (shareButton) {
        shareButton.style.display = "inline-block";
        shareButton.addEventListener("click", async () => {
          const code = (document.getElementById("roomCodeBig")?.textContent || "").trim();
          if (!code || code === "·····") {
            alert("Create a room first, then share its code.");
            return;
          }
          shareButton.disabled = true;
          try {
            await discordSdk.commands.shareLink({
              message: "Join my Big Con game. Open the Big Con Activity and enter room code: " + code,
              custom_id: "bigcon-room-share"
            });
          } catch (error) {
            console.warn("[BigCon Discord] Room share failed:", error);
          } finally {
            shareButton.disabled = false;
          }
        });
      }
      window.dispatchEvent(new CustomEvent("bigcon-discord-ready"));
      const status = document.getElementById("netStatus");
      if (status) { status.textContent = "Discord connected — Cloudflare relay ready."; status.classList.remove("err"); }
      console.info("[BigCon Discord] Embedded App SDK ready.");
    } catch (error) {
      console.error("[BigCon Discord] Activity SDK could not initialise:", error);
      const detail = error && (error.message || error.toString()) || "Unknown SDK error";
      const status = document.getElementById("netStatus");
      if (status) {
        status.textContent = "Discord SDK failed to initialise: " + detail;
        status.classList.add("err");
      }
      document.querySelectorAll("#btnHost,#btnJoin,#btnCreate,#btnJoinGo").forEach(button => button.disabled = true);
      window.dispatchEvent(new CustomEvent("bigcon-discord-sdk-error", { detail }));
    }
  })();
}

}
