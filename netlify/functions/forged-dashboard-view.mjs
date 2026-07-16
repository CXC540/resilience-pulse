/**
 * FORGED — Dashboard Public View (Revision 3 — Path-Based Slug Fallback)
 * Netlify Function (HTTP endpoint) — serves the cached, personalised
 * dashboard stored in Netlify Blobs by forged-dashboard-generator.mjs,
 * and injects a LIVE engagement snapshot on every request.
 *
 * ── REVISION 3 FIX ──────────────────────────────────────────────────
 * Live testing this session showed /dashboard/{slug} returning "Dashboard
 * not found" via the netlify.toml redirect, on both the netlify.app
 * subdomain and the custom domain, with BOTH a named-parameter redirect
 * (/dashboard/:slug -> ...?slug=:slug) and Netlify's documented splat
 * form (/dashboard/* -> ...?slug=:splat). Querying the function directly
 * with ?slug=X in the URL always worked. This strongly suggests the
 * rewritten query string isn't being reflected in req.url for this
 * function format — so the slug is now read from the URL PATH as a
 * fallback whenever a "slug" query param isn't present, which works
 * regardless of what the rewrite does or doesn't do to the query string.
 *
 * ── WHY THIS REVISION EXISTS ───────────────────────────────────────────
 * The diagnostic content (FRI rings, radar, capstone) is deliberately
 * cached — it should only change when a real reassessment happens,
 * protecting the instrument's validity. But a 12-month subscriber
 * opening the same cached page for a month at a time reads as
 * unresponsive. This revision keeps the diagnostic cached exactly as
 * before, and adds a small, genuinely live section — computed fresh from
 * Airtable on every page view — showing engagement data that changes
 * daily: streak, which FORGED letters have been engaged this cycle, and
 * when the subscriber was last active. Nothing here is estimated or
 * interpolated; every number is a direct read of already-existing data.
 *
 * ── DATA SOURCES (verified against the live repo, not proposed) ───────
 *   Blueprint Subscribers (tblCKeMaj5p5Lwl0m)
 *     - "Nudges Engaged Count"    — lifetime counter, incremented by
 *                                    forged-whatsapp-webhook.mjs on every
 *                                    inbound reply
 *     - "Journal Reflection Count" — lifetime counter, incremented on
 *                                     REFLECT replies specifically
 *   Journal Entries (tblHD5ZSXEOatYq4P)
 *     - "Subscriber" (link), "Dimension", "Logged At" — one record per
 *       REFLECT reply; used here to compute streak and 30-day letter
 *       coverage
 *
 * ── FAILURE HANDLING ────────────────────────────────────────────────
 * If either Airtable call fails, times out, or the API key is missing,
 * the cached diagnostic dashboard still renders correctly — the
 * momentum slot degrades to a short "momentum unavailable" note rather
 * than breaking the page. A subscriber should never see an error page
 * because a secondary, non-essential fetch failed.
 *
 * Deploy at: netlify/functions/forged-dashboard-view.mjs
 *
 * Requires this redirect rule in netlify.toml so that
 * resilience-pulse.netlify.app/dashboard/{slug} routes here:
 *
 *   [[redirects]]
 *     from = "/dashboard/:slug"
 *     to = "/.netlify/functions/forged-dashboard-view?slug=:slug"
 *     status = 200
 */

import { getStore } from "@netlify/blobs";

const AIRTABLE_BASE_ID    = process.env.AIRTABLE_BASE_ID  || "app1W8ijaU1gfc9nX";
const AIRTABLE_TABLE_ID   = process.env.AIRTABLE_TABLE_ID || "tblCKeMaj5p5Lwl0m";
const JOURNAL_TABLE_ID    = process.env.AIRTABLE_JOURNAL_TABLE_ID || "tblHD5ZSXEOatYq4P";
const AIRTABLE_API_KEY    = process.env.AIRTABLE_API_KEY;

// Presentation-layer mapping only — matches the FORGED_DIMENSIONS letters
// in forged-dashboard-generator.mjs. "Identity Stability" (the capstone)
// is intentionally absent here: it is not one of the six nudged working
// forces, so a journal entry logged against it lights up no letter dot.
const DIMENSION_TO_LETTER = {
  "Cognitive Flexibility": "F",
  "Social Support":        "O",
  "Emotional Regulation":  "R",
  "Adaptive Coping":       "G",
  "Physical Vitality":     "E",
  "Purpose & Meaning":     "D",
};
const FORGED_LETTERS = ["F", "O", "R", "G", "E", "D"];

export default async function handler(req) {
  const url = new URL(req.url);

  // Slug can arrive two ways:
  //  1. As a query param (?slug=X) — true for direct/manual testing, and
  //     for redirects where Netlify does substitute the query string.
  //  2. As the last path segment (/dashboard/X) — the request as the
  //     browser actually sent it, before any rewrite. Falling back to
  //     this covers the case where the redirect's rewritten query string
  //     isn't reflected in req.url for this function format, which live
  //     testing this session showed was happening even with a
  //     Netlify-documented splat-based redirect rule.
  const pathSlug = url.pathname.startsWith("/dashboard/")
    ? url.pathname.slice("/dashboard/".length).split("/")[0]
    : null;
  const slug = url.searchParams.get("slug") || (pathSlug ? decodeURIComponent(pathSlug) : null);

  if (!slug) {
    return new Response("Dashboard not found.", { status: 404 });
  }

  try {
    const store = getStore("forged-dashboards");
    const html  = await store.get(slug);

    if (!html) {
      return new Response(
        `<html><body style="font-family:sans-serif;text-align:center;padding:60px;">
          <h2>This dashboard link has expired or does not exist.</h2>
          <p>Please reach out to Coach Orange on WhatsApp for a fresh link.</p>
        </body></html>`,
        { status: 404, headers: { "Content-Type": "text/html" } }
      );
    }

    const momentumHtml = await buildMomentumHtml(slug);
    const finalHtml = html.includes("<!--MOMENTUM_SLOT-->")
      ? html.replace("<!--MOMENTUM_SLOT-->", momentumHtml)
      : html; // older cached dashboards predating Revision 8 simply have no slot to fill

    return new Response(finalHtml, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });

  } catch (err) {
    console.error(`[FORGED Dashboard View] Error: ${err.message}`);
    return new Response("Something went wrong loading your dashboard.", { status: 500 });
  }
}

