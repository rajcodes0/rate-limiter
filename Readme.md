# Rate Limiter Lab

A small TypeScript + Express project that implements five rate-limiting algorithms and a React dashboard that lets you watch them accept and reject real HTTP requests.

Think of a rate limiter as a bouncer at a door. Every visitor (a client/IP/key) gets a rule: “you may enter this many times this quickly.” The bouncer remembers only the information needed for that rule.

> **Add your dashboard image here:** save your screenshot as `assets/dashboard.png`, then this image will render.

![Rate limiter dashboard screenshot](./assets/dashboard.png)

## What is included?

| Part | Job |
| --- | --- |
| Express API | Applies a default rate-limit rule to normal HTTP requests. |
| `RateLimiter` class | Contains all five algorithms and returns one consistent decision shape. |
| React dashboard | Sends genuine requests to the API and visualises allowed/rejected results. |
| Demo API | Lets the dashboard choose an algorithm and parameters safely. |
| Docker Compose | Runs the API, dashboard, and a Redis container together. |

## Run it

Prerequisite: Node.js 22+ and npm.

```bash
npm install
npm --prefix frontend install
npm run dev:api
```

In another terminal:

```bash
npm run dev:dashboard
```

Open `http://localhost:5173`. Vite forwards `/api` calls to the Express app on port `3000`.

To check production builds:

```bash
npm run build
npm run build:dashboard
```

To run the complete container stack:

```bash
docker compose up --build
```

Open `http://localhost:8080`. Nginx serves the built dashboard and proxies its `/api` calls to the API container.

## Project map

```text
src/
  index.ts                    Express server, global rule, dashboard demo route
  middleware/rateLimiter.ts   Algorithms, state, decisions, Express middleware
  types/types.ts              Shared TypeScript contracts
frontend/
  src/main.tsx                React controls and request timeline
  src/styles.css              Dashboard appearance
  vite.config.ts              Development proxy to the API
Dockerfile                    Production API image
frontend/Dockerfile           Static dashboard image served by Nginx
docker-compose.yml            API + dashboard + Redis services
```

## The idea before the code

For every request, the project does this:

```text
browser -> POST /api/demo/consume -> pick matching limiter -> consume(client key)
        -> allowed? return 200        -> rejected? return 429 + Retry-After
        -> dashboard adds the response to its timeline
```

The key is normally an IP address for the global middleware. The dashboard sends a browser-generated `clientId`, so changing a dashboard setting does not mix its history with another browser.

Every algorithm returns the same `RateLimitResult`:

```ts
{
  allowed: boolean,      // Can this request go through now?
  limit: number,         // The rule's limit/capacity
  remaining: number,     // How much room is left
  resetAt: number,       // Unix time in milliseconds for reset/refill information
  retryAfterMs: number   // How long a rejected caller should wait
}
```

That common result is why the Express middleware and React dashboard work with every algorithm without special cases.

## Algorithm guide

### 1. Fixed window

Imagine a teacher gives every student five stickers at exactly 10:00, 10:10, 10:20, and so on. A student may use only five stickers in one block.

State per client: `{ windowId, count }`.

1. Divide the current timestamp by `windowMs`, and round down. That gives `windowId`.
2. If this is a new window, make the count zero.
3. If `count >= limit`, reject the request.
4. Otherwise increase `count` and allow it.

**Good:** very cheap: one number per client.

**Trade-off:** a client can use the whole limit at the end of one window and the whole limit at the start of the next one. This is the “boundary burst” problem.

### 2. Sliding window log

Imagine keeping a list of the exact time of each sticker used. Before deciding, erase every entry older than the last `windowMs` milliseconds.

State per client: `{ timestamps: number[] }`.

1. Calculate `cutoff = now - windowMs`.
2. Remove timestamps at or before the cutoff.
3. If the list already has `limit` timestamps, reject.
4. Otherwise add `now` and allow.

