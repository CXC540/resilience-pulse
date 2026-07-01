/**
 * FORGED Resilience Lab — Daily Nudge Scheduler
 * Netlify Scheduled Function — runs daily at 05:00 UTC (07:00 WAT)
 *
 * Automations:
 *   - Reads Active subscribers from Airtable daily
 *   - Generates personalised nudge via Claude Haiku (weakest RCI dimension)
 *   - Sends via Meta Cloud API → WhatsApp
 *   - Logs delivery to Nudge Log table
 *   - Auto-sets Status to "Completed" on Day 21
 *   - Generates personalised Day 21 Progress Dashboard (Path A — full build)
 *   - Sends completion message with real dashboard link on Day 21
 */

import { generateAndStoreDay21Dashboard } from "./lib/forged-dashboard-generator.mjs";

export const config = {
  schedule: "0 5 * * *"
};

const AIRTABLE_BASE   = "app1W8ijaU1gfc9nX";
const SUBSCRIBERS_TBL = "tblCKeMaj5p5Lwl0m";
const NUDGE_LOG_TBL   = "tblwWnRJscLpOiYw2";
// TODO: replace with real table ID after creating this table —
// see SCHEMA-airtable-additions.txt section 2
const JOURNAL_TBL     = "tblHD5ZSXEOatYq4P";
const PHONE_ID        = "1135778909625987";
const CLAUDE_MODEL    = "claude-haiku-4-5-20251001";

const DAY21_RCI_FIELDS = {
  "Emotional Regulation":  "Day 21 — Emotional Regulation",
  "Cognitive Flexibility": "Day 21 — Cognitive Flexibility",
  "Social Support":        "Day 21 — Social Support",
  "Purpose & Meaning":     "Day 21 — Purpose & Meaning",
  "Physical Vitality":     "Day 21 — Physical Vitality",
  "Adaptive Coping":       "Day 21 — Adaptive Coping",
  "Identity Stability":    "Day 21 — Identity Stability",
};

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

// Priority order used only to determine rotation sequence when dimensions tie —
// never used to silently pick a single "winner". Based on upstream coaching logic:
// Cognitive Flexibility and Emotional Regulation tend to be foundational to the others.
const DIMENSION_PRIORITY = [
  "Cognitive Flexibility",
  "Emotional Regulation",
  "Adaptive Coping",
  "Physical Vitality",
  "Social Support",
  "Purpose & Meaning",
  "Identity Stability",
];

function growthDimensions(fields) {
  let lowest = Infinity;
  const scored = [];
  for (const [dim, fieldId] of Object.entries(RCI_FIELDS)) {
    const score = fields[fieldId] ?? fields[dim] ?? 3;
    scored.push([dim, score]);
    if (score < lowest) lowest = score;
  }
  const tied = scored.filter(([, score]) => score === lowest).map(([dim]) => dim);
  // Order tied dimensions by coaching priority for consistent rotation sequencing
  tied.sort((a, b) => DIMENSION_PRIORITY.indexOf(a) - DIMENSION_PRIORITY.indexOf(b));
  return { dimensions: tied, score: lowest };
}

function rotateDimension(tiedDimensions, day) {
  // Rotates focus across tied dimensions in roughly equal blocks across the 21 days
  if (tiedDimensions.length === 1) return tiedDimensions[0];
  const blockSize = Math.ceil(21 / tiedDimensions.length);
  const index = Math.min(Math.floor((day - 1) / blockSize), tiedDimensions.length - 1);
  return tiedDimensions[index];
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

async function logNudge(apiKey, { name, day, dimension, message, status, error }) {
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

async function fetchJournalEntries(apiKey, subscriberRecordId) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${JOURNAL_TBL}` +
    `?filterByFormula=FIND("${subscriberRecordId}", ARRAYJOIN({Subscriber}))&sort[0][field]=Day Number&sort[0][direction]=asc`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.records || []).map(r => ({
      day:       r.fields["Day Number"],
      dimension: r.fields["Dimension"],
      text:      r.fields["Reflection Text"],
    }));
  } catch {
    return [];
  }
}

async function updateSubscriberFields(apiKey, recordId, fields) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${SUBSCRIBERS_TBL}/${recordId}`;
  await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields })
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

