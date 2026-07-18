/**
 * FORGED Resilience Sprint — Cohort Practice-Prompt Scheduler (Revision 1)
 * Netlify Scheduled Function — runs daily at 05:00 UTC (07:00 WAT)
 *
 * ── WHY THIS IS A NEW, SEPARATE FILE ────────────────────────────────────
 * forged-daily-nudge.mjs handles individual subscribers on their own
 * personal calendar, choosing each day's focus by finding that person's
 * own weakest RCI dimension. FORGED Resilience Sprint cohorts need the
 * opposite model: a SHARED calendar (one Start Date per cohort of 12, not
 * per person) and a FIXED weekly schedule — Week 1 is Focus for every
 * participant, Week 2 is Others for every participant, regardless of
 * individual scores. These are different enough mechanics that extending
 * the existing file would risk breaking it for whatever individual
 * subscribers currently depend on it. This file is additive only —
 * nothing in forged-daily-nudge.mjs is touched.
 *
 * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────
 * - Does not schedule or manage the live 60-minute sessions themselves
 *   (Weeks 1 & 6 in person, 2–5 virtual) — those are human-scheduled by
 *   Jacob. This script only sends the daily WhatsApp practice prompt that
 *   reinforces whatever week's theme is current, exactly as described in
 *   the Pioneer Cohort Proposal ("they support the coaching relationship;
 *   they do not replace it").
 * - Does not generate Sprint Graduate certificates. Once a cohort passes
 *   day 42 (end of Week 6), this script simply stops sending prompts for
 *   that cohort. Certificate generation is separate, not-yet-built work.
 * - Does not touch the "Week 4 Dashboard" logic in forged-daily-nudge.mjs
 *   — that belongs to a different pilot model entirely.
 *
 * ── REQUIRED AIRTABLE SETUP BEFORE THIS WORKS ───────────────────────────
 * No tool available this session can create a new table in an existing
 * base — both of these need to be created by hand before this deploys:
 *
 * 1. New table: Cohorts
 *      - Cohort Name     (Single line text)  e.g. "Pioneer Cohort 1"
 *      - Start Date      (Date)               shared start date for all 12
 *      - Status          (Single select: Upcoming / Active / Complete)
 *      - Facilitator     (Single line text)   defaults to Jacob Ntintin Orange
 *      - Participants    (Link to another record → Blueprint Subscribers)
 *
 * 2. New field on Blueprint Subscribers:
 *      - Cohort          (Link to another record → Cohorts)
 *      This can be the reverse side of the Participants link above —
 *      Airtable creates it automatically as a linked field once the
 *      Participants link on Cohorts is set up, so this may not need to
 *      be added separately. Confirm the field name matches "Cohort"
 *      (singular) once created, or update COHORT_LINK_FIELD below.
 *
 * Set COHORTS_TABLE_ID below once the table exists.
 *
 * Deploy at: netlify/functions/forged-sprint-nudge.mjs
 */

export const config = {
  schedule: "0 5 * * *"
};

import { randomBytes } from "node:crypto";

const AIRTABLE_BASE    = "app1W8ijaU1gfc9nX";
const SUBSCRIBERS_TBL  = "tblCKeMaj5p5Lwl0m";
const NUDGE_LOG_TBL    = "tblwWnRJscLpOiYw2"; // reused — same log, entries tagged by cohort
const COHORTS_TABLE_ID = process.env.COHORTS_TABLE_ID || ""; // TODO: set once the Cohorts table exists
const COHORT_LINK_FIELD = "Cohort"; // field on Blueprint Subscribers linking to Cohorts

const PHONE_ID     = "1135778909625987";
const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const SITE_URL      = process.env.URL || "https://resilience-coaching.org";

