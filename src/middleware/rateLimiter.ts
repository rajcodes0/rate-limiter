import { Request, Response, NextFunction } from "express";

const LIMIT = 5;
const WINDOW = 10000; // 10 seconds

const requests = new Map<string, ClientData>();

type ClientData = {
  count: number;
  windowStart: number;
};

type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
};

function recordRequest(client: string): RateLimitResult {
  const data = requests.get(client);

  // First request from this client
  if (!data) {
    requests.set(client, {
      count: 1,
      windowStart: Date.now(),
    });

    console.log("Request allowed");

    return {
      allowed: true,
      remaining: LIMIT - 1,
      retryAfter: 0,
    };
  }

  // Calculate how much time has passed
  const elapsedTime = Date.now() - data.windowStart;

  // Window expired
  if (elapsedTime >= WINDOW) {
    data.count = 1;
    data.windowStart = Date.now();

    console.log("New window - Request allowed");

    return {
      allowed: true,
      remaining: LIMIT - 1,
      retryAfter: 0,
    };
  }

  // Limit reached
  if (data.count >= LIMIT) {
    console.log("Request limit exceeded");

    const retryAfter = Math.ceil(
      (WINDOW - elapsedTime) / 1000
    );

    return {
      allowed: false,
      remaining: 0,
      retryAfter,
    };
  }

  // Request allowed
  data.count++;

  return {
    allowed: true,
    remaining: LIMIT - data.count,
    retryAfter: 0,
  };
}

export function rateLimiter(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const client = req.ip ?? "unknown";

  const result = recordRequest(client);

  res.setHeader("X-RateLimit-Limit", LIMIT);
  res.setHeader("X-RateLimit-Remaining", result.remaining);

  if (!result.allowed) {
    res.setHeader("Retry-After", result.retryAfter);

    res.status(429).json({
      message: "Too many requests",
    });

    return;
  }

  next();
}