**Good:** precise; no boundary burst.

**Trade-off:** a busy client needs one stored timestamp for every accepted request. In production, this is commonly a Redis sorted set with a TTL.

### 3. Sliding window counter

This is the small-notebook version of a sliding log. Instead of remembering every timestamp, it remembers only the count in the current window and the count in the previous one.

State per client: `{ windowId, current, previous }`.

1. Find the current fixed `windowId` and how far through it we are (`elapsed`).
2. On a window change, move the old `current` count into `previous` and start `current` at zero.
3. Estimate activity with:

   ```text
   estimated = current + previous × (1 - elapsed/windowMs)
   ```

4. Reject when `estimated + 1` is greater than the limit; otherwise increment `current`.

The older window matters less and less as time passes. At the beginning of a new window it matters almost fully; at the end it matters almost not at all.

**Good:** close to a real sliding window while using constant memory.

**Trade-off:** it is an estimate, not an exact request log.

### 4. Token bucket

Imagine a bucket that starts full of tokens. A request must spend one token. Water-like refills put tokens back at a steady speed, up to the bucket’s maximum size.

State per client: `{ level, updatedAt }`, where `level` means **tokens available**.

1. Add `elapsed time × ratePerMs` tokens.
2. Never exceed `capacity` (`Math.min`).
3. If fewer than one token exists, reject and calculate time until one appears.
4. Otherwise subtract one token and allow.

**Good:** supports a short burst up to bucket capacity, then settles to an average rate. It is often a good API choice.

**Trade-off:** burstiness is intentional, so do not choose it if requests must be smoothed perfectly.

### 5. Leaky bucket

Imagine a bucket with a tiny hole. Requests pour water in; water leaks out at a fixed speed. If the bucket would overflow, the new request is rejected.

State per client: `{ level, updatedAt }`, where `level` means **queued work waiting to leak out**.

1. Remove `elapsed time × ratePerMs` from the level, never below zero (`Math.max`).
2. If adding one request would exceed `capacity`, reject.
3. Otherwise add one and allow.

**Good:** smooths bursts and limits queued work.

**Trade-off:** this implementation makes an admission decision; it does not create a real background job queue. If work must actually be processed evenly, pair it with a queue and worker.

## Code walkthrough

### `src/types/types.ts`

- `RateLimitAlgorithm` is a union of the five permitted strings. TypeScript catches spelling mistakes before the program runs.
- `RateLimitConfig` describes the rule. `limit` is required; a window, capacity, rate, and custom key function are optional because not every algorithm needs each one.
- `keyGenerator` receives Express’s `Request` and returns a client key. Use it for an authenticated user ID, API key, tenant ID, or a combination—not only an IP address.
- `RateLimitResult` is the answer created by every algorithm.

### `src/middleware/rateLimiter.ts`

At the top, each `type ...State` declares exactly what one algorithm remembers. `LimiterState` combines them so one `Map` can hold any of them. `DEFAULT_WINDOW_MS` is one minute.

`positive()` is the safety gate. It accepts a value or fallback, then throws if it is missing, not finite, zero, or negative. This prevents nonsense rules such as “-5 requests per minute.”

`decision()` makes a consistent result. `Math.floor(remaining)` prevents showing fractional requests, and `Math.ceil(retryAfterMs)` prevents telling the caller to retry too early.

`RateLimiter` owns:

- `states`: a `Map` from client key to that client’s private algorithm state;
- `windowMs`, `capacity`, and `ratePerMs`: validated, pre-calculated configuration;
- `config`: the original rule, stored by the constructor.

The constructor converts `ratePerSecond` into `ratePerMs` once. That matters because JavaScript timestamps are milliseconds; doing the conversion once keeps all algorithms simple.

`consume(key, now = Date.now())` is the one public decision method. Its `switch` chooses the requested algorithm. Passing `now` is useful in tests because a test can control time without waiting in real life.

