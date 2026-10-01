import nodemailer from "nodemailer";

// Email providers, in order of preference (the first one configured wins):
//
//   1. Resend  - set RESEND_API_KEY   (HTTPS API, works on any hosting plan)
//   2. Brevo   - set BREVO_API_KEY    (HTTPS API, works on any hosting plan)
//   3. SMTP    - set SMTP_HOST, SMTP_USER, SMTP_PASS (+ SMTP_PORT)
//
// Also set EMAIL_FROM, e.g.  Adyoolau <no-reply@yourdomain.com>
// (required for Resend/Brevo; the address must be verified with the provider).
//
// WHY NOT JUST SMTP: free Render web services block outbound SMTP ports
// 25, 465 and 587, so SMTP only works there on a paid instance. The HTTPS APIs
// use port 443, which is never blocked.

const isProd = process.env.NODE_ENV === "production";
const TIMEOUT_MS = Number(process.env.EMAIL_TIMEOUT_MS) || 10_000;

const smtpConfigured = Boolean(
  process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
);

export const emailProvider = process.env.RESEND_API_KEY
  ? "resend"
  : process.env.BREVO_API_KEY
  ? "brevo"
  : smtpConfigured
  ? "smtp"
  : null;

const FROM = process.env.EMAIL_FROM || (emailProvider === "smtp" ? process.env.SMTP_USER : "") || "";

// null when everything needed is set; otherwise a message that says what's missing.
// server.js stops the app on this in production.
export const emailConfigError = !emailProvider
  ? "No email provider configured (set RESEND_API_KEY, BREVO_API_KEY, or SMTP_HOST/SMTP_USER/SMTP_PASS)"
  : !FROM
  ? "EMAIL_FROM is required"
  : null;

console.log(`Email provider: ${emailProvider || "none (emails are only printed in development)"}`);

// ---- SMTP transport (fallback) --------------------------------------------
const smtpPort = Number(process.env.SMTP_PORT) || 587;
const smtpSecure = smtpPort === 465;

const transporter =
  emailProvider === "smtp"
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: smtpPort,
        secure: smtpSecure,
        // On the STARTTLS port, refuse to send if the server can't upgrade to TLS
        // (otherwise credentials could go over a downgraded connection).
        // Not enforced outside production so local test mail servers still work.
        requireTLS: isProd && !smtpSecure,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
        // nodemailer's defaults wait up to 2 minutes to connect and 10 minutes on
        // an idle socket, which would hang the request that is sending the email.
        connectionTimeout: TIMEOUT_MS,
        greetingTimeout: TIMEOUT_MS,
        socketTimeout: TIMEOUT_MS * 2,
        // Some hosts don't reliably support IPv6, and Node sometimes resolves SMTP
        // hosts (e.g. Gmail) to an IPv6 address first, causing ENETUNREACH.
        // Forcing IPv4 avoids that.
        family: 4,
      })
    : null;

// In production, check the SMTP login once at startup and log the result
// (failures are otherwise invisible: the reset endpoint hides them on purpose).
if (transporter && isProd) {
  transporter
    .verify()
    .then(() => console.log("SMTP connection verified"))
    .catch((err) => console.error("SMTP check failed:", err.message));
}

// ---- Helpers --------------------------------------------------------------

// Plain-text version for mail clients and spam filters (HTML-only mail scores worse).
const htmlToText = (html) =>
  String(html)
    .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
      const l = label.replace(/<[^>]+>/g, "").trim();
      return !l || l === href ? href : `${l}: ${href}`;
    })
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// "Adyoolau <no-reply@example.com>"  ->  { name: "Adyoolau", email: "no-reply@example.com" }
const parseSender = (from) => {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from);
  return m ? { name: m[1].trim() || undefined, email: m[2].trim() } : { email: from.trim() };
};

// POST JSON to a provider API. Errors carry the status and a short piece of the
// provider's answer (never the API key), and are only ever logged server-side.
const postJson = async (label, url, headers, body) => {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`${label} request failed: ${err.message}`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`${label} API error ${res.status}: ${detail}`);
  }
};

// ---- Public API -----------------------------------------------------------

// Sends one email. Throws if it can't be sent: callers decide how to react.
// (In development without any provider, the email is printed instead.)
export default async function sendEmail({ to, subject, html, text }) {
  const plain = text || htmlToText(html);

  if (!emailProvider) {
    // Never print emails in production: reset links are as good as passwords.
    if (isProd) throw new Error("Email is not configured");
    console.log("\n[sendEmail] no email provider configured — printing email instead:");
    console.log(`  To: ${to}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Body:\n${plain}\n`);
    return;
  }
  if (emailConfigError) throw new Error(emailConfigError);

  if (emailProvider === "resend") {
    return postJson(
      "Resend",
      "https://api.resend.com/emails",
      { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      { from: FROM, to: [to], subject, html, text: plain }
    );
  }

  if (emailProvider === "brevo") {
    return postJson(
      "Brevo",
      "https://api.brevo.com/v3/smtp/email",
      { "api-key": process.env.BREVO_API_KEY, accept: "application/json" },
      { sender: parseSender(FROM), to: [{ email: to }], subject, htmlContent: html, textContent: plain }
    );
  }

  await transporter.sendMail({ from: FROM, to, subject, html, text: plain });
}