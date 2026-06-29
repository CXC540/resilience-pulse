/**
 * FORGED Resilience Lab — Daily Nudge Scheduler
 * Netlify Scheduled Function — runs daily at 05:00 UTC (07:00 WAT)
 *
 * Flow:
 *   1. Fetch Active Blueprint subscribers from Airtable
 *   2. Calculate current day (1–21) for each subscriber
 *   3. Identify weakest RCI dimension from subscriber scores
 *   4. Generate personalised nudge via Claude Haiku API
 *   5. Send via Meta Cloud API → WhatsApp
 *   6. Log delivery result to Airtable Nudge Log table
 */

export const config = {
  schedule: "0 5 * * *"
};

// ── Constants ────────────────────────────────────────────────────────────────

const AIRTABLE_BASE   = "app1W8ijaU1gfc9nX";
const SUBSCRIBERS_TBL = "tblCKeMaj5p5Lwl0m";
const NUDGE_LOG_TBL   = "tblwWnRJscLpOiYw2";
const PHONE_ID        = "1135778909625987";
const CLAUDE_MODEL    = "claude-haiku-4-5-20251001";

const RCI_FIELDS = {
  "Emotional Regulation": "fldIWvC9FfkOqUnX0",
  "Cognitive Flexibility": "fldHp33Q5BYyBDWVx",
  "Social Support":        "fldmaQV0O9sBR3ySc",
  "Purpose & Meaning":     "fldqG7We5RCLLHZwH",
  "Physical Vitality":     "fldQeEn6qpBc7j9lk",
  "Adaptive Coping":       "fldVNcap86YDzqb1q",
  "Identity Stability":    "fldaektBEVq36faGW",
};

const DIMENSION_CONTEXT = {
  "Emotional Regulation":  "managing emotional responses under pressure — staying grounded when feelings are intense",
  "Cognitive Flexibility": "shifting perspective and adapting thinking when circumstances change unexpectedly",
  "Social Support":        "drawing strength from relationships and being willing to ask for and receive help",
  "Purpose & Meaning":     "staying connected to the deeper why behind your work, especially in difficult seasons",
  "Physical Vitality":     "sustaining physical energy, sleep, and body care as a foundation for leadership",
  "Adaptive Coping":       "responding to setbacks with practical strategies rather than avoidance or rigidity",
  "Identity Stability":    "remaining grounded in who you are when roles, expectations, or environments shift",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function getEnv(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing environment variable: ${key}`);
  return val;
}

function daysBetween(startDateStr) {
  const start = new Date(startDateStr);
  const today = new Date();
  start.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return Math.floor((today - start) / (1000 * 60 * 60 * 24)) + 1;
}

function weakestDimension(fields) {
  let lowest = Infinity;
  let weakest = "Emotional Regulation";
  for (const [dim, fieldId] of Object.entries(RCI_FIELDS)) {
    const score = fields[fieldId] ?? fields[dim] ?? 3;
    if (score < lowest) { lowest = score; weakest = dim; }
  }
  return weakest;
}

function formatWhatsApp(number) {
  const digits = number.replace(/\D/g, "");
  return digits.startsWith("264") ? digits : `264${digits.replace(/^0/, "")}`;
}

// ── Airtable ─────────────────────────────────────────────────────────────────

async function fetchActiveSubscribers(apiKey) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${SUBSCRIBERS_TBL}` +
    `?filterByFormula={Status}="Active"&pageSize=100`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) throw new Error(`Airtable fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.records || [];
}

async function logNudge(apiKey, { subscriberId, name, day, dimension, message, status, error }) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${NUDGE_LOG_TBL}`;
  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        "Subscriber Name": name,
        "Day Number":      day,
        "Dimension":       dimension,
        "Message":         message,
        "Status":          status,
        "Error":           error || "",
        "Sent At":         new Date().toISOString(),
      }
    })
  });
}

