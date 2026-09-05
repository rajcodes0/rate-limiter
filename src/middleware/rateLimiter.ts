import type { NextFunction, Request, Response, RequestHandler } from "express";
import type { RateLimitConfig, RateLimitResult } from "../types/types.js";

type FixedWindowState = { windowId: number; count: number };
type SlidingLogState = { timestamps: number[] };
type SlidingCounterState = { windowId: number; current: number; previous: number };
type BucketState = { level: number; updatedAt: number };
type LimiterState = FixedWindowState | SlidingLogState | SlidingCounterState | BucketState;
const DEFAULT_WINDOW_MS = 60_000;

function positive(value: number | undefined, name: string, fallback?: number): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result === undefined || result <= 0) throw new Error(`${name} must be a positive number`);
  return result;
}

function decision(allowed: boolean, limit: number, remaining: number, resetAt: number, retryAfterMs = 0): RateLimitResult {
  return { allowed, limit, remaining: Math.max(0, Math.floor(remaining)), resetAt, retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)) };
}

/** In-memory limiter. Use a shared atomic store for multi-process deployments. */
export class RateLimiter {
  private readonly states = new Map<string, LimiterState>();
  private readonly windowMs: number;
  private readonly capacity: number;
  private readonly ratePerMs: number;

  constructor(private readonly config: RateLimitConfig) {
    positive(config.limit, "limit");
    this.windowMs = positive(config.windowMs, "windowMs", DEFAULT_WINDOW_MS);
    this.capacity = positive(config.capacity, "capacity", config.limit);
    this.ratePerMs = positive(config.ratePerSecond, "ratePerSecond", config.limit / (this.windowMs / 1_000)) / 1_000;
  }

  consume(key: string, now = Date.now()): RateLimitResult {
    switch (this.config.algorithm) {
      case "fixed-window": return this.fixedWindow(key, now);
      case "sliding-window-log": return this.slidingWindowLog(key, now);
      case "sliding-window-counter": return this.slidingWindowCounter(key, now);
      case "token-bucket": return this.tokenBucket(key, now);
      case "leaky-bucket": return this.leakyBucket(key, now);
    }
  }

  middleware(): RequestHandler {
    return (request: Request, response: Response, next: NextFunction) => {
      const key = this.config.keyGenerator?.(request) ?? request.ip ?? request.socket.remoteAddress ?? "anonymous";
      const rate = this.consume(key);
      response.set({ "RateLimit-Limit": String(rate.limit), "RateLimit-Remaining": String(rate.remaining), "RateLimit-Reset": String(Math.max(0, Math.ceil((rate.resetAt - Date.now()) / 1_000))) });
      if (!rate.allowed) {
        response.set("Retry-After", String(Math.max(1, Math.ceil(rate.retryAfterMs / 1_000))));
        response.status(429).json({ error: "Too many requests", retryAfterMs: rate.retryAfterMs });
        return;
      }
      next();
    };
  }

  private fixedWindow(key: string, now: number): RateLimitResult {
    const windowId = Math.floor(now / this.windowMs), resetAt = (windowId + 1) * this.windowMs;
    let state = this.states.get(key) as FixedWindowState | undefined;
    if (!state || state.windowId !== windowId) { state = { windowId, count: 0 }; this.states.set(key, state); }
    if (state.count >= this.config.limit) return decision(false, this.config.limit, 0, resetAt, resetAt - now);
    state.count += 1;
    return decision(true, this.config.limit, this.config.limit - state.count, resetAt);
  }

  private slidingWindowLog(key: string, now: number): RateLimitResult {
    let state = this.states.get(key) as SlidingLogState | undefined;
    if (!state) { state = { timestamps: [] }; this.states.set(key, state); }
    const cutoff = now - this.windowMs;
    while (state.timestamps.length && state.timestamps[0] <= cutoff) state.timestamps.shift();
    if (state.timestamps.length >= this.config.limit) {
      const resetAt = state.timestamps[0] + this.windowMs;
      return decision(false, this.config.limit, 0, resetAt, resetAt - now);
    }
    state.timestamps.push(now);
    return decision(true, this.config.limit, this.config.limit - state.timestamps.length, now + this.windowMs);
  }

  private slidingWindowCounter(key: string, now: number): RateLimitResult {
    const windowId = Math.floor(now / this.windowMs), elapsed = now - windowId * this.windowMs, resetAt = (windowId + 1) * this.windowMs;
    let state = this.states.get(key) as SlidingCounterState | undefined;
    if (!state || state.windowId !== windowId) {
      state = { windowId, current: 0, previous: state?.windowId === windowId - 1 ? state.current : 0 };
      this.states.set(key, state);
    }
    const estimated = state.current + state.previous * (1 - elapsed / this.windowMs);
    if (estimated + 1 > this.config.limit) {
      const retry = state.previous ? Math.ceil(this.windowMs * (1 - (this.config.limit - state.current) / state.previous)) - elapsed : resetAt - now;
      return decision(false, this.config.limit, 0, resetAt, Math.max(1, retry));
    }
    state.current += 1;
    return decision(true, this.config.limit, this.config.limit - estimated - 1, resetAt);
  }

  private tokenBucket(key: string, now: number): RateLimitResult {
    let state = this.states.get(key) as BucketState | undefined;
    if (!state) { state = { level: this.capacity, updatedAt: now }; this.states.set(key, state); }
    state.level = Math.min(this.capacity, state.level + (now - state.updatedAt) * this.ratePerMs);
    state.updatedAt = now;
    if (state.level < 1) { const retry = (1 - state.level) / this.ratePerMs; return decision(false, this.capacity, 0, now + retry, retry); }
    state.level -= 1;
    return decision(true, this.capacity, state.level, now + (this.capacity - state.level) / this.ratePerMs);
  }

  private leakyBucket(key: string, now: number): RateLimitResult {
    let state = this.states.get(key) as BucketState | undefined;
    if (!state) { state = { level: 0, updatedAt: now }; this.states.set(key, state); }
    state.level = Math.max(0, state.level - (now - state.updatedAt) * this.ratePerMs);
    state.updatedAt = now;
    if (state.level + 1 > this.capacity) { const retry = (state.level + 1 - this.capacity) / this.ratePerMs; return decision(false, this.capacity, 0, now + retry, retry); }
    state.level += 1;
    return decision(true, this.capacity, this.capacity - state.level, now + state.level / this.ratePerMs);
  }
}

export function createRateLimiter(config: RateLimitConfig): RequestHandler { return new RateLimiter(config).middleware(); }
export const fixedWindow = (config: Omit<RateLimitConfig, "algorithm">) => createRateLimiter({ ...config, algorithm: "fixed-window" });
export const slidingWindowLog = (config: Omit<RateLimitConfig, "algorithm">) => createRateLimiter({ ...config, algorithm: "sliding-window-log" });
export const slidingWindowCounter = (config: Omit<RateLimitConfig, "algorithm">) => createRateLimiter({ ...config, algorithm: "sliding-window-counter" });
export const tokenBucket = (config: Omit<RateLimitConfig, "algorithm">) => createRateLimiter({ ...config, algorithm: "token-bucket" });
export const leakyBucket = (config: Omit<RateLimitConfig, "algorithm">) => createRateLimiter({ ...config, algorithm: "leaky-bucket" });
