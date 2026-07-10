/**
 * FORGED — Dashboard Generator (Revision 2)
 * Netlify Function — generates a personalised Resilience Progress Dashboard
 * for a single subscriber and writes it to the Netlify Blobs store that
 * forged-dashboard-view.mjs reads from.
 *
 * Deploy at: netlify/functions/forged-dashboard-generator.mjs
 *
 * ── SCHEMA CONFIRMED THIS SESSION (Blueprint Subscribers table) ─────
 * Base ID:  app1W8ijaU1gfc9nX
 * Table ID: tblCKeMaj5p5Lwl0m
 *
 * Day 1 baseline fields (7):  "RCI — {Dimension}"
 * Day 21 reassessment fields (7): "Day 21 — {Dimension}"
 * Lookup field: "Dashboard Slug"
 * Output field: "Dashboard URL"
 * Completion flag: "Reassessment In Progress" (checkbox — if checked/true,
 *   Day 21 data is not yet final and the dashboard should present baseline
 *   results only, with a "reassessment pending" state).
 *
 * ── ASSUMPTION REQUIRING YOUR CONFIRMATION ───────────────────────────
 * Each dimension is assumed scored on a 1–5 scale (per values of 2, 3, 4
 * observed on the live record and confirmed as consistent with 1–5 in
 * this session). If your actual scale differs, change SCALE_MAX below —
 * no other line needs to change as a result.
 *
 * Required environment variables (Netlify → Project configuration →
 * Environment variables):
 *   AIRTABLE_API_KEY
 *   AIRTABLE_BASE_ID   (defaults to app1W8ijaU1gfc9nX if unset)
 *   AIRTABLE_TABLE_ID  (defaults to tblCKeMaj5p5Lwl0m if unset)
 * ─────────────────────────────────────────────────────────────────────
 */

import { getStore } from "@netlify/blobs";

const AIRTABLE_BASE_ID  = process.env.AIRTABLE_BASE_ID  || "app1W8ijaU1gfc9nX";
const AIRTABLE_TABLE_ID = process.env.AIRTABLE_TABLE_ID || "tblCKeMaj5p5Lwl0m";
const AIRTABLE_API_KEY  = process.env.AIRTABLE_API_KEY;

// Confirmed scale — adjust here only if your instrument's true range differs.
const SCALE_MAX = 5;

const FIELD_FULL_NAME           = "Full Name";
const FIELD_DASHBOARD_SLUG      = "Dashboard Slug";
const FIELD_DASHBOARD_URL       = "Dashboard URL";
const FIELD_REASSESS_IN_PROGRESS = "Reassessment In Progress";

const DIMENSIONS = [
  { label: "Emotional Regulation",  day1: "RCI — Emotional Regulation",  day21: "Day 21 — Emotional Regulation" },
  { label: "Cognitive Flexibility", day1: "RCI — Cognitive Flexibility", day21: "Day 21 — Cognitive Flexibility" },
  { label: "Social Support",        day1: "RCI — Social Support",        day21: "Day 21 — Social Support" },
  { label: "Purpose and Meaning",   day1: "RCI — Purpose & Meaning",     day21: "Day 21 — Purpose & Meaning" },
  { label: "Physical Vitality",     day1: "RCI — Physical Vitality",     day21: "Day 21 — Physical Vitality" },
  { label: "Adaptive Coping",       day1: "RCI — Adaptive Coping",       day21: "Day 21 — Adaptive Coping" },
  { label: "Identity Stability",    day1: "RCI — Identity Stability",    day21: "Day 21 — Identity Stability" },
];

