/**
 * FORGED — Day 20 Re-Assessment Trigger
 * Netlify Scheduled Function — runs daily at 05:00 UTC (07:00 WAT),
 * same time as forged-daily-nudge.mjs but handles a different concern.
 *
 * On Day 20 (the evening before completion), this function sends the
 * first re-assessment question and sets Conversation State so the
 * webhook (forged-whatsapp-webhook.mjs) knows to expect 7 sequential
 * numeric answers instead of a normal reply.
 *
 * This runs as a SEPARATE function from forged-daily-nudge.mjs rather
 * than being merged into it, because the two have different schedules
 * and failure domains — if the re-assessment trigger fails, the daily
 * nudge should still send, and vice versa.
 *
 * Deploy at: netlify/functions/forged-day20-reassess-trigger.mjs
 */

export const config = {
  schedule: "0 5 * * *"
};

const AIRTABLE_BASE   = "app1W8ijaU1gfc9nX";
const SUBSCRIBERS_TBL = "tblCKeMaj5p5Lwl0m";
const PHONE_ID         = "1135778909625987";

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

function formatWhatsApp(number) {
  const digits = number.replace(/\D/g, "");
  return digits.startsWith("264") ? digits : `264${digits.replace(/^0/, "")}`;
}

async function fetchActiveSubscribers(apiKey) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${SUBSCRIBERS_TBL}` +
    `?filterByFormula={Status}="Active"&pageSize=100`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Airtable fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.records || [];
}

async function setConversationState(apiKey, recordId, state) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${SUBSCRIBERS_TBL}/${recordId}`;
  await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { "Conversation State": state } })
  });
}

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

export default async function handler() {
  console.log(`[FORGED Day20] Re-assessment trigger run started — ${new Date().toISOString()}`);

  const AIRTABLE_KEY = getEnv("AIRTABLE_API_KEY");
  const META_TOKEN    = getEnv("META_ACCESS_TOKEN");

  let triggered = 0, skipped = 0, failed = 0;

  try {
    const subscribers = await fetchActiveSubscribers(AIRTABLE_KEY);

    for (const record of subscribers) {
      const f      = record.fields;
      const name   = f["Name"] || "Leader";
      const number = f["WhatsApp"] || "";
      const start  = f["Start Date"];

      if (!number || !start) { skipped++; continue; }

      const day = daysBetween(start);

      // Only fire on Day 20 — the evening before completion
      if (day !== 20) { skipped++; continue; }

      const to = formatWhatsApp(number);

      try {
        const message = `🔥 *FORGED — Tomorrow is Day 21*\n\nBefore your Launchpad closes, we ask the same 7 questions you answered on Day 1. Same scale, same dimensions — this is how we measure what changed.\n\nTakes about 2 minutes. Reply with just a number, 1 to 5, for each question.\n\n*Question 1 of 7 — Emotional Regulation*\n\nOn a scale of 1 to 5, how would you rate yourself today on managing emotional responses under pressure?\n\n1 = Low · 5 = Strong\n\nReply with just the number.`;

        await sendWhatsApp(META_TOKEN, to, message);
        await setConversationState(AIRTABLE_KEY, record.id, "Awaiting Reassessment Q1");

        console.log(`[FORGED Day20] ✓ Re-assessment started for ${name}`);
        triggered++;

      } catch (err) {
        console.error(`[FORGED Day20] ✗ ${name} — ${err.message}`);
        failed++;
      }

      await new Promise(r => setTimeout(r, 500));
    }

  } catch (err) {
    console.error(`[FORGED Day20] Fatal error — ${err.message}`);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }

  const summary = `[FORGED Day20] Run complete — Triggered: ${triggered} | Skipped: ${skipped} | Failed: ${failed}`;
  console.log(summary);
  return new Response(JSON.stringify({ triggered, skipped, failed }), { status: 200 });
}