async function markSubscriberCompleted(apiKey, recordId) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${SUBSCRIBERS_TBL}/${recordId}`;
  await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        "Status":            "Completed",
        "Last Nudge Date":   new Date().toISOString().split("T")[0],
        "Last Nudge Status": "Delivered",
        "Notes":             "21-day Blueprint completed automatically on " + new Date().toISOString().split("T")[0],
      }
    })
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

async function sendDay21Completion(accessToken, to, name, dashboardUrl) {
  const message = `🔥 *FORGED — Day 21 Complete*\n\n${name}, you have completed your 21-Day Resilience Launchpad.\n\nYou are now a *Launchpad Graduate* and a *Resilience Champion*. Both titles are earned, not given — you showed up.\n\nYour full Progress Dashboard — before and after, side by side — is ready here:\n${dashboardUrl}\n\nThis is not the end. It is the beginning of a more grounded, more purposeful leadership journey across Africa.\n\nCoach Orange will be in touch shortly with your next step. You have been forged.`;
  return sendWhatsApp(accessToken, to, message);
}

async function generateNudge(anthropicKey, { name, day, dimension, score, tieCount }) {
  const context = DIMENSION_CONTEXT[dimension];
  const tieNote = tieCount > 1
    ? `Note: ${name} has ${tieCount} dimensions tied as their primary growth dimensions. Today's nudge rotates focus to ${dimension} specifically — do not imply this is their only area of growth, simply today's focus.`
    : "";

  const prompt = `You are FORGED, the AI coaching companion within the FORGED / Resilience Coaching Lab (RCL), built by Coach Orange (Jacob Ntintin Orange) of Change Experience Consulting, for senior leaders across Africa. Your voice is warm, direct, grounded, and faith-informed. You do not use hollow motivation or corporate language. You write with awareness of the specific pressures African leaders carry — institutional resource constraints, hierarchical and politically sensitive environments, collective community and family obligation alongside executive responsibility, and the tension between imported management frameworks and Ubuntu-informed values.

Write a personalised daily WhatsApp nudge for a leader named ${name}. Today is Day ${day} of their 21-Day Resilience Launchpad.

Their focus dimension today is: ${dimension} (score: ${score}/5)
This dimension is about: ${context}
${tieNote}

