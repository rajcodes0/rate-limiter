import { Request, Response, NextFunction } from "express";
import { RateLimitConfig, ClientData } from "../types/types";

const LIMIT = 5;
const WINDOW = 10000; // 10 seconds

function isWindowExpired(windowStart: number, window: number): boolean {
  return Date.now() - windowStart >= window;
}

function createRateLimiter(config: RateLimitConfig) {
  const clients = new Map<string, ClientData>();

  return function dataforward(client: string) {
    const data = clients.get(client);
    if (!data) {
      clients.set(client, {
        count: 1,
        windowStart: Date.now(),
      });
      return;
    }

    if (isWindowExpired(data.windowStart, config.window)) {
      clients.set(client, {
        count: 1,
        windowStart: Date.now(),
      });
      return;
    }
    data.count++;
  };
}
