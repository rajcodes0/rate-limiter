import type { Request } from "express";

export type RateLimitAlgorithm = "fixed-window" | "sliding-window-log" | "sliding-window-counter" | "token-bucket" | "leaky-bucket";

export type RateLimitConfig = {
  algorithm: RateLimitAlgorithm;
  limit: number;
  windowMs?: number;
  capacity?: number;
  ratePerSecond?: number;
  keyGenerator?: (request: Request) => string;
};

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterMs: number;
};


