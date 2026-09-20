// Public support chat endpoint, powered by Groq (OpenAI-compatible API).
// No auth required — visitors and customers alike should be able to ask
// basic questions without needing an account.

const SYSTEM_PROMPT = `You are the customer support assistant for Adyoolau, an independent ebook platform.

About Adyoolau:
- Sells and gives away ebooks (PDF and EPUB), readable in-browser or downloadable
- Checkout is handled via PayPal
- Free books can be claimed directly to a reader's library without payment
- Only readers who own a book can leave a review for it

Refund policy (summary): refunds are given for corrupted/broken files, accidental double charges, or wrong purchases reported within 48 hours and not yet opened. Refunds are NOT given for simply changing your mind, requests after 14 days, or dissatisfaction with the writing itself. Refund requests go to support@adyoolau.com.

Terms (summary): purchased books are a personal-use license — not resellable or shareable. Buyers keep their downloaded copies even if their account is later closed.

Contact: support@adyoolau.com

Keep answers short, friendly, and accurate to the information above. If you don't know something specific (like the status of an individual order), tell the person to email support@adyoolau.com with their purchase email and order reference rather than guessing. Never make up policies, prices, or order details you don't actually have.`;

const MAX_HISTORY_MESSAGES = 12;
const MAX_MESSAGE_LENGTH = 1000;

// POST /api/support/chat  { message, history: [{role, content}, ...] }
export const sendChatMessage = async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ message: "A message is required" });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ message: "Message is too long" });
    }
    if (!Array.isArray(history)) {
      return res.status(400).json({ message: "history must be an array" });
    }

    // Keep only the last N turns and only well-formed entries, so a
    // malicious or buggy client can't blow up the request size or inject
    // arbitrary roles.
    const trimmedHistory = history
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-MAX_HISTORY_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_LENGTH) }));

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...trimmedHistory,
      { role: "user", content: message.trim() },
    ];

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
        messages,
        temperature: 0.4,
        max_tokens: 400,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Groq API error:", response.status, text);
      return res.status(502).json({ message: "The support assistant is unavailable right now." });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content;

    if (!reply) {
      return res.status(502).json({ message: "The support assistant didn't return a response." });
    }

    res.json({ reply });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};