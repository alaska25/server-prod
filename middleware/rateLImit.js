import rateLimit from "express-rate-limit";

// One place to build limiters so every route uses the same settings.
// Both `limit` (express-rate-limit v7+) and `max` (older versions) are set,
// so this works on either. Note: the default store is per-process memory.
// If you run more than one instance, use a shared store (e.g. Redis).
export const makeLimiter = (
  windowMinutes,
  limit,
  message = "Too many requests. Please try again later.",
  extra = {}
) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    max: limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message },
    ...extra,
  });hello
  