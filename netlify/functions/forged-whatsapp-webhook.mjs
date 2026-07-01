/**
 * FORGED — WhatsApp Inbound Webhook
 * Netlify Function (HTTP endpoint, not scheduled)
 *
 * This is the single front door for every inbound WhatsApp message
 * from subscribers. Meta's Cloud API only supports one webhook URL
 * per phone number, so all reply-handling logic routes through here
 * based on each subscriber's "Conversation State" field.
 *
 * Handles:
 *   1. Meta webhook verification (GET request, one-time setup)
 *   2. Inbound message routing (POST request, every reply)
 *      - REFLECT replies → logged to Journal Entries, counters incremented
 *      - Day 21 re-assessment answers → collected one question at a time
 *      - LAB replies → flagged for Coach Orange follow-up (logged, not auto-responded)
 *      - Anything else → counted as engagement, no further action
 *
 * Deploy at: netlify/functions/forged-whatsapp-webhook.mjs
 * Configure this URL in Meta App Dashboard → WhatsApp → Configuration
 * → Webhook → Callback URL, with the same WHATSAPP_VERIFY_TOKEN
 * already set in Netlify environment variables.
 */

const AIRTABLE_BASE    = "app1W8ijaU1gfc9nX";
const SUBSCRIBERS_TBL  = "tblCKeMaj5p5Lwl0m";

// TODO: replace with real table IDs after creating these tables —
// see SCHEMA-airtable-additions.txt sections 2 and 3
const JOURNAL_TBL      = "tblJournalEntriesPLACEHOLDER";
const REASSESS_TBL     = "tblReassessInProgressPLACEHOLDER";

const PHONE_ID         = "1135778909625987";

// Order matches the Day 1 baseline survey order — re-assessment
// asks the same 7 questions in the same sequence for consistency.
const REASSESS_QUESTION_ORDER = [
  "Emotional Regulation",
  "Cognitive Flexibility",
  "Social Support",
  "Purpose & Meaning",
  "Physical Vitality",
  "Adaptive Coping",
  "Identity Stability",
];

const DAY21_FIELD_MAP = {
  "Emotional Regulation":  "Day 21 — Emotional Regulation",
  "Cognitive Flexibility": "Day 21 — Cognitive Flexibility",
  "Social Support":        "Day 21 — Social Support",
  "Purpose & Meaning":     "Day 21 — Purpose & Meaning",
  "Physical Vitality":     "Day 21 — Physical Vitality",
  "Adaptive Coping":       "Day 21 — Adaptive Coping",
  "Identity Stability":    "Day 21 — Identity Stability",
};

function getEnv(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing environment variable: ${key}`);
  return val;
}

// ── Airtable helpers ──────────────────────────────────────────────

async function findSubscriberByPhone(apiKey, fromNumber) {
  // Normalise — Meta sends numbers without "+", Airtable may store with or without
  const digits = fromNumber.replace(/\D/g, "");
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${SUBSCRIBERS_TBL}` +
    `?filterByFormula=FIND("${digits.slice(-9)}", {WhatsApp})&maxRecords=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Airtable lookup failed: ${res.status}`);
  const data = await res.json();
  return data.records?.[0] || null;
}

async function updateSubscriberFields(apiKey, recordId, fields) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${SUBSCRIBERS_TBL}/${recordId}`;
  await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields })
  });
}

async function incrementField(apiKey, recordId, fieldName, currentValue) {
  await updateSubscriberFields(apiKey, recordId, {
    [fieldName]: (currentValue || 0) + 1
  });
}

async function logJournalEntry(apiKey, { subscriberRecordId, day, dimension, text }) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${JOURNAL_TBL}`;
  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        "Subscriber":      [subscriberRecordId],
        "Day Number":      day,
        "Dimension":       dimension,
        "Reflection Text": text,
        "Logged At":       new Date().toISOString(),
      }
    })
  });
}

async function saveReassessAnswer(apiKey, { subscriberRecordId, questionNumber, answer }) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${REASSESS_TBL}`;
  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        "Subscriber":      [subscriberRecordId],
        "Question Number": questionNumber,
        "Answer":          answer,
      }
    })
  });
}

async function fetchReassessAnswers(apiKey, subscriberRecordId) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${REASSESS_TBL}` +
    `?filterByFormula=FIND("${subscriberRecordId}", ARRAYJOIN({Subscriber}))`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  const data = await res.json();
  return data.records || [];
}