async function updateSubscriberNudgeStatus(apiKey, recordId, status) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${SUBSCRIBERS_TBL}/${recordId}`;
  await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        "Last Nudge Date":   new Date().toISOString().split("T")[0],
        "Last Nudge Status": status,
      }
    })
  });
}

// ── Claude Nudge Generator ────────────────────────────────────────────────────

async function generateNudge(anthropicKey, { name, day, dimension, score }) {
  const context = DIMENSION_CONTEXT[dimension];
  const prompt = `You are FORGED, the AI coaching companion of the FORGED Resilience Lab by Change Experience Consulting, Namibia. Your voice is warm, direct, grounded, and faith-informed. You do not use hollow motivation or corporate language.

Write a personalised daily WhatsApp nudge for a leader named ${name}. Today is Day ${day} of their 21-day Resilience Blueprint.

Their current focus dimension is: ${dimension} (score: ${score}/5)
This dimension is about: ${context}

Requirements:
- Open with 🔥 and "*FORGED — Day ${day}*"
- One short paragraph (3–4 sentences) that speaks directly to ${name} about ${dimension}
- One reflection question in italics
- Close with a short action instruction (reply REFLECT or similar)
- Total length: 100–130 words
- No hashtags. No marketing language. Speak like a coach who knows them.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key":         anthropicKey,
      "anthropic-version": "2023-06-01",
      "Content-Type":      "application/json",
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: 300,
      messages:   [{ role: "user", content: prompt }],
    })
  });

  if (!res.ok) throw new Error(`Claude API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || "";
}

// ── WhatsApp Sender ───────────────────────────────────────────────────────────

async function sendWhatsApp(accessToken, to, message) {
  const url = `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message },
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `WhatsApp error ${res.status}`);
  return data.messages?.[0]?.id;
}

// ── Main Handler ──────────────────────────────────────────────────────────────

export default async function handler() {
  console.log(`[FORGED] Daily nudge run started — ${new Date().toISOString()}`);

  const AIRTABLE_KEY   = getEnv("AIRTABLE_API_KEY");
  const ANTHROPIC_KEY  = getEnv("ANTHROPIC_API_KEY");
  const META_TOKEN     = getEnv("META_ACCESS_TOKEN");

  let sent = 0, skipped = 0, failed = 0;

  try {
    const subscribers = await fetchActiveSubscribers(AIRTABLE_KEY);
    console.log(`[FORGED] Found ${subscribers.length} active subscriber(s)`);

    for (const record of subscribers) {
      const f       = record.fields;
      const name    = f["Full Name"] || "Leader";
      const number  = f["WhatsApp Number"] || "";
      const start   = f["Start Date"];

      if (!number || !start) {
        console.warn(`[FORGED] Skipping ${name} — missing number or start date`);
        skipped++;
        continue;
      }

      const day = daysBetween(start);
      if (day < 1 || day > 21) {
        console.log(`[FORGED] ${name} is on day ${day} — outside Blueprint window, skipping`);
        skipped++;
        continue;
      }

      const dimension = weakestDimension(f);
      const score     = f[RCI_FIELDS[dimension]] ?? f[dimension] ?? 3;
      const to        = formatWhatsApp(number);

      try {
        const message  = await generateNudge(ANTHROPIC_KEY, { name, day, dimension, score });
        const msgId    = await sendWhatsApp(META_TOKEN, to, message);

        await logNudge(AIRTABLE_KEY, { subscriberId: record.id, name, day, dimension, message, status: "Delivered" });
        await updateSubscriberNudgeStatus(AIRTABLE_KEY, record.id, "Delivered");

        console.log(`[FORGED] ✓ ${name} | Day ${day} | ${dimension} | MsgID: ${msgId}`);
        sent++;

      } catch (err) {
        console.error(`[FORGED] ✗ ${name} — ${err.message}`);
        await logNudge(AIRTABLE_KEY, { subscriberId: record.id, name, day, dimension, message: "", status: "Failed", error: err.message });
        await updateSubscriberNudgeStatus(AIRTABLE_KEY, record.id, "Failed");
        failed++;
      }

      // Pace requests — avoid Meta rate limiting
      await new Promise(r => setTimeout(r, 500));
    }

  } catch (err) {
    console.error(`[FORGED] Fatal error — ${err.message}`);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }

  const summary = `[FORGED] Run complete — Sent: ${sent} | Skipped: ${skipped} | Failed: ${failed}`;
  console.log(summary);
  return new Response(JSON.stringify({ sent, skipped, failed }), { status: 200 });
}