Requirements:
- Open with 🔥 and "*FORGED — Day ${day}*"
- One short paragraph (3–4 sentences) that speaks directly to ${name} about ${dimension}, framed as a growth opportunity, never as a deficit or weakness
- One reflection question in italics
- Close with a short action instruction (reply REFLECT or similar)
- Total length: 100–130 words
- No hashtags. No marketing language. No reference to "weakest" or "lowest" — use "growth dimension" or "growth opportunity" only
- Speak like a coach who knows them and understands the African leadership context they carry`;

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

export default async function handler() {
  console.log(`[FORGED] Daily nudge run started — ${new Date().toISOString()}`);

  const AIRTABLE_KEY  = getEnv("AIRTABLE_API_KEY");
  const ANTHROPIC_KEY = getEnv("ANTHROPIC_API_KEY");
  const META_TOKEN    = getEnv("META_ACCESS_TOKEN");

  let sent = 0, skipped = 0, failed = 0, completed = 0;

  try {
    const subscribers = await fetchActiveSubscribers(AIRTABLE_KEY);
    console.log(`[FORGED] Found ${subscribers.length} active subscriber(s)`);

    for (const record of subscribers) {
      const f      = record.fields;
      const name   = f["Name"] || "Leader";
      const number = f["WhatsApp"] || "";
      const start  = f["Start Date"];

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

      const { dimensions: growthDims, score } = growthDimensions(f);
      const dimension = rotateDimension(growthDims, day);
      const tieCount  = growthDims.length;
      const to        = formatWhatsApp(number);

      try {
        const message = await generateNudge(ANTHROPIC_KEY, { name, day, dimension, score, tieCount });
        const msgId   = await sendWhatsApp(META_TOKEN, to, message);

        await logNudge(AIRTABLE_KEY, { name, day, dimension, message, status: "Delivered" });

        if (day === 21) {
          const reassessComplete = DAY21_RCI_FIELDS["Cognitive Flexibility"] in f
            ? Object.values(DAY21_RCI_FIELDS).every(fieldName => f[fieldName] !== undefined)
            : false;

          if (!reassessComplete) {
            // Re-assessment not yet completed (subscriber hasn't replied to all 7
            // Day 20 questions yet) — send a gentle nudge instead of a broken dashboard.
            await sendWhatsApp(META_TOKEN, to,
              `🔥 *FORGED — Day 21*\n\n${name}, your 21 days are complete — but we're still missing your re-assessment answers. Your Progress Dashboard needs all 7 to show your real before-and-after.\n\nReply with a number 1-5 to pick up where you left off, or message Coach Orange directly if you'd like to do this by phone instead.`);
            console.log(`[FORGED] ⏸ ${name} | Day 21 reached but re-assessment incomplete — dashboard deferred`);
            skipped++;
            continue;
          }

          const day1Scores = {};
          const day21Scores = {};
          for (const [dim, fieldId] of Object.entries(RCI_FIELDS)) {
            day1Scores[dim] = f[fieldId] ?? f[dim] ?? 3;
          }
          for (const [dim, fieldName] of Object.entries(DAY21_RCI_FIELDS)) {
            day21Scores[dim] = f[fieldName] ?? day1Scores[dim];
          }

          const journalEntries = await fetchJournalEntries(AIRTABLE_KEY, record.id);

          const dashboardUrl = await generateAndStoreDay21Dashboard({
            name,
            organisation:   f["Organisation"] || "",
            jobTitle:       f["Job Title"] || "",
            day1Scores,
            day21Scores,
            nudgesEngaged:  f["Nudges Engaged Count"] || 0,
            journalCount:   f["Journal Reflection Count"] || 0,
            callsCompleted: f["Calls Completed"] || 0,
            journalEntries,
            recordId:       record.id,
          });

          await updateSubscriberFields(AIRTABLE_KEY, record.id, {
            "Dashboard URL":  dashboardUrl,
            "Dashboard Slug": `day21-${record.id}`,
          });

          await sendDay21Completion(META_TOKEN, to, name, dashboardUrl);
          await markSubscriberCompleted(AIRTABLE_KEY, record.id);
          console.log(`[FORGED] ✓ ${name} | Day 21 COMPLETE — dashboard generated at ${dashboardUrl}`);
          completed++;
        } else {
          await updateSubscriberNudgeStatus(AIRTABLE_KEY, record.id, "Delivered");
          console.log(`[FORGED] ✓ ${name} | Day ${day} | ${dimension} | MsgID: ${msgId}`);
        }

        sent++;

      } catch (err) {
        console.error(`[FORGED] ✗ ${name} — ${err.message}`);
        await logNudge(AIRTABLE_KEY, { name, day, dimension, message: "", status: "Failed", error: err.message });
        await updateSubscriberNudgeStatus(AIRTABLE_KEY, record.id, "Failed");
        failed++;
      }

      await new Promise(r => setTimeout(r, 500));
    }

  } catch (err) {
    console.error(`[FORGED] Fatal error — ${err.message}`);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }

  const summary = `[FORGED] Run complete — Sent: ${sent} | Completed: ${completed} | Skipped: ${skipped} | Failed: ${failed}`;
  console.log(summary);
  return new Response(JSON.stringify({ sent, completed, skipped, failed }), { status: 200 });
}
