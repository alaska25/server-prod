import nodemailer from "nodemailer";

const smtpConfigured =
  process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS;

const transporter = smtpConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    })
  : null;

// If SMTP isn't configured (e.g. local dev without credentials set up yet),
// log the email instead of throwing, so the rest of the flow still works
// and the reset link is visible right in the server console.
export default async function sendEmail({ to, subject, html }) {
  if (!transporter) {
    console.log("\n[sendEmail] SMTP not configured — logging email instead:");
    console.log(`  To: ${to}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Body:\n${html}\n`);
    return;
  }

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    html,
  });
}