// The fixed, shared weekly schedule — every participant in a cohort gets
// the SAME force in the SAME week, unlike the individual model's
// per-person weakest-dimension rotation. Matches the table in the
// Pioneer Cohort Proposal exactly (Week 6 covers two themes).
const WEEK_SCHEDULE = [
  { week: 1, letter: "F", label: "Focus",      context: "adjusting your approach without losing momentum when plans change unexpectedly" },
  { week: 2, letter: "O", label: "Others",     context: "drawing on the people around you for real support, not just appearing self-sufficient" },
  { week: 3, letter: "R", label: "Regulation", context: "staying composed and clear-headed in high-stakes, high-pressure moments" },
  { week: 4, letter: "G", label: "Grit",       context: "continuing to push forward on difficult work even when progress feels slow" },
  { week: 5, letter: "E", label: "Energy",     context: "protecting the physical energy that everything else you do actually depends on" },
  { week: 6, letter: "D", label: "Direction",  context: "reconnecting with the deeper purpose behind the pressure you carry, and consolidating what this Sprint has revealed" },
];
const SPRINT_TOTAL_DAYS = 42; // 6 weeks × 7 days

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

function weekForDay(day) {
  return Math.min(Math.ceil(day / 7), 6);
}

function formatWhatsApp(number) {
  const digits = number.replace(/\D/g, "");
  return digits.startsWith("264") ? digits : `264${digits.replace(/^0/, "")}`;
}

async function fetchActiveCohorts(apiKey) {
  if (!COHORTS_TABLE_ID) {
    console.warn("[Sprint Nudge] COHORTS_TABLE_ID not set — Cohorts table doesn't exist yet. Skipping run.");
    return [];
  }
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${COHORTS_TABLE_ID}` +
    `?filterByFormula={Status}="Active"&pageSize=100`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`Airtable cohorts fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.records || [];
}

async function fetchCohortParticipants(apiKey, participantIds) {
  if (!participantIds || participantIds.length === 0) return [];
  // Airtable record-ID lookups: fetch each linked participant record directly
  // rather than a filterByFormula OR-chain, which gets unwieldy past a
  // handful of IDs and isn't meaningfully faster for a cohort of 12.
  const records = [];
  for (const id of participantIds) {
    const res = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${SUBSCRIBERS_TBL}/${id}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (res.ok) records.push(await res.json());
    else console.error(`[Sprint Nudge] Failed to fetch participant ${id}: ${res.status}`);
  }
  return records;
}

async function ensureDashboardSlug(apiKey, recordId, existingSlug, rawName) {
  if (existingSlug) return existingSlug;
  const base = String(rawName || "member")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "member";
  // Same entropy standard as the individual scheduler's security fix —
  // this data is equally sensitive, so it gets the same protection.
  const suffix = randomBytes(12).toString("hex");
  const slug = `${base}-${suffix}`;

  await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${SUBSCRIBERS_TBL}/${recordId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { "Dashboard Slug": slug } })
  });
  return slug;
}

async function logNudge(apiKey, { name, day, cohortName, dimension, message, status, error }) {
  await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${NUDGE_LOG_TBL}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        "Subscriber Name": name,
        "Day Number":       day,
        "Dimension":        `${dimension} (${cohortName})`, // tagged so cohort entries are distinguishable in the shared log
        "Message":          message,
        "Status":           status,
        "Error":            error || "",
        "Sent At":          new Date().toISOString(),
      }
    })
  });
}

async function sendWhatsApp(accessToken, to, message) {
  const res = await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/messages`, {
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

async function generatePracticePrompt(anthropicKey, { name, day, week, theme }) {
  const prompt = `You are FORGED, the coaching companion supporting FORGED Resilience Sprint — a six-week, live-facilitated leadership resilience cohort programme run by Jacob Ntintin Orange (Coach Orange) of Change Experience Consulting, for senior leaders across Africa. Your voice is warm, direct, grounded, and faith-informed. You do not use hollow motivation or corporate language.

You are NOT the coach — Jacob personally facilitates every live session. Your role is to send a short daily WhatsApp practice prompt that extends this week's coaching focus between live sessions. Never imply that this message replaces the coaching relationship or the live session itself.

Write a personalised daily practice prompt for a leader named ${name}. This is Day ${day} of their FORGED Resilience Sprint, in Week ${week}, focused on the FORGED theme: ${theme.label} (letter ${theme.letter}).

This week's theme is about: ${theme.context}

Requirements:
- Open with 🔥 and "*FORGED Sprint — Week ${week}, Day ${day}*"
- One short paragraph (2–3 sentences) offering a small, concrete practice tied to ${theme.label} — something to actually try today, not just something to think about
- One reflection question in italics
- Close with a short, light invitation to reply (e.g. "Reply and let me know how it goes")
- Total length: 80–110 words — this is a practice prompt extending the coaching, not a standalone coaching session
- No hashtags, no marketing language
- Never refer to this message as "coaching" itself — it supports the coaching Jacob delivers live`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key":         anthropicKey,
      "anthropic-version": "2023-06-01",
      "Content-Type":      "application/json",
    },
    body: JSON.stringify({
      model:      CLAUDE_MODEL,
      max_tokens: 260,
      messages:   [{ role: "user", content: prompt }],
    })
  });

  if (!res.ok) throw new Error(`Claude API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || "";
}

