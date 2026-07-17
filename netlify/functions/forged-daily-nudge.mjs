/**
 * FORGED Resilience Lab — Daily Nudge Scheduler
 * Netlify Scheduled Function — runs daily at 05:00 UTC (07:00 WAT)
 *
 * ── THIS REVISION: TWO GAPS CLOSED ─────────────────────────────────────
 * 1. Automatic Dashboard Slug generation — every active subscriber now
 *    gets a slug assigned automatically (slugified name + short unique
 *    suffix) the first time this function sees them without one.
 *    Previously this field was only ever populated by hand.
 * 2. Automatic dashboard delivery — narrowly scoped to the pilot's
 *    week-4 checkpoint (day 28), NOT a full 12-month cadence. Calls the
 *    real forged-dashboard-generator.mjs internally, sends a
 *    proportionate WhatsApp message (no "Graduate"/"Champion" language —
 *    those are reserved for the defined 3/6/12-month milestones), and
 *    marks the record so it never re-fires.
 *
 * ── REQUIRED SETUP BEFORE THIS WORKS ────────────────────────────────────
 * Add a new checkbox field to Blueprint Subscribers:
 *     "Week 4 Dashboard Sent"  (Checkbox, default unchecked)
 * No tool available this session could create it directly — needs to be
 * added by hand in Airtable before this deploys, or the PATCH calls that
 * reference it will silently fail to persist (Airtable ignores unknown
 * field writes rather than erroring, so this fails quietly, not loudly —
 * worth checking the field exists before relying on this).
 *
 * ── QUARANTINE NOTICE (carried over from the previous revision) ────────
 * The Day-21 auto-completion block (dashboard generation + "Launchpad
 * Graduate / Resilience Champion" completion message) was removed
 * entirely, not just disabled, because it called
 * generateAndStoreDay21Dashboard() from netlify/functions/lib/forged-
 * dashboard-generator.mjs — a stale, divergent copy of the dashboard
 * template still on the retired 21-day model. That file has been renamed
 * to forged-dashboard-generator.LEGACY.mjs and is no longer imported
 * anywhere; nothing in this deployment calls it.
 *
 * ── SEPARATE, PRE-EXISTING GAP — STILL NOT FIXED ────────────────────────
 * Days 22–27 and 29+ still receive no nudge at all (only day 28 has an
 * exception, added above). Full months 2–12 coverage requires the same
 * migration this always needed — rewriting the day-tracking and
 * dimension-rotation logic for a 12-month cadence (Option B), which is
 * deliberately still deferred.
 *
 * Automations (as of this revision):
 *   - Reads Active subscribers from Airtable daily
 *   - Ensures every subscriber has a Dashboard Slug (this revision)
 *   - Generates personalised nudge via Claude Haiku (weakest RCI dimension)
 *   - Sends via Meta Cloud API → WhatsApp
 *   - Logs delivery to Nudge Log table
 *   - Sends week-4 dashboard link once, at day 28 (this revision)
 */

export const config = {
  schedule: "0 5 * * *"
};

const AIRTABLE_BASE   = "app1W8ijaU1gfc9nX";
const SUBSCRIBERS_TBL = "tblCKeMaj5p5Lwl0m";
const NUDGE_LOG_TBL   = "tblwWnRJscLpOiYw2";
// TODO: replace with real table ID after creating this table —
// see SCHEMA-airtable-additions.txt section 2
// Currently unused pending the future 12-month migration — was only
// referenced by functions removed in this revision. Left in place
// rather than deleted since the Monthly Reassessments / journal work
// will need a table reference here again.
const JOURNAL_TBL     = "tblHD5ZSXEOatYq4P";
const PHONE_ID        = "1135778909625987";
const CLAUDE_MODEL    = "claude-haiku-4-5-20251001";

// Site's own public URL — used both to internally invoke the dashboard
// generator and as the base for links sent to subscribers. Netlify sets
// process.env.URL to the site's primary domain automatically; the
// fallback matters only in local/dev contexts where that isn't set.
const SITE_URL = process.env.URL || "https://resilience-coaching.org";

// DAY21_RCI_FIELDS removed in this revision — its only use was in the
// Day-21 completion branch, which no longer exists (see QUARANTINE
// NOTICE at top of file).

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

// fetchJournalEntries() and updateSubscriberFields() removed in this
// revision — their only callers were inside the Day-21 completion branch,
// which no longer exists (see QUARANTINE NOTICE at top of file).


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

// markSubscriberCompleted() removed in this revision — see QUARANTINE
// NOTICE at top of file. Its only caller was the Day-21 completion
// branch below, which has also been removed.

/**
 * GAP FIX 1 — automatic slug generation.
 * Every subscriber needs a Dashboard Slug before a link can ever be sent
 * or manually generated for them. Previously nothing populated this
 * field automatically — it only existed on records someone had typed
 * into by hand (as we did for testing this session). This runs for
 * every active subscriber on every scheduled run, and is a no-op
 * (returns the existing value immediately) once a slug already exists.
 *
 * Format: slugified name + a short, stable suffix from the record ID,
 * so two subscribers with the same name never collide.
 */