/**
 * Fetches and computes the live momentum snapshot. Never throws — any
 * failure here degrades to a graceful fallback string rather than
 * affecting the cached diagnostic content above it.
 */
async function buildMomentumHtml(slug) {
  if (!AIRTABLE_API_KEY) {
    return `<div class="momentum-unavailable">Momentum data unavailable right now.</div>`;
  }

  try {
    // 1. Find the subscriber and their lifetime counters.
    const subFilter = encodeURIComponent(`{Dashboard Slug} = "${slug}"`);
    const subRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}?filterByFormula=${subFilter}&maxRecords=1`,
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } }
    );
    if (!subRes.ok) throw new Error(`Subscriber lookup failed: ${subRes.status}`);
    const subData = await subRes.json();
    const subscriber = subData.records?.[0];
    if (!subscriber) throw new Error("Subscriber not found for momentum lookup.");

    const nudgesEngagedCount   = Number(subscriber.fields["Nudges Engaged Count"] || 0);
    const journalReflectionCount = Number(subscriber.fields["Journal Reflection Count"] || 0);

    // 2. Fetch recent journal entries (enough history for a 30-day window
    //    and a realistic streak — 60 records comfortably covers both).
    const journalFilter = encodeURIComponent(`FIND("${subscriber.id}", ARRAYJOIN({Subscriber}))`);
    const journalRes = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${JOURNAL_TABLE_ID}` +
      `?filterByFormula=${journalFilter}&sort[0][field]=Logged At&sort[0][direction]=desc&maxRecords=60`,
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } }
    );

    let entries = [];
    if (journalRes.ok) {
      const journalData = await journalRes.json();
      entries = (journalData.records || [])
        .map((r) => ({
          dimension: r.fields["Dimension"],
          loggedAt: r.fields["Logged At"] ? new Date(r.fields["Logged At"]) : null,
        }))
        .filter((e) => e.loggedAt !== null);
    }
    // If the journal fetch itself fails, momentum still renders using the
    // lifetime counters above — it just won't have streak/letter data.

    const { streak, lettersEngaged, daysSinceLast } = computeMomentumStats(entries);

    return renderMomentumMarkup({
      streak,
      lettersEngaged,
      daysSinceLast,
      nudgesEngagedCount,
      journalReflectionCount,
    });
  } catch (err) {
    console.error(`[FORGED Dashboard View] Momentum fetch failed: ${err.message}`);
    return `<div class="momentum-unavailable">Momentum data unavailable right now.</div>`;
  }
}

/**
 * Pure function: computes streak, 30-day letter coverage, and days since
 * last activity from a list of {dimension, loggedAt} entries. No network
 * calls, no side effects — kept separate from buildMomentumHtml so the
 * logic itself is easy to verify and test in isolation.
 */
function computeMomentumStats(entries) {
  if (entries.length === 0) {
    return { streak: 0, lettersEngaged: new Set(), daysSinceLast: null };
  }

  const dateKey = (d) => d.toISOString().slice(0, 10);

  // Streak: walk backward from today, counting consecutive calendar days
  // with at least one entry. A gap of even one day breaks it.
  const entryDateSet = new Set(entries.map((e) => dateKey(e.loggedAt)));
  let streak = 0;
  const cursor = new Date();
  while (entryDateSet.has(dateKey(cursor))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  // 30-day letter coverage.
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 30);
  const lettersEngaged = new Set();
  for (const e of entries) {
    if (e.loggedAt >= cutoff) {
      const letter = DIMENSION_TO_LETTER[e.dimension];
      if (letter) lettersEngaged.add(letter);
    }
  }

  // Days since the most recent entry (entries are sorted desc on fetch).
  const mostRecent = entries[0].loggedAt;
  const daysSinceLast = Math.floor((new Date() - mostRecent) / 86400000);

  return { streak, lettersEngaged, daysSinceLast };
}

function renderMomentumMarkup({ streak, lettersEngaged, daysSinceLast, nudgesEngagedCount, journalReflectionCount }) {
  const lastActiveText =
    daysSinceLast === null ? "No activity logged yet"
    : daysSinceLast === 0  ? "Active today"
    : daysSinceLast === 1  ? "Active yesterday"
    : `Last active ${daysSinceLast} days ago`;

  const dots = FORGED_LETTERS.map((letter) => {
    const on = lettersEngaged.has(letter);
    return `<div class="letter-dot${on ? " letter-dot--on" : ""}">${letter}</div>`;
  }).join("");

  return `
    <div class="momentum-row">
      <div class="momentum-stat"><div class="num">${streak}</div><div class="cap">Day Streak</div></div>
      <div class="momentum-stat"><div class="num">${nudgesEngagedCount}</div><div class="cap">Total Engagements</div></div>
      <div class="momentum-stat"><div class="num">${journalReflectionCount}</div><div class="cap">Reflections Logged</div></div>
    </div>
    <div class="letter-dots">${dots}</div>
    <div class="momentum-caption">${escapeHtml(lastActiveText)} &nbsp;·&nbsp; letters lit show engagement in the last 30 days</div>`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