async function clearReassessAnswers(apiKey, records) {
  for (const r of records) {
    await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${REASSESS_TBL}/${r.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` }
    });
  }
}

// ── WhatsApp send helper ─────────────────────────────────────────

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
  if (!res.ok) console.error(`[FORGED Webhook] WhatsApp send failed: ${await res.text()}`);
}

// ── Message routing logic ────────────────────────────────────────

async function handleReassessAnswer(apiKey, accessToken, subscriber, state, messageText, fromNumber) {
  const answer = parseInt(messageText.trim(), 10);

  if (isNaN(answer) || answer < 1 || answer > 5) {
    await sendWhatsApp(accessToken, fromNumber,
      "That doesn't look like a number from 1 to 5. Please reply with just a number — 1, 2, 3, 4, or 5.");
    return;
  }

  const questionIndex = REASSESS_QUESTION_ORDER.findIndex(
    dim => state === `Awaiting Reassessment Q${REASSESS_QUESTION_ORDER.indexOf(dim) + 1}`
  );

  const currentQNum = parseInt(state.replace("Awaiting Reassessment Q", ""), 10);

  await saveReassessAnswer(apiKey, {
    subscriberRecordId: subscriber.id,
    questionNumber: currentQNum,
    answer
  });

  if (currentQNum < 7) {
    const nextQNum = currentQNum + 1;
    const nextDimension = REASSESS_QUESTION_ORDER[nextQNum - 1];
    await updateSubscriberFields(apiKey, subscriber.id, {
      "Conversation State": `Awaiting Reassessment Q${nextQNum}`
    });
    await sendWhatsApp(accessToken, fromNumber,
      `Got it. Question ${nextQNum} of 7 — *${nextDimension}*.\n\nOn a scale of 1 to 5, how would you rate yourself today on this dimension?\n\n1 = Low · 5 = Strong\n\nReply with just the number.`);
  } else {
    // Final question answered — collect all 7, write to Day 21 fields, clear holding table
    const allAnswers = await fetchReassessAnswers(apiKey, subscriber.id);
    const fieldsToWrite = {};
    for (const rec of allAnswers) {
      const qNum = rec.fields["Question Number"];
      const dim  = REASSESS_QUESTION_ORDER[qNum - 1];
      const fieldName = DAY21_FIELD_MAP[dim];
      fieldsToWrite[fieldName] = rec.fields["Answer"];
    }
    fieldsToWrite["Conversation State"] = "Idle";

    await updateSubscriberFields(apiKey, subscriber.id, fieldsToWrite);
    await clearReassessAnswers(apiKey, allAnswers);

    await sendWhatsApp(accessToken, fromNumber,
      "🔥 That's all 7 — thank you. Your Day 21 results are being prepared now. Your Progress Dashboard will be ready shortly, with a link sent right here on WhatsApp.");

    console.log(`[FORGED Webhook] Re-assessment complete for ${subscriber.fields["Name"]} — ready for dashboard generation`);
  }
}

async function handleReflectReply(apiKey, accessToken, subscriber, messageText, fromNumber) {
  const day = subscriber.fields["Current Day"] || 0;
  const dimension = subscriber.fields["Current Focus Dimension"] || "General";

  await logJournalEntry(apiKey, {
    subscriberRecordId: subscriber.id,
    day,
    dimension,
    text: messageText
  });

  await incrementField(apiKey, subscriber.id, "Journal Reflection Count", subscriber.fields["Journal Reflection Count"]);
  await incrementField(apiKey, subscriber.id, "Nudges Engaged Count", subscriber.fields["Nudges Engaged Count"]);

  await sendWhatsApp(accessToken, fromNumber,
    "🔥 Logged. That kind of honesty with yourself is exactly what builds the dimension you are working on. See you tomorrow.");
}

async function handleLabInterest(apiKey, subscriber, fromNumber) {
  // Per Path C scope decision — this logs interest for Coach Orange's manual
  // follow-up rather than auto-responding with commitments FORGED can't keep.
  await updateSubscriberFields(apiKey, subscriber.id, {
    "Lab Interest Flagged": true,
    "Lab Interest Date": new Date().toISOString().split("T")[0],
  });
  console.log(`[FORGED Webhook] LAB interest flagged for ${subscriber.fields["Name"]} (${fromNumber}) — Coach Orange follow-up required within 24h`);
}

async function handleGenericReply(apiKey, subscriber) {
  await incrementField(apiKey, subscriber.id, "Nudges Engaged Count", subscriber.fields["Nudges Engaged Count"]);
}

// ── Main handler ──────────────────────────────────────────────────

export default async function handler(req) {
  const url = new URL(req.url);

  // ── GET: Meta webhook verification (one-time setup) ──
  if (req.method === "GET") {
    const verifyToken = getEnv("WHATSAPP_VERIFY_TOKEN");
    const mode      = url.searchParams.get("hub.mode");
    const token     = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === verifyToken) {
      return new Response(challenge, { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  // ── POST: inbound message ──
  if (req.method === "POST") {
    try {
      const body = await req.json();
      const AIRTABLE_KEY = getEnv("AIRTABLE_API_KEY");
      const META_TOKEN   = getEnv("META_ACCESS_TOKEN");

      const entry   = body.entry?.[0];
      const change  = entry?.changes?.[0];
      const message = change?.value?.messages?.[0];

      if (!message || message.type !== "text") {
        // Status updates, read receipts, non-text messages — acknowledge and ignore
        return new Response("OK", { status: 200 });
      }

      const fromNumber  = message.from;
      const messageText = message.text?.body || "";

      const subscriber = await findSubscriberByPhone(AIRTABLE_KEY, fromNumber);
      if (!subscriber) {
        console.log(`[FORGED Webhook] No subscriber found for ${fromNumber} — ignoring`);
        return new Response("OK", { status: 200 });
      }

      const state = subscriber.fields["Conversation State"] || "Idle";
      const upperText = messageText.trim().toUpperCase();

      if (state.startsWith("Awaiting Reassessment")) {
        await handleReassessAnswer(AIRTABLE_KEY, META_TOKEN, subscriber, state, messageText, fromNumber);

      } else if (upperText === "REFLECT" || state === "Awaiting Reflection") {
        await handleReflectReply(AIRTABLE_KEY, META_TOKEN, subscriber, messageText, fromNumber);

      } else if (upperText === "LAB") {
        await handleLabInterest(AIRTABLE_KEY, subscriber, fromNumber);

      } else {
        await handleGenericReply(AIRTABLE_KEY, subscriber);
      }

      return new Response("OK", { status: 200 });

    } catch (err) {
      console.error(`[FORGED Webhook] Error: ${err.message}`);
      // Always return 200 to Meta even on internal errors — otherwise Meta
      // will retry aggressively and may disable the webhook after repeated failures.
      return new Response("OK", { status: 200 });
    }
  }

  return new Response("Method Not Allowed", { status: 405 });
}
