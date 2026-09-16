/**
 * NexControl lightweight Telegram client.
 * Requires Node.js 18+ (native fetch). No framework dependency.
 *
 * Usage:
 *   const nc = new NexControlClient({ controlUrl, apiKey, telegramToken, version });
 *   await nc.start();
 *   // Feed every Telegram update your framework receives:
 *   void nc.observeUpdate(update);
 */
export class NexControlClient {
  constructor({ controlUrl, apiKey, telegramToken, version = "unknown", pollMs = 2500, heartbeatMs = 60000, logger = console }) {
    if (!controlUrl || !apiKey || !telegramToken) throw new Error("controlUrl, apiKey and telegramToken are required");
    this.controlUrl = controlUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.telegramToken = telegramToken;
    this.version = version;
    this.pollMs = Math.max(1000, pollMs);
    this.heartbeatMs = Math.max(15000, heartbeatMs);
    this.logger = logger;
    this.stopped = true;
    this.me = null;
    this.chatSyncCache = new Map();
  }

  async api(path, init = {}) {
    const res = await fetch(`${this.controlUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", "x-nexcontrol-key": this.apiKey, ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`NexControl ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async tg(method, payload = {}) {
    const res = await fetch(`https://api.telegram.org/bot${this.telegramToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!json.ok) {
      const err = new Error(json.description || `Telegram ${method} failed`);
      err.telegram = json;
      throw err;
    }
    return json.result;
  }

  async getMe() {
    if (!this.me) this.me = await this.tg("getMe");
    return this.me;
  }

  normalizeRights(member) {
    const rights = {};
    for (const [key, value] of Object.entries(member || {})) if (key.startsWith("can_") || key === "is_member") rights[key] = value;
    return rights;
  }

  async inspectChat(chatId) {
    const me = await this.getMe();
    const [chat, member] = await Promise.all([
      this.tg("getChat", { chat_id: chatId }),
      this.tg("getChatMember", { chat_id: chatId, user_id: me.id }),
    ]);
    let memberCount;
    try { memberCount = await this.tg("getChatMemberCount", { chat_id: chatId }); } catch {}
    const type = chat.type;
    if (!["group", "supergroup", "channel"].includes(type)) return null;
    return {
      chatId: String(chat.id),
      type,
      title: chat.title || chat.username || String(chat.id),
      username: chat.username || undefined,
      botStatus: member.status || "unknown",
      rights: this.normalizeRights(member),
      active: !["left", "kicked"].includes(member.status),
      memberCount,
      lastSeenAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
    };
  }

  async syncChats(chatIds) {
    const unique = [...new Set(chatIds.map(String))];
    const items = [];
    for (const id of unique) {
      try {
        const item = await this.inspectChat(id);
        if (item) items.push(item);
      } catch (error) {
        this.logger.warn?.("[NexControl] chat sync failed", id, error?.message || error);
      }
    }
    if (items.length) await this.api("/api/v1/destinations/sync", { method: "POST", body: JSON.stringify({ items }) });
    return items;
  }

  extractChat(update) {
    return update?.message?.chat || update?.edited_message?.chat || update?.channel_post?.chat || update?.edited_channel_post?.chat || update?.my_chat_member?.chat || update?.chat_member?.chat || null;
  }

  async observeUpdate(update) {
    const chat = this.extractChat(update);
    if (!chat || !["group", "supergroup", "channel"].includes(chat.type)) return;
    const key = String(chat.id);
    const last = this.chatSyncCache.get(key) || 0;
    if (Date.now() - last < 5 * 60_000) return;
    this.chatSyncCache.set(key, Date.now());
    await this.syncChats([chat.id]);
  }

  async refreshKnownChats() {
    const { chatIds = [] } = await this.api("/api/v1/destinations/known");
    if (chatIds.length) await this.syncChats(chatIds);
  }

  async heartbeat() {
    const me = await this.getMe();
    return this.api("/api/v1/heartbeat", { method: "POST", body: JSON.stringify({ version: this.version, username: me.username }) });
  }

  async sendTelegramJob(job) {
    const parse_mode = job.payload.parseMode === "none" ? undefined : job.payload.parseMode;
    const common = { chat_id: job.chatId, parse_mode };
    try {
      if (job.payload.mediaUrl) {
        return await this.tg("sendPhoto", { ...common, photo: job.payload.mediaUrl, caption: job.payload.text || undefined });
      }
      return await this.tg("sendMessage", { ...common, text: job.payload.text, disable_web_page_preview: false });
    } catch (error) {
      const retryAfter = error?.telegram?.parameters?.retry_after;
      if (retryAfter) {
        await new Promise(r => setTimeout(r, (Number(retryAfter) + 1) * 1000));
        if (job.payload.mediaUrl) return this.tg("sendPhoto", { ...common, photo: job.payload.mediaUrl, caption: job.payload.text || undefined });
        return this.tg("sendMessage", { ...common, text: job.payload.text, disable_web_page_preview: false });
      }
      throw error;
    }
  }

  async pollOnce() {
    const { jobs = [] } = await this.api("/api/v1/jobs/claim", { method: "POST", body: JSON.stringify({ limit: 8 }) });
    for (const job of jobs) {
      try {
        await this.sendTelegramJob(job);
        await this.api("/api/v1/jobs/result", { method: "POST", body: JSON.stringify({ jobId: job._id, ok: true }) });
      } catch (error) {
        await this.api("/api/v1/jobs/result", { method: "POST", body: JSON.stringify({ jobId: job._id, ok: false, error: error?.message || String(error) }) }).catch(() => {});
        this.logger.error?.("[NexControl] delivery failed", job._id, error);
      }
      await new Promise(r => setTimeout(r, 120));
    }
  }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    await this.heartbeat();
    this._heartbeatTimer = setInterval(() => this.heartbeat().catch(e => this.logger.warn?.("[NexControl] heartbeat", e?.message || e)), this.heartbeatMs);
    this._refreshTimer = setInterval(() => this.refreshKnownChats().catch(e => this.logger.warn?.("[NexControl] refresh", e?.message || e)), 15 * 60_000);
    const loop = async () => {
      while (!this.stopped) {
        try { await this.pollOnce(); } catch (e) { this.logger.warn?.("[NexControl] poll", e?.message || e); }
        await new Promise(r => setTimeout(r, this.pollMs));
      }
    };
    this._loopPromise = loop();
  }

  stop() {
    this.stopped = true;
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    if (this._refreshTimer) clearInterval(this._refreshTimer);
  }
}
