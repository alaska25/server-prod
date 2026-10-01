// Thin wrapper around PayPal's REST API v2 (Orders API).
// PAYPAL_MODE must be exactly "live" or "sandbox" (the app refuses to start
// otherwise, so a typo can never silently send real customers to the sandbox).

const MODE = process.env.PAYPAL_MODE;
if (!["live", "sandbox"].includes(MODE)) {
  throw new Error('PAYPAL_MODE must be exactly "live" or "sandbox"');
}
console.log(`PayPal mode: ${MODE}`);

export const PAYPAL_CURRENCY = "USD";

const BASE = MODE === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
const TIMEOUT_MS = 10_000;

// Structured error: log `body` and `debugId`, but never send them to clients.
export class PaypalError extends Error {
  constructor(message, { status, body, debugId, timeout = false } = {}) {
    super(message);
    this.name = "PaypalError";
    this.status = status;
    this.body = body;
    this.debugId = debugId;
    this.timeout = timeout;
  }
  hasIssue(issue) {
    return Array.isArray(this.body?.details) && this.body.details.some((d) => d.issue === issue);
  }
}

const isTimeout = (err) => err?.name === "TimeoutError" || err?.name === "AbortError";

let cachedToken = null;
let cachedTokenExpiry = 0;
let tokenPromise = null;

const fetchToken = async () => {
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  let res;
  try {
    res = await fetch(`${BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new PaypalError("PayPal auth request failed", { timeout: isTimeout(err) });
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new PaypalError(`PayPal auth failed (${res.status})`, {
      status: res.status,
      body: data,
      debugId: res.headers.get("paypal-debug-id"),
    });
  }

  cachedToken = data.access_token;
  cachedTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
};

// Concurrent callers share one in-flight token request.
const getAccessToken = async (force = false) => {
  if (!force && cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;
  if (!tokenPromise) tokenPromise = fetchToken().finally(() => (tokenPromise = null));
  return tokenPromise;
};

const paypalFetch = async (path, { method = "GET", body, requestId } = {}, retried = false) => {
  const token = await getAccessToken(retried);

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // Makes retries safe: PayPal returns the original result for the same id.
        ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new PaypalError(`PayPal ${method} request failed`, { timeout: isTimeout(err) });
  }

  // Token revoked early: refresh once and retry.
  if (res.status === 401 && !retried) {
    return paypalFetch(path, { method, body, requestId }, true);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new PaypalError(`PayPal ${method} failed (${res.status})`, {
      status: res.status,
      body: data,
      debugId: res.headers.get("paypal-debug-id"),
    });
  }
  return data;
};

export const createPaypalOrder = async (totalAmount, referenceId) => {
  const data = await paypalFetch("/v2/checkout/orders", {
    method: "POST",
    requestId: `create-${referenceId}`,
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: referenceId,
          custom_id: referenceId,
          description: "Adyoolau digital purchase",
          amount: {
            currency_code: PAYPAL_CURRENCY,
            value: totalAmount.toFixed(2),
          },
        },
      ],
      // Digital goods: don't collect a shipping address.
      application_context: { shipping_preference: "NO_SHIPPING" },
    },
  });
  return data.id;
};

export const capturePaypalOrder = (paypalOrderId) =>
  paypalFetch(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
    method: "POST",
    requestId: `capture-${paypalOrderId}`,
  });

// Used to find out what really happened after a timeout or a duplicate capture.
export const getPaypalOrder = (paypalOrderId) =>
  paypalFetch(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`);