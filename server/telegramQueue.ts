/** Process-wide outgoing Telegram pacer. Keeps independent chat destinations
 * isolated, and prevents a burst of users from creating parallel HTTP sends. */
export class TelegramDispatchQueue {
  private tail: Promise<void> = Promise.resolve();
  private nextBotAt = new Map<string, number>();
  private nextChatAt = new Map<string, number>();
  private queued = 0;
  constructor(
    private readonly now = () => Date.now(),
    private readonly sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms)),
    private readonly botGapMs = 120,
    private readonly chatGapMs = 1100,
  ) {}
  schedule<T>(botId: string, chatId: string, dispatch: () => Promise<T>): Promise<T> {
    if (!botId || !chatId) return Promise.reject(new Error('Telegram destination missing'));
    this.queued++;
    const work = this.tail.catch(() => {}).then(async () => {
      const now = this.now();
      const botWait = Math.max(0, (this.nextBotAt.get(botId) ?? 0) - now);
      const chatKey = JSON.stringify([botId, chatId]);
      const chatWait = Math.max(0, (this.nextChatAt.get(chatKey) ?? 0) - now);
      const wait = Math.max(botWait, chatWait);
      if (wait > 0) await this.sleep(wait);
      const at = this.now();
      this.nextBotAt.set(botId, at + this.botGapMs);
      this.nextChatAt.set(chatKey, at + this.chatGapMs);
      // Prevent unbounded metadata growth on long-lived servers.
      if (this.nextChatAt.size > 6000) for (const [key, deadline] of this.nextChatAt) {
        if (deadline < at - this.chatGapMs) this.nextChatAt.delete(key);
      }
      return dispatch();
    });
    this.tail = work.then(() => {}, () => {});
    return work.finally(() => { this.queued--; });
  }
  stats() { return { queued: this.queued }; }
}
export const telegramDispatchQueue = new TelegramDispatchQueue();
