const STORAGE_KEY = 'd3s_random_listening_blacklist';

export const blacklistStorage = {
  getBlacklist(): Set<string> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Set(parsed);
      return new Set();
    } catch {
      return new Set();
    }
  },

  saveBlacklist(blacklist: Set<string>): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...blacklist]));
    } catch {
      // ignore
    }
  },

  addSentence(sentenceId: string): Set<string> {
    const blacklist = this.getBlacklist();
    blacklist.add(sentenceId);
    this.saveBlacklist(blacklist);
    return blacklist;
  },

  removeSentence(sentenceId: string): Set<string> {
    const blacklist = this.getBlacklist();
    blacklist.delete(sentenceId);
    this.saveBlacklist(blacklist);
    return blacklist;
  },

  isBlacklisted(sentenceId: string): boolean {
    return this.getBlacklist().has(sentenceId);
  },

  clearBlacklist(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  },
};