async function ensureDashboardSlug(apiKey, recordId, existingSlug, rawName) {
  if (existingSlug) return existingSlug;

  const base = String(rawName || "member")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "member";
  const suffix = recordId.slice(-5).toLowerCase();
  const slug = `${base}-${suffix}`;

  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${SUBSCRIBERS_TBL}/${recordId}`;
  await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { "Dashboard Slug": slug } })
  });

  return slug;
}

/**
 * GAP FIX 2 — automatic delivery, scoped narrowly to the pilot's week-4
 * checkpoint (day 28), NOT a full 12-month cadence. That larger rebuild
 * (Option B) is deliberately still deferred. This:
 *   1. Calls the real forged-dashboard-generator.mjs internally over
 *      HTTP (the same call proven working during manual testing this
 *      session) rather than duplicating its rendering logic here.
 *   2. Sends a proportionate WhatsApp message — explicitly NOT using
 *      "Graduate" or "Champion" language, since week 4 isn't one of the
 *      defined 3/6/12-month milestones.
 *   3. Marks "Week 4 Dashboard Sent" so this never re-fires for the same
 *      subscriber. Requires that checkbox field to exist on Blueprint
 *      Subscribers — see accompanying setup note.
 * Never throws past its own boundary — a failure here should not stop
 * the rest of the day's nudge run for other subscribers.
 */
async function sendWeek4Dashboard(apiKey, metaToken, { recordId, slug, name, to }) {
  try {
    const genRes = await fetch(`${SITE_URL}/.netlify/functions/forged-dashboard-generator?slug=${encodeURIComponent(slug)}`);
    const genData = await genRes.json();
    if (!genRes.ok || !genData.success) {
      throw new Error(genData.error || `Generator returned ${genRes.status}`);
    }

    const link = `${SITE_URL}/dashboard/${slug}`;
    const message = `🔥 *FORGED — Week 4 Check-In*\n\n${name}, four weeks in — here's where you stand:\n${link}\n\nThis reflects your baseline and everything you've engaged with so far. Keep showing up — the next chapter is still being written.`;

    await sendWhatsApp(metaToken, to, message);

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${SUBSCRIBERS_TBL}/${recordId}`;
    await fetch(url, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { "Week 4 Dashboard Sent": true } })
    });

    console.log(`[FORGED] ✓ ${name} | Week 4 dashboard sent — ${link}`);
    return true;
  } catch (err) {
    console.error(`[FORGED] ✗ ${name} — week 4 dashboard send failed: ${err.message}`);
    return false;
  }
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

// sendDay21Completion() removed in this revision — see QUARANTINE
// NOTICE at top of file. It sent retired "Launchpad Graduate /
// Resilience Champion" completion copy and called the stale legacy
// dashboard generator.

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

  // `completed` is retained in the counters/response shape for backward
  // compatibility with anything monitoring this function's output, but it
  // will always be 0 now — the Day-21 completion branch that used to
  // increment it was removed in this revision (see QUARANTINE NOTICE).
  let sent = 0, skipped = 0, failed = 0, completed = 0;

  try {
    const subscribers = await fetchActiveSubscribers(AIRTABLE_KEY);
    console.log(`[FORGED] Found ${subscribers.length} active subscriber(s)`);

    for (const record of subscribers) {
      const f      = record.fields;
      const name   = f["Name"] || f["Full Name"] || "Leader";
      const number = f["WhatsApp"] || "";
      const start  = f["Start Date"];

      if (!number || !start) {
        console.warn(`[FORGED] Skipping ${name} — missing number or start date`);
        skipped++;
        continue;
      }

      // GAP FIX 1 — ensure every active subscriber has a slug, regardless
      // of where they are in their cycle. No-op if one already exists.
      const slug = await ensureDashboardSlug(AIRTABLE_KEY, record.id, f["Dashboard Slug"], name);

      const day = daysBetween(start);

      if (day < 1) {
        console.log(`[FORGED] ${name} has not started yet (day ${day}) — skipping`);
        skipped++;
        continue;
      }

      if (day > 21) {
        // GAP FIX 2 — narrow exception for the pilot's week-4 checkpoint.
        // Does NOT resume daily nudges for day 22+ — that's still
        // deferred to the full 12-month migration (Option B).
        if (day === 28 && !f["Week 4 Dashboard Sent"]) {
          const to = formatWhatsApp(number);
          await sendWeek4Dashboard(AIRTABLE_KEY, META_TOKEN, { recordId: record.id, slug, name, to });
        }
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

        // Day-21 auto-completion branch removed in this revision — see
        // QUARANTINE NOTICE at top of file. Day 21 now falls through to
        // the same standard handling as every other day; no dashboard is
        // auto-generated or auto-sent here anymore.
        await updateSubscriberNudgeStatus(AIRTABLE_KEY, record.id, "Delivered");
        console.log(`[FORGED] ✓ ${name} | Day ${day} | ${dimension} | MsgID: ${msgId}`);

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
