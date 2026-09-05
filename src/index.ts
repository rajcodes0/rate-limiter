import express, { Request, Response } from 'express';
import { createRateLimiter, RateLimiter } from './middleware/rateLimiter.js';
import type { RateLimitAlgorithm, RateLimitConfig } from './types/types.js';


const app = express();
const PORT = process.env.PORT || 3000;
const supportedAlgorithms: RateLimitAlgorithm[] = ['fixed-window', 'sliding-window-log', 'sliding-window-counter', 'token-bucket', 'leaky-bucket'];
const configuredAlgorithm = process.env.RATE_LIMIT_ALGORITHM as RateLimitAlgorithm | undefined;
const algorithm = configuredAlgorithm && supportedAlgorithms.includes(configuredAlgorithm) ? configuredAlgorithm : 'token-bucket';
const limit = Number(process.env.RATE_LIMIT_LIMIT ?? 100);
const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const ratePerSecond = Number(process.env.RATE_LIMIT_RATE_PER_SECOND ?? limit / (windowMs / 1_000));
const demoLimiters = new Map<string, RateLimiter>();

app.use(express.json());
// The dashboard is served separately in development, so allow only its local origin.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', process.env.DASHBOARD_ORIGIN ?? 'http://localhost:5173');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(createRateLimiter({ algorithm, limit, windowMs, ratePerSecond }));

// This isolated endpoint lets the dashboard exercise every algorithm with its
// selected settings. Application routes should instead use a fixed server rule.
app.post('/api/demo/consume', (req: Request, res: Response) => {
  const input = req.body as Partial<RateLimitConfig> & { clientId?: string };
  if (!supportedAlgorithms.includes(input.algorithm as RateLimitAlgorithm)) {
    res.status(400).json({ error: 'Unsupported rate-limit algorithm' });
    return;
  }
  const selectedLimit = Number(input.limit);
  const selectedWindow = Number(input.windowMs ?? 60_000);
  const selectedCapacity = Number(input.capacity ?? selectedLimit);
  const selectedRate = Number(input.ratePerSecond ?? selectedLimit / (selectedWindow / 1_000));
  if (![selectedLimit, selectedWindow, selectedCapacity, selectedRate].every(Number.isFinite) ||
      [selectedLimit, selectedWindow, selectedCapacity, selectedRate].some((value) => value <= 0) || selectedLimit > 10_000) {
    res.status(400).json({ error: 'Parameters must be positive numbers; limit may not exceed 10,000' });
    return;
  }
  const config: RateLimitConfig = {
    algorithm: input.algorithm as RateLimitAlgorithm,
    limit: selectedLimit,
    windowMs: selectedWindow,
    capacity: selectedCapacity,
    ratePerSecond: selectedRate,
  };
  const signature = JSON.stringify(config);
  let limiter = demoLimiters.get(signature);
  if (!limiter) {
    limiter = new RateLimiter(config);
    demoLimiters.set(signature, limiter);
  }
  const clientId = String(input.clientId ?? req.ip).slice(0, 128);
  const result = limiter.consume(clientId);
  res.status(result.allowed ? 200 : 429).json({ ...result, algorithm: config.algorithm, timestamp: Date.now() });
});
app.get('/', (req: Request, res: Response) => {
  res.json({ message: 'TypeScript backend is running successfully!' });
});

app.listen(PORT, () => {
  console.log(`Server is safely listening on http://localhost:${PORT}`);
});