`middleware()` turns the class into Express middleware:

1. Choose a key: a custom key, then `request.ip`, then the socket address, then `anonymous` as a final fallback.
2. Call `consume`.
3. Set `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` response headers.
4. On rejection, add `Retry-After`, send HTTP `429`, and stop the request.
5. On approval, call `next()` so Express continues to the route.

The five private methods below it are the direct implementations explained in the algorithm guide. The exported factory functions at the bottom (`fixedWindow`, `tokenBucket`, and so on) are convenience wrappers: they fill in `algorithm` for you and return normal Express middleware.

### `src/index.ts`

- Imports load Express, the limiter, and type-only contracts. Type-only imports disappear from JavaScript output.
- `app` creates the Express server. `PORT` takes an environment value or defaults to `3000`.
- `supportedAlgorithms` is the allow-list. `configuredAlgorithm` is checked against it, so an invalid environment value safely falls back to `token-bucket`.
- The four `RATE_LIMIT_*` values configure the global API rule. The rate defaults to “fill `limit` requests over one window.”
- `demoLimiters` is a map of dashboard configurations to limiter instances. Identical settings share their own history; different settings get isolated history.
- `express.json()` parses the dashboard’s JSON body.
- The next middleware adds narrowly scoped CORS headers for the development dashboard. It answers browser preflight `OPTIONS` requests with `204`.
- `app.use(createRateLimiter(...))` installs the real global API protection before routes.
- `POST /api/demo/consume` validates dashboard input, creates/fetches the correct limiter, calls `consume`, and responds with `200` or `429` plus the decision. The `clientId` is capped at 128 characters to avoid unbounded oversized keys.
- `GET /` is a simple health response. `app.listen` starts the server.

### `frontend/src/main.tsx`

`App` is the entire dashboard component.

- `useState` stores selected settings, the request event list, and whether a request is currently in flight.
- `useMemo(() => crypto.randomUUID(), [])` makes one stable client ID per browser page. The empty dependency list means it is made once, not on every redraw.
- `send(count)` loops `count` times, POSTs the current settings, parses each server decision, and keeps the newest 40 events. A burst is ten real sequential requests, not a fake animation.
- `allowed`, `denied`, and the latest `remaining` value drive the statistics cards.
- `bucketAlgorithm` decides whether capacity/refill controls should appear. `meterSize` uses capacity for buckets and limit for windows.
- The JSX after `return` draws the selector, parameter inputs, request buttons, stats, capacity circles, and request timeline. A green ✓ is an allowed response; a red × is a genuine `429` response.
- `createRoot(...).render(<App />)` puts React into the `<div id="root">` in `frontend/index.html`.

### Frontend support files

- `styles.css` contains only presentation: layout, mobile breakpoint, colours, meter circles, and allowed/rejected styles.
- `vite.config.ts` sends development `/api` requests to `http://localhost:3000`; this avoids hard-coding a different URL in the React component.
- `frontend/package.json` lists the React/Vite build tools. `npm run dev` starts Vite and `npm run build` makes static files in `frontend/dist`.

## API examples

Use the dashboard, or call its endpoint directly:

```bash
curl -i -X POST http://localhost:3000/api/demo/consume \
  -H 'Content-Type: application/json' \
  -d '{
    "algorithm": "token-bucket",
    "limit": 5,
    "capacity": 5,
    "windowMs": 10000,
    "ratePerSecond": 1,
    "clientId": "alice"
  }'
```

An allowed response is `200`; a blocked response is `429` and includes `retryAfterMs`.

Global API environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Express port. |
| `RATE_LIMIT_ALGORITHM` | `token-bucket` | One of the five algorithm names. |
| `RATE_LIMIT_LIMIT` | `100` | Requests/window or default capacity. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window duration in milliseconds. |
| `RATE_LIMIT_RATE_PER_SECOND` | derived | Refill/leak speed. |
| `DASHBOARD_ORIGIN` | `http://localhost:5173` | Browser origin allowed by CORS. |

