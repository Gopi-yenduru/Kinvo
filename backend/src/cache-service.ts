interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class CacheService {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private readonly DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes

  /**
   * Get cached data if it exists and hasn't expired
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      console.log(`🔍 CACHE: Miss for key "${key}"`);
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      console.log(`⏰ CACHE: Expired for key "${key}"`);
      this.cache.delete(key);
      return null;
    }

    console.log(`✅ CACHE: Hit for key "${key}"`);
    return entry.data;
  }

  /**
   * Set cached data with optional TTL
   */
  set<T>(key: string, data: T, ttlMs: number = this.DEFAULT_TTL): void {
    const expiresAt = Date.now() + ttlMs;
    this.cache.set(key, { data, expiresAt });
    console.log(`💾 CACHE: Set for key "${key}" (expires in ${ttlMs}ms)`);
  }

  /**
   * Delete specific cache entry
   */
  delete(key: string): void {
    const deleted = this.cache.delete(key);
    if (deleted) {
      console.log(`🗑️ CACHE: Deleted key "${key}"`);
    }
  }

  /**
   * Invalidate multiple cache entries by pattern
   */
  invalidateByPattern(pattern: string): void {
    const keysToDelete: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach(key => {
      this.cache.delete(key);
      console.log(`🗑️ CACHE: Invalidated by pattern "${pattern}": "${key}"`);
    });
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    console.log(`🧹 CACHE: Cleared all ${size} entries`);
  }

  /**
   * Get cache statistics
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    };
  }

  /**
   * Clean up expired entries
   */
  cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach(key => this.cache.delete(key));
    if (keysToDelete.length > 0) {
      console.log(`🧹 CACHE: Cleaned up ${keysToDelete.length} expired entries`);
    }
  }
}

// Cache invalidation patterns for different operations
export const CACHE_PATTERNS = {
  SESSIONS: 'sessions',
  SESSION_COUNTS: 'session-counts',
  TRANSCRIPT: 'transcript',
  LOGS: 'logs',
  DASHBOARD_SUMMARY: 'dashboard-summary',
  SETTINGS: 'settings',
  RED_FLAGS: 'red-flags',
  CONVERSATION_LOGS: 'conversation-logs'
};

// Create singleton instance
const cacheService = new CacheService();

// Periodic cleanup of expired entries (every 5 minutes)
setInterval(() => {
  cacheService.cleanup();
}, 5 * 60 * 1000);

export default cacheService;