export default async function handler() {
  console.log(`[Sprint Nudge] Run started — ${new Date().toISOString()}`);

  const AIRTABLE_KEY  = getEnv("AIRTABLE_API_KEY");
  const ANTHROPIC_KEY = getEnv("ANTHROPIC_API_KEY");
  const META_TOKEN    = getEnv("META_ACCESS_TOKEN");

  let sent = 0, skipped = 0, failed = 0, cohortsProcessed = 0;

  try {
    const cohorts = await fetchActiveCohorts(AIRTABLE_KEY);
    console.log(`[Sprint Nudge] Found ${cohorts.length} active cohort(s)`);

    for (const cohort of cohorts) {
      const cf = cohort.fields;
      const cohortName = cf["Cohort Name"] || "Unnamed Cohort";
      const startDate  = cf["Start Date"];
      const participantIds = cf["Participants"] || [];

      if (!startDate) {
        console.warn(`[Sprint Nudge] ${cohortName} has no Start Date — skipping cohort`);
        continue;
      }

      const day = daysBetween(startDate);

      if (day < 1) {
        console.log(`[Sprint Nudge] ${cohortName} has not started yet (day ${day}) — skipping`);
        continue;
      }
      if (day > SPRINT_TOTAL_DAYS) {
        console.log(`[Sprint Nudge] ${cohortName} completed its 6 weeks on day ${SPRINT_TOTAL_DAYS} — no further prompts sent (day ${day})`);
        continue;
      }

      const week  = weekForDay(day);
      const theme = WEEK_SCHEDULE.find((w) => w.week === week);
      cohortsProcessed++;

      const participants = await fetchCohortParticipants(AIRTABLE_KEY, participantIds);
      console.log(`[Sprint Nudge] ${cohortName} — Day ${day}, Week ${week} (${theme.label}) — ${participants.length} participant(s)`);

      for (const record of participants) {
        const f      = record.fields;
        const name   = f["Name"] || f["Full Name"] || "Leader";
        const number = f["WhatsApp"] || "";

        if (!number) {
          console.warn(`[Sprint Nudge] Skipping ${name} in ${cohortName} — missing WhatsApp number`);
          skipped++;
          continue;
        }

        await ensureDashboardSlug(AIRTABLE_KEY, record.id, f["Dashboard Slug"], name);
        const to = formatWhatsApp(number);

        try {
          const message = await generatePracticePrompt(ANTHROPIC_KEY, { name, day, week, theme });
          const msgId   = await sendWhatsApp(META_TOKEN, to, message);
          await logNudge(AIRTABLE_KEY, { name, day, cohortName, dimension: theme.label, message, status: "Delivered" });
          console.log(`[Sprint Nudge] ✓ ${name} | ${cohortName} | Week ${week} (${theme.label}) | MsgID: ${msgId}`);
          sent++;
        } catch (err) {
          console.error(`[Sprint Nudge] ✗ ${name} in ${cohortName} — ${err.message}`);
          await logNudge(AIRTABLE_KEY, { name, day, cohortName, dimension: theme.label, message: "", status: "Failed", error: err.message });
          failed++;
        }

        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } catch (err) {
    console.error(`[Sprint Nudge] Fatal error — ${err.message}`);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }

  const summary = `[Sprint Nudge] Run complete — Cohorts: ${cohortsProcessed} | Sent: ${sent} | Skipped: ${skipped} | Failed: ${failed}`;
  console.log(summary);
  return new Response(JSON.stringify({ cohortsProcessed, sent, skipped, failed }), { status: 200 });
}