## Docker and Redis, explained simply

`Dockerfile` builds TypeScript in a first Node image, then copies only the compiled `dist` files into a smaller runtime image. `frontend/Dockerfile` builds Vite’s static site and serves it through Nginx.

`docker-compose.yml` creates three services:

- `api`: the Express service;
- `dashboard`: Nginx plus the React build, exposed as port `8080`;
- `redis`: Redis 7 with a named volume and a health check.

Nginx forwards `/api/` to the service named `api`, so browser requests remain same-origin in Docker.

**Important truth:** Redis is provisioned, but this version does **not** yet store rate-limit state in Redis. `RateLimiter.states` is an in-memory `Map`. With two API containers, each would count independently, which is wrong for a global limit. The comments in Compose intentionally say this rather than pretending Redis is already used.

To make Redis production-ready, implement each decision as one atomic Lua script (or a carefully designed Redis transaction): read state, remove/refill expired state, decide, write state, and set an expiry in one server-side operation. Do not do separate `GET` then `SET` commands, because two simultaneous requests can both be allowed incorrectly.

## What you can improve next

1. **Redis-backed atomic state:** Use key expiry; use sorted sets for sliding logs; use Lua scripts for atomic token/leaky counters.
2. **Memory cleanup:** The in-memory map currently keeps old client keys. Add a TTL sweep or maximum-key policy for development use.
3. **Separate demo and production rules:** The dashboard endpoint passes through the global limiter first. Exempt `/api/demo/consume` or mount the global rule only on real product routes if it interferes with demonstrations.
4. **Authentication-aware keys:** Limit by API key/user/tenant instead of IP. IPs can be shared behind NAT and proxies.
5. **Proxy configuration:** Only set Express `trust proxy` when you know which reverse proxy sits in front of the service. Otherwise forwarded IP headers can be spoofed.
6. **Tests:** Add unit tests with controlled timestamps for every boundary, plus integration tests that assert headers and `429` bodies.
7. **Observability:** Record allowed/blocked counts, latency, active keys, and limiter errors. Alert on unexpected spikes.
8. **Policy configuration:** Use route-specific rules, authenticated plans, and a trusted configuration store instead of accepting user-controlled demo parameters on public production endpoints.
9. **Queueing:** For real leaky-bucket work smoothing, put accepted jobs into a durable queue and process at a fixed worker rate.

## Interview questions to practise

1. Why is fixed window vulnerable at a time boundary, and which algorithm fixes it?
2. Why does a sliding-window log consume more memory than a sliding-window counter?
3. Why is the counter an estimate? Show an example where it differs from an exact log.
4. When is token bucket better than leaky bucket?
5. What does `capacity` mean in token bucket versus leaky bucket?
6. Why should a rate limiter return `429` and `Retry-After`?
7. Why is a local `Map` wrong when an API has multiple replicas?
8. Why must Redis updates be atomic? Describe the race in `GET`, decide, then `SET`.
9. Which key would you choose: IP, user, API key, route, tenant, or a composite? Why?
10. How would you prevent a malicious caller from creating millions of unique keys?
11. How would you test “one request exactly at the window edge” without using `setTimeout`?
12. How would you handle Redis being down: fail open, fail closed, or use a local fallback?

## A short interview answer

“I built a TypeScript Express rate-limiter lab with fixed-window, sliding-log, sliding-counter, token-bucket, and leaky-bucket strategies behind one middleware interface. Each request receives standard rate-limit headers and `429` with retry information when rejected. I added a React dashboard that sends real configurable requests so the behaviour is observable, plus Docker Compose for API, static frontend, and Redis. The current prototype deliberately keeps state in memory; my production next step is atomic Redis Lua scripts with TTLs, metrics, tests, and per-user policy keys.”
