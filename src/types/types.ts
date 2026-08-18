 export type RateLimitConfig = {
    limit: number;
    window: number;
   
}

export type ClientData = {
     count: number;
    windowStart: number;
}

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
};