export default async function handler(req) {
  const url  = new URL(req.url);
  const slug = url.searchParams.get("slug");

  if (!slug) {
    return json({ error: "Missing required 'slug' parameter." }, 400);
  }
  if (!AIRTABLE_API_KEY) {
    return json({ error: "AIRTABLE_API_KEY is not configured in Netlify environment variables." }, 500);
  }

  try {
    const filterFormula = encodeURIComponent(`{${FIELD_DASHBOARD_SLUG}} = "${slug}"`);
    const airtableUrl =
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}` +
      `?filterByFormula=${filterFormula}&maxRecords=1`;

    const airtableRes = await fetch(airtableUrl, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    });

    if (!airtableRes.ok) {
      const errText = await airtableRes.text();
      return json({ error: "Airtable request failed.", detail: errText }, 502);
    }

    const airtableData = await airtableRes.json();
    const record = airtableData.records?.[0];

    if (!record) {
      return json({ error: `No subscriber record found for slug '${slug}'.` }, 404);
    }

    const fields = record.fields || {};
    const fullName  = fields[FIELD_FULL_NAME] || "Leader";
    const firstName = String(fullName).split(" ")[0];
    const reassessInProgress = Boolean(fields[FIELD_REASSESS_IN_PROGRESS]);

    // Build per-dimension score pairs, converting raw 1–SCALE_MAX values to %
    const dimensions = DIMENSIONS.map((d) => {
      const rawDay1  = fields[d.day1];
      const rawDay21 = fields[d.day21];
      return {
        label: d.label,
        day1Raw:  rawDay1  !== undefined && rawDay1  !== null && rawDay1  !== "" ? Number(rawDay1)  : null,
        day21Raw: rawDay21 !== undefined && rawDay21 !== null && rawDay21 !== "" ? Number(rawDay21) : null,
      };
    }).map((d) => ({
      ...d,
      day1Pct:  d.day1Raw  !== null ? toPercent(d.day1Raw)  : null,
      day21Pct: d.day21Raw !== null ? toPercent(d.day21Raw) : null,
    }));

    // Day 21 is considered complete only if every dimension has a value
    // AND the record is not flagged as still in progress.
    const day21Complete = !reassessInProgress && dimensions.every((d) => d.day21Raw !== null && d.day21Raw > 0);

    const day1Scores  = dimensions.map((d) => d.day1Pct).filter((v) => v !== null);
    const day21Scores = dimensions.map((d) => d.day21Pct).filter((v) => v !== null);

    const day1Overall  = day1Scores.length  ? Math.round(average(day1Scores))  : null;
    const day21Overall = day21Complete && day21Scores.length ? Math.round(average(day21Scores)) : null;

    // Growth dimension / foundation strength are drawn from the most
    // current complete data set: Day 21 if complete, otherwise Day 1.
    const referenceScores = dimensions.map((d) => ({
      label: d.label,
      score: day21Complete ? d.day21Pct : d.day1Pct,
    })).filter((d) => d.score !== null);

    const growthDimension = referenceScores.length
      ? referenceScores.reduce((a, b) => (a.score <= b.score ? a : b))
      : null;
    const foundationStrength = referenceScores.length
      ? referenceScores.reduce((a, b) => (a.score >= b.score ? a : b))
      : null;

    const html = renderDashboardHtml({
      firstName,
      day1Overall,
      day21Overall,
      day21Complete,
      dimensions,
      growthDimension,
      foundationStrength,
    });

    const store = getStore("forged-dashboards");
    await store.set(slug, html);

    return json({
      success: true,
      slug,
      day21Complete,
      dashboardUrl: fields[FIELD_DASHBOARD_URL] || `/dashboard/${slug}`,
    });
  } catch (err) {
    return json({ error: "Unexpected error generating dashboard.", detail: String(err) }, 500);
  }
}

function toPercent(raw) {
  const pct = (raw / SCALE_MAX) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

function average(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderDashboardHtml({ firstName, day1Overall, day21Overall, day21Complete, dimensions, growthDimension, foundationStrength }) {
  const improvement = (day1Overall !== null && day21Overall !== null) ? day21Overall - day1Overall : null;

  const dimensionRows = dimensions.map((d) => {
    const displayPct = day21Complete ? d.day21Pct : d.day1Pct;
    const pct = displayPct !== null ? displayPct : 0;
    const displayScore = displayPct !== null ? `${displayPct}%` : "—";
    return `
      <div class="dim-row">
        <div class="dim-label">${escapeHtml(d.label)}</div>
        <div class="dim-bar-track"><div class="dim-bar-fill" style="width:${pct}%"></div></div>
        <div class="dim-score">${displayScore}</div>
      </div>`;
  }).join("");

  const badges = day21Complete
    ? `<div class="badge">Launchpad Graduate</div><div class="badge">Resilience Champion</div>`
    : `<div class="badge badge-pending">Baseline Recorded</div>`;

  const statusNote = day21Complete
    ? ""
    : `<div class="pending-note">Your Day 21 reassessment is still in progress. This dashboard currently reflects your Day 1 baseline only — it will update automatically once your reassessment is complete.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>FORGED — ${escapeHtml(firstName)}'s Resilience Progress Dashboard</title>
<style>
  :root { --navy:#1C3557; --crimson:#8B1A1A; --gold:#B8860B; --cream:#F7F5F0; --ink:#1A1A1A; --muted:#5B6472; --line:#E3DFD6; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:'Calibri','Segoe UI',sans-serif; color:var(--ink); background:var(--cream); line-height:1.6; }
  h1,h2,.serif-accent { font-family:'Cambria','Georgia',serif; }
  .header { background:var(--navy); color:#EDEAE2; padding:48px 40px; border-left:6px solid var(--gold); }
  .eyebrow { letter-spacing:3px; text-transform:uppercase; font-size:13px; color:var(--gold); font-weight:600; }
  .header h1 { font-size:36px; font-weight:400; margin-top:14px; }
  .header h1 em { font-style:italic; color:#D9C6A0; }
  .container { max-width:760px; margin:0 auto; padding:40px; }
  .badges { display:flex; gap:12px; margin-top:20px; flex-wrap:wrap; }
  .badge { background:var(--gold); color:var(--navy); font-size:13px; font-weight:700; padding:8px 16px; border-radius:2px; }
  .badge-pending { background:transparent; border:1px solid #5B6472; color:#C6CBD4; }
  .pending-note { background:#FCF3E3; border-left:4px solid var(--gold); padding:16px 20px; font-size:14px; color:var(--muted); margin-bottom:28px; }
  .score-summary { display:flex; gap:24px; margin-bottom:36px; flex-wrap:wrap; }
  .score-card { background:#fff; border:1px solid var(--line); border-top:3px solid var(--gold); padding:20px 24px; flex:1; min-width:160px; }
  .score-card .label { font-size:12px; letter-spacing:1px; text-transform:uppercase; color:var(--gold); font-weight:600; }
  .score-card .value { font-size:32px; color:var(--navy); font-family:'Cambria',serif; margin-top:6px; }
  .dim-row { display:grid; grid-template-columns:180px 1fr 60px; align-items:center; gap:16px; margin-bottom:14px; }
  .dim-label { font-size:14px; color:var(--ink); }
  .dim-bar-track { background:var(--line); border-radius:3px; height:10px; overflow:hidden; }
  .dim-bar-fill { background:var(--crimson); height:100%; }
  .dim-score { font-size:13px; color:var(--muted); text-align:right; }
  .insight-block { background:#EEF1F5; border-left:4px solid var(--navy); padding:22px 26px; margin-top:32px; }
  .insight-block p { font-size:15px; color:var(--navy); margin-bottom:8px; }
  .insight-block strong { color:var(--crimson); }
  .footer { text-align:center; padding:32px 40px; font-size:13px; color:var(--muted); }
  @media (max-width:560px) { .dim-row { grid-template-columns:1fr; gap:4px; } .dim-score { text-align:left; } }
</style>
</head>
<body>
  <div class="header">
    <div class="eyebrow">FORGED &nbsp;·&nbsp; Resilience Coaching Lab</div>
    <h1>${escapeHtml(firstName)}'s <em>Resilience Progress</em></h1>
    <div class="badges">${badges}</div>
  </div>

  <div class="container">
    ${statusNote}
    <div class="score-summary">
      <div class="score-card"><div class="label">Day 1 FRI</div><div class="value">${day1Overall !== null ? day1Overall + "%" : "—"}</div></div>
      <div class="score-card"><div class="label">Day 21 FRI</div><div class="value">${day21Overall !== null ? day21Overall + "%" : "Pending"}</div></div>
      <div class="score-card"><div class="label">Growth</div><div class="value">${improvement !== null ? (improvement >= 0 ? "+" : "") + improvement + "%" : "—"}</div></div>
    </div>

    <h2 class="serif-accent" style="font-size:20px;color:var(--navy);margin-bottom:16px;">Your Seven Dimensions</h2>
    ${dimensionRows}

    <div class="insight-block">
      <p><strong>Primary growth dimension:</strong> ${growthDimension ? escapeHtml(growthDimension.label) : "Not yet assessed"} — this is where your next chapter of development lives.</p>
      <p><strong>Foundation strength:</strong> ${foundationStrength ? escapeHtml(foundationStrength.label) : "Not yet assessed"} — build from here as you go deeper.</p>
    </div>
  </div>

  <div class="footer">FORGED — Resilience Coaching Lab &nbsp;·&nbsp; A programme of Change Experience Consulting (CXC)</div>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
