/**
 * FORGED — Dashboard Generator (Revision 8 — Momentum Slot Added)
 * Netlify Function — generates a personalised Resilience Progress Dashboard
 * for a single subscriber and writes it to the Netlify Blobs store that
 * forged-dashboard-view.mjs reads from.
 *
 * REVISION 8 CHANGE: adds a "This Month, Live" beat with a
 * <!--MOMENTUM_SLOT--> marker, plus its CSS. This function still only
 * renders the DIAGNOSTIC content (rings, radar, capstone) — the marker is
 * deliberately left as static placeholder text here. forged-dashboard-
 * view.mjs (Revision 2) fetches live engagement data (streak, letters
 * engaged, last active) on every page view and substitutes it into this
 * marker at serve time. This keeps the diagnostic instrument's cadence
 * protected (unchanged from Revision 7) while making the page visibly
 * move on every visit, addressing the "unresponsive for 12 months"
 * concern without fabricating movement in the FRI itself.
 *
 * ── WHY THIS REVISION EXISTS ──────────────────────────────────────────
 * Confirmed this session: the platform has pivoted from the fixed 21-day
 * Resilience Launchpad to a 12-month recurring FORGED Membership
 * (N$59/month or N$590/year). Everything built around "Day 1 → Day 21" —
 * field names, the "Launchpad Graduate" badge, the one-time reassessment
 * trigger — belonged to the retired model and is replaced below.
 *
 * ── WHAT DID NOT CHANGE (verified against the live repo) ─────────────
 * The Blueprint Subscribers table (Base app1W8ijaU1gfc9nX, Table
 * tblCKeMaj5p5Lwl0m) still holds each subscriber's BASELINE scores under
 * the original field names ("RCI — Emotional Regulation", etc.). This
 * revision keeps reading those fields exactly as before — they now
 * represent "Month 0" / baseline rather than "Day 1," but nothing about
 * how they're stored or fetched has changed.
 *
 * ── WHAT REQUIRES NEW SETUP ON YOUR SIDE BEFORE THIS GOES LIVE ────────
 * A recurring cadence needs somewhere to store each month's reassessment,
 * which the old schema has no table for. This revision expects a NEW
 * Airtable table, proposed here as "Monthly Reassessments" — please
 * confirm or rename before deploying:
 *
 *   Table: Monthly Reassessments
 *     - Subscriber        (Link to record → Blueprint Subscribers)
 *     - Subscriber Slug    (Lookup → "Dashboard Slug" on Subscriber)
 *                           ↳ lets this function filter the same way the
 *                             Blueprint Subscribers lookup already does,
 *                             without relying on Airtable's unreliable
 *                             linked-record-by-ID filtering.
 *     - Month Number        (Number, 1–12)
 *     - Cognitive Flexibility, Social Support, Emotional Regulation,
 *       Adaptive Coping, Physical Vitality, Purpose & Meaning,
 *       Identity Stability   (Number, 1–SCALE_MAX — same scale as baseline)
 *
 * Set AIRTABLE_REASSESS_TABLE_ID once that table exists. Until then, this
 * function deploys and runs safely in baseline-only mode (every
 * subscriber renders as "Month 0 / just started") — it will NOT error out
 * for missing configuration, so this is safe to ship ahead of that table
 * being finished.
 *
 * Required environment variables:
 *   AIRTABLE_API_KEY
 *   AIRTABLE_BASE_ID           (defaults to app1W8ijaU1gfc9nX if unset)
 *   AIRTABLE_TABLE_ID          (defaults to tblCKeMaj5p5Lwl0m if unset)
 *   AIRTABLE_REASSESS_TABLE_ID (no default — required only once the
 *                                Monthly Reassessments table above exists)
 *
 * Deploy at: netlify/functions/forged-dashboard-generator.mjs
 * ─────────────────────────────────────────────────────────────────────
 */

import { getStore } from "@netlify/blobs";

const AIRTABLE_BASE_ID          = process.env.AIRTABLE_BASE_ID  || "app1W8ijaU1gfc9nX";
const AIRTABLE_TABLE_ID         = process.env.AIRTABLE_TABLE_ID || "tblCKeMaj5p5Lwl0m";
const AIRTABLE_REASSESS_TABLE_ID = process.env.AIRTABLE_REASSESS_TABLE_ID || null;
const AIRTABLE_API_KEY          = process.env.AIRTABLE_API_KEY;

// Confirmed scale — adjust here only if your instrument's true range differs.
const SCALE_MAX = 5;

const FIELD_FULL_NAME      = "Full Name";
const FIELD_DASHBOARD_SLUG = "Dashboard Slug";
const FIELD_DASHBOARD_URL  = "Dashboard URL";

// The six FORGED working forces (radar axes). Presentation-layer labels
// only — baselineField values are the existing, unchanged Blueprint
// Subscribers column names; reassessField values are the proposed
// Monthly Reassessments column names (see setup note above).
const FORGED_DIMENSIONS = [
  { letter: "F", label: "Focus",      sublabel: "Cognitive Flexibility", baselineField: "RCI — Cognitive Flexibility", reassessField: "Cognitive Flexibility" },
  { letter: "O", label: "Others",     sublabel: "Social Support",        baselineField: "RCI — Social Support",        reassessField: "Social Support" },
  { letter: "R", label: "Regulation", sublabel: "Emotional Regulation",  baselineField: "RCI — Emotional Regulation",  reassessField: "Emotional Regulation" },
  { letter: "G", label: "Grit",       sublabel: "Adaptive Coping",       baselineField: "RCI — Adaptive Coping",       reassessField: "Adaptive Coping" },
  { letter: "E", label: "Energy",     sublabel: "Physical Vitality",     baselineField: "RCI — Physical Vitality",     reassessField: "Physical Vitality" },
  { letter: "D", label: "Direction",  sublabel: "Purpose & Meaning",     baselineField: "RCI — Purpose & Meaning",     reassessField: "Purpose & Meaning" },
];

// Identity Stability — the capstone outcome, not a radar axis.
const CAPSTONE_DIMENSION = {
  label: "The Forged Self",
  sublabel: "Identity Stability",
  baselineField: "RCI — Identity Stability",
  reassessField: "Identity Stability",
};

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
    // ── 1. Fetch the subscriber and their baseline (Month 0) scores ──
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

    // ── 2. Fetch the latest monthly reassessment, if the table is configured ──
    let latestReassessment = null;
    let monthsCompleted = 0;

    if (AIRTABLE_REASSESS_TABLE_ID) {
      const reassessFilter = encodeURIComponent(`{Subscriber Slug} = "${slug}"`);
      const reassessUrl =
        `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_REASSESS_TABLE_ID}` +
        `?filterByFormula=${reassessFilter}&sort[0][field]=Month Number&sort[0][direction]=desc&maxRecords=1`;

      const reassessRes = await fetch(reassessUrl, {
        headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
      });

      // Non-fatal: if the reassessment table isn't ready or the request
      // fails, the dashboard still renders correctly in baseline-only mode.
      if (reassessRes.ok) {
        const reassessData = await reassessRes.json();
        latestReassessment = reassessData.records?.[0] || null;
        monthsCompleted = latestReassessment?.fields?.["Month Number"]
          ? Number(latestReassessment.fields["Month Number"])
          : 0;
      }
    }

    // ── 3. Build per-dimension score pairs (baseline vs. current month) ──
    const buildDimension = (d) => {
      const rawBaseline = fields[d.baselineField];
      const rawCurrent   = latestReassessment?.fields?.[d.reassessField];
      const baselineRaw  = rawBaseline !== undefined && rawBaseline !== null && rawBaseline !== "" ? Number(rawBaseline) : null;
      const currentRaw   = rawCurrent  !== undefined && rawCurrent  !== null && rawCurrent  !== "" ? Number(rawCurrent)  : null;
      return {
        letter: d.letter,
        label: d.label,
        sublabel: d.sublabel,
        baselineRaw,
        currentRaw,
        baselinePct: baselineRaw !== null ? toPercent(baselineRaw) : null,
        currentPct:  currentRaw  !== null ? toPercent(currentRaw)  : null,
      };
    };

    const dimensions = FORGED_DIMENSIONS.map(buildDimension);
    const capstone    = buildDimension(CAPSTONE_DIMENSION);

    const hasCurrentMonth = monthsCompleted > 0;

    const baselineScores = [...dimensions, capstone].map((d) => d.baselinePct).filter((v) => v !== null);
    const currentScores  = [...dimensions, capstone].map((d) => d.currentPct).filter((v) => v !== null);

    const baselineOverall = baselineScores.length ? Math.round(average(baselineScores)) : null;
    const currentOverall  = hasCurrentMonth && currentScores.length ? Math.round(average(currentScores)) : null;

    // Growth edge / strength drawn from the most current complete data set.
    const referenceScores = [...dimensions, capstone].map((d) => ({
      label: d.label,
      score: hasCurrentMonth && d.currentPct !== null ? d.currentPct : d.baselinePct,
    })).filter((d) => d.score !== null);

    const growthDimension = referenceScores.length
      ? referenceScores.reduce((a, b) => (a.score <= b.score ? a : b))
      : null;
    const foundationStrength = referenceScores.length
      ? referenceScores.reduce((a, b) => (a.score >= b.score ? a : b))
      : null;

    const html = renderDashboardHtml({
      firstName,
      baselineOverall,
      currentOverall,
      monthsCompleted,
      dimensions,
      capstone,
      growthDimension,
      foundationStrength,
    });

    const store = getStore("forged-dashboards");
    await store.set(slug, html);

    return json({
      success: true,
      slug,
      monthsCompleted,
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

/**
 * Cumulative milestone for the 12-month membership. Returns null before
 * the first milestone is reached — the base "FORGED Member" badge always
 * shows regardless, so a null here is not an empty state, just "not yet
 * at a milestone."
 */
function getMilestone(monthsCompleted) {
  if (monthsCompleted >= 12) return { label: "12 Months Forged", isFinal: true };
  if (monthsCompleted >= 6)  return { label: "6 Months Forged",  isFinal: false };
  if (monthsCompleted >= 3)  return { label: "3 Months Forged",  isFinal: false };
  return null;
}

function renderDashboardHtml({ firstName, baselineOverall, currentOverall, monthsCompleted, dimensions, capstone, growthDimension, foundationStrength }) {
  const improvement = (baselineOverall !== null && currentOverall !== null) ? currentOverall - baselineOverall : null;
  const milestone = getMilestone(monthsCompleted);
  const yearComplete = monthsCompleted >= 12;

  // ── Headline / subline — three states across the 12-month arc ──
  let headline, subline;
  if (yearComplete) {
    headline = `You've been forged, <em>${escapeHtml(firstName)}</em>.`;
    subline = "Twelve months of showing up. Resilient leaders are not created. They are forged — and you just proved it.";
  } else if (monthsCompleted > 0) {
    headline = `Month ${monthsCompleted}, <em>${escapeHtml(firstName)}</em>.`;
    subline = `You're ${monthsCompleted} of 12 months into your FORGED Membership — here's where you stand today.`;
  } else {
    headline = `Welcome to FORGED, <em>${escapeHtml(firstName)}</em>.`;
    subline = "Your FORGED Membership: twelve months, six working forces, one capstone. Let's begin.";
  }

  // ── Badges: base membership badge + milestone (if any) + champion at year-end ──
  const badgeList = [`<div class="badge">FORGED Member</div>`];
  if (milestone) badgeList.push(`<div class="badge">${milestone.label}</div>`);
  if (yearComplete) badgeList.push(`<div class="badge">Resilience Champion</div>`);
  const badges = badgeList.join("");

  const nextMilestone = monthsCompleted < 3 ? "3 Months Forged"
    : monthsCompleted < 6 ? "6 Months Forged"
    : monthsCompleted < 12 ? "12 Months Forged"
    : null;

  const badgeExplainer = yearComplete
    ? `<div class="badge-explainer"><strong>FORGED Member</strong> — your standing membership badge. <strong>Resilience Champion</strong> — earned by completing a full 12-month cycle. Two different claims: one says you belong, the other says you finished.</div>`
    : `<div class="badge-explainer"><strong>FORGED Member</strong> — your standing membership badge, active from day one.${milestone ? ` <strong>${milestone.label}</strong> — a consistency milestone earned along the way.` : ""}${nextMilestone ? ` Next milestone: <strong>${nextMilestone}</strong>.` : ""}</div>`;

  const statusNote = monthsCompleted > 0
    ? ""
    : `<div class="pending-note">Your first monthly reassessment hasn't landed yet. This view reflects your baseline — it will update automatically once Month 1 is complete.</div>`;

  const trendChip = improvement === null
    ? `<div class="trend-chip trend-chip--muted">Your growth story appears here after your first monthly reassessment</div>`
    : improvement >= 0
      ? `<div class="trend-chip trend-chip--up">▲ +${improvement}% — real, earned ground since your baseline</div>`
      : `<div class="trend-chip trend-chip--down">▼ ${improvement}% since baseline — this is exactly the data FORGED is built to work with</div>`;

  const ringsRow = `
    <div class="ring-row">
      ${progressRing({ pct: baselineOverall, label: "Baseline FRI", colorVar: "var(--gold)" })}
      ${progressRing({ pct: currentOverall, label: monthsCompleted > 0 ? `Month ${monthsCompleted} FRI` : "Current FRI (Pending)", colorVar: "var(--crimson)" })}
    </div>`;

  const radarSvg = buildHexRadar(dimensions, monthsCompleted > 0);

  const legendItems = dimensions.map((d) => {
    const pct = monthsCompleted > 0 && d.currentPct !== null ? d.currentPct : d.baselinePct;
    return `
      <div class="legend-item">
        <span class="legend-code">${d.letter}</span>
        <span class="legend-name">${escapeHtml(d.label)}<br><span class="legend-sub">${escapeHtml(d.sublabel)}</span></span>
        <span class="legend-score">${pct !== null ? pct + "%" : "—"}</span>
      </div>`;
  }).join("");

  const capstonePct = monthsCompleted > 0 && capstone.currentPct !== null ? capstone.currentPct : capstone.baselinePct;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>FORGED — ${escapeHtml(firstName)}'s Resilience Progress Dashboard</title>
<style>
  :root { --navy:#1C3557; --navy-deep:#122540; --crimson:#8B1A1A; --gold:#B8860B; --cream:#F7F5F0; --ink:#1A1A1A; --muted:#5B6472; --line:#E3DFD6; }
  * { box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent; }
  html { scroll-behavior:smooth; }
  body {
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Calibri',sans-serif;
    color:var(--ink); background:var(--cream); line-height:1.6; font-size:16px;
  }
  h1,h2,.serif-accent { font-family:Georgia,'Cambria',serif; }

  .beat { padding:34px 20px; max-width:520px; margin:0 auto; }
  .beat + .beat { border-top:1px solid var(--line); }

  .header { background:linear-gradient(135deg, var(--navy) 0%, var(--navy-deep) 100%); color:#EDEAE2; padding:44px 20px 36px; border-bottom:5px solid var(--gold); }
  .header-inner { max-width:520px; margin:0 auto; }
  .eyebrow { letter-spacing:2.5px; text-transform:uppercase; font-size:12px; color:var(--gold); font-weight:600; }
  .header h1 { font-size:30px; line-height:1.3; font-weight:400; margin-top:16px; }
  .header h1 em { font-style:italic; color:#D9C6A0; font-family:Georgia,serif; }
  .subline { font-size:15px; color:#C6CBD4; margin-top:10px; line-height:1.5; max-width:400px; }
  .badges { display:flex; gap:10px; margin-top:20px; flex-wrap:wrap; }
  .badge { background:var(--gold); color:var(--navy); font-size:13px; font-weight:700; padding:9px 16px; border-radius:20px; }
  .badge-explainer { font-size:13px; color:#C6CBD4; line-height:1.5; margin-top:14px; max-width:420px; }
  .badge-explainer strong { color:var(--gold); font-weight:700; }
  .pending-note { background:rgba(184,134,11,0.14); border-left:4px solid var(--gold); padding:14px 16px; font-size:13.5px; color:#E7DFCB; margin-top:18px; border-radius:0 4px 4px 0; }

  .beat-label { font-size:12px; letter-spacing:2px; text-transform:uppercase; color:var(--gold); font-weight:700; margin-bottom:18px; text-align:center; }

  /* Momentum beat — live engagement data, refreshed on every page view */
  .beat--momentum { background:#FCFAF5; }
  .momentum-row { display:flex; justify-content:center; gap:28px; flex-wrap:wrap; margin-bottom:20px; }
  .momentum-stat { text-align:center; }
  .momentum-stat .num { font-size:30px; font-family:Georgia,serif; color:var(--navy); font-weight:700; line-height:1; }
  .momentum-stat .num small { font-size:14px; font-weight:600; color:var(--muted); }
  .momentum-stat .cap { font-size:11px; letter-spacing:1px; text-transform:uppercase; color:var(--muted); margin-top:6px; }
  .letter-dots { display:flex; justify-content:center; gap:10px; margin-bottom:14px; }
  .letter-dot { width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:800; font-family:Georgia,serif; border:2px solid var(--line); color:var(--muted); background:#fff; }
  .letter-dot--on { background:var(--crimson); border-color:var(--crimson); color:#fff; }
  .momentum-caption { text-align:center; font-size:12.5px; color:var(--muted); }
  .momentum-unavailable { text-align:center; font-size:13px; color:var(--muted); font-style:italic; }

  .ring-row { display:flex; justify-content:center; gap:28px; flex-wrap:wrap; }
  .ring-wrap { display:flex; flex-direction:column; align-items:center; gap:10px; }
  .ring-label { font-size:13px; font-weight:600; color:var(--navy); text-align:center; }
  .trend-chip { display:block; text-align:center; margin:22px auto 0; padding:10px 18px; border-radius:20px; font-size:14px; font-weight:700; max-width:340px; }
  .trend-chip--up { background:rgba(139,26,26,0.10); color:var(--crimson); }
  .trend-chip--down { background:rgba(28,53,87,0.08); color:var(--navy); }
  .trend-chip--muted { background:var(--line); color:var(--muted); font-weight:600; }

  .radar-wrap { display:flex; justify-content:center; }
  .legend-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px 14px; margin-top:22px; }
  .legend-item { display:flex; align-items:flex-start; gap:8px; background:#fff; border:1px solid var(--line); border-radius:6px; padding:10px 10px; }
  .legend-code { font-size:14px; font-weight:800; color:#fff; background:var(--crimson); border-radius:50%; width:22px; height:22px; flex-shrink:0; display:flex; align-items:center; justify-content:center; }
  .legend-name { font-size:12.5px; color:var(--ink); flex:1; line-height:1.3; font-weight:600; }
  .legend-sub { font-size:10.5px; color:var(--muted); font-weight:400; }
  .legend-score { font-size:12.5px; font-weight:700; color:var(--navy); }

  .capstone-card { background:linear-gradient(135deg, var(--navy) 0%, var(--navy-deep) 100%); color:#EDEAE2; border-radius:8px; padding:24px; margin-top:22px; text-align:center; }
  .capstone-card .tag { font-size:11px; letter-spacing:2px; text-transform:uppercase; color:var(--gold); font-weight:700; }
  .capstone-card .name { font-size:20px; font-family:Georgia,serif; margin-top:8px; }
  .capstone-card .sub { font-size:12.5px; color:#C6CBD4; margin-top:2px; }
  .capstone-card .score { font-size:36px; font-family:Georgia,serif; color:var(--gold); margin-top:12px; }

  .insight-card { background:#fff; border:1px solid var(--line); border-left:4px solid var(--gold); padding:20px; border-radius:6px; margin-bottom:14px; }
  .insight-card.foundation { border-left-color:var(--navy); }
  .insight-card .tag { font-size:11.5px; letter-spacing:1.5px; text-transform:uppercase; color:var(--crimson); font-weight:700; margin-bottom:8px; }
  .insight-card.foundation .tag { color:var(--navy); }
  .insight-card p { font-size:15px; color:var(--navy); }
  .cta { display:block; text-align:center; background:var(--gold); color:var(--navy); font-weight:700; font-size:15px; padding:18px 20px; border-radius:8px; margin-top:10px; text-decoration:none; box-shadow:0 4px 14px rgba(184,134,11,0.35); }

  .footer { text-align:center; padding:30px 20px; font-size:13px; color:var(--muted); }

  @media (max-width:380px) {
    .beat { padding:26px 16px; }
    .header h1 { font-size:25px; }
    .ring-row { gap:16px; }
    .legend-grid { grid-template-columns:1fr; }
  }
</style>
</head>
<body>
  <div class="header">
    <div class="header-inner">
      <div class="eyebrow">FORGED &nbsp;·&nbsp; Resilience Coaching Lab</div>
      <h1>${headline}</h1>
      <div class="subline">${subline}</div>
      <div class="badges">${badges}</div>
      ${badgeExplainer}
      ${statusNote}
    </div>
  </div>

  <div class="beat beat--momentum">
    <div class="beat-label">This Month, Live</div>
    <!--MOMENTUM_SLOT-->
  </div>

  <div class="beat">
    <div class="beat-label">Your Current State</div>
    ${ringsRow}
    ${trendChip}
  </div>

  <div class="beat">
    <div class="beat-label">Your Six Forces — F.O.R.G.E.D.</div>
    <div class="radar-wrap">${radarSvg}</div>
    <div class="legend-grid">${legendItems}</div>

    <div class="capstone-card">
      <div class="tag">The Capstone</div>
      <div class="name">The Forged Self</div>
      <div class="sub">Identity Stability — what these six forces build together</div>
      <div class="score">${capstonePct !== null ? capstonePct + "%" : "—"}</div>
    </div>
  </div>

  <div class="beat">
    <div class="beat-label">Where To Focus Next</div>
    <div class="insight-card">
      <div class="tag">Primary Growth Dimension</div>
      <p>${growthDimension ? escapeHtml(growthDimension.label) : "Not yet assessed"} — this is where your next chapter of development lives.</p>
    </div>
    <div class="insight-card foundation">
      <div class="tag">Foundation Strength</div>
      <p>${foundationStrength ? escapeHtml(foundationStrength.label) : "Not yet assessed"} — build from here as you go deeper.</p>
    </div>
    <a class="cta" href="https://wa.me/264817451505" target="_blank" rel="noopener">Continue on WhatsApp with Coach Orange</a>
  </div>

  <div class="footer">FORGED — Resilience Coaching Lab &nbsp;·&nbsp; A programme of Change Experience Consulting (CXC)</div>
</body>
</html>`;
}

/**
 * Circular progress ring (SVG, no client-side JS). Used for the Baseline
 * / current-month FRI headline scores.
 */
function progressRing({ pct, label, colorVar, size = 128, strokeWidth = 12 }) {
  const displayPct = pct !== null && pct !== undefined ? pct : null;
  const r = (size - strokeWidth) / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  const fraction = displayPct !== null ? displayPct / 100 : 0;
  const offset = circumference * (1 - fraction);
  const centerText = displayPct !== null ? `${displayPct}%` : "—";

  return `
  <div class="ring-wrap">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${strokeWidth}" />
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${colorVar}" stroke-width="${strokeWidth}"
        stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"
        transform="rotate(-90 ${c} ${c})" />
      <text x="${c}" y="${c - 3}" text-anchor="middle" font-size="${Math.round(size * 0.21)}" font-family="Georgia, serif" fill="var(--ink)" font-weight="700">${escapeHtml(centerText)}</text>
      <text x="${c}" y="${c + 17}" text-anchor="middle" font-size="10.5" fill="var(--muted)" letter-spacing="1.5" font-family="-apple-system,Segoe UI,sans-serif">FRI</text>
    </svg>
    <div class="ring-label">${escapeHtml(label)}</div>
  </div>`;
}

/**
 * Six-axis (hexagon) radar chart for the FORGED working forces — one
 * fewer axis than the old seven-dimension version, since Identity
 * Stability is now rendered separately as the capstone card, not a
 * radar axis. Entirely server-side SVG, no charting library.
 */
function buildHexRadar(dimensions, hasCurrentMonth, size = 260) {
  const n = dimensions.length; // 6
  const center = size / 2;
  const maxR = size / 2 - 38;
  const angleStep = (2 * Math.PI) / n;
  const startAngle = -Math.PI / 2;

  const pointAt = (i, r) => {
    const angle = startAngle + i * angleStep;
    return [center + r * Math.cos(angle), center + r * Math.sin(angle)];
  };

  const gridPolys = [0.33, 0.66, 1].map((level) => {
    const pts = Array.from({ length: n }, (_, i) => pointAt(i, maxR * level).join(",")).join(" ");
    return `<polygon points="${pts}" fill="none" stroke="var(--line)" stroke-width="1" />`;
  }).join("");

  const spokes = Array.from({ length: n }, (_, i) => {
    const [x, y] = pointAt(i, maxR);
    return `<line x1="${center}" y1="${center}" x2="${x}" y2="${y}" stroke="var(--line)" stroke-width="1" />`;
  }).join("");

  const values = dimensions.map((d) => {
    const pct = hasCurrentMonth && d.currentPct !== null ? d.currentPct : d.baselinePct;
    return pct !== null ? pct : 0;
  });

  const dataPts = values.map((v, i) => pointAt(i, maxR * (v / 100)).join(",")).join(" ");
  const dataPolygon = `<polygon points="${dataPts}" fill="rgba(139,26,26,0.25)" stroke="var(--crimson)" stroke-width="2.5" stroke-linejoin="round" />`;

  const dotsAndLabels = values.map((v, i) => {
    const [dx, dy] = pointAt(i, maxR * (v / 100));
    const [lx, ly] = pointAt(i, maxR + 22);
    return `<circle cx="${dx}" cy="${dy}" r="4.5" fill="var(--crimson)" stroke="#fff" stroke-width="1.5" />
      <circle cx="${lx}" cy="${ly}" r="11" fill="var(--navy)" />
      <text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="central" font-size="12" font-weight="800" fill="#fff" font-family="Georgia,serif">${escapeHtml(dimensions[i].letter)}</text>`;
  }).join("");

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${gridPolys}${spokes}${dataPolygon}${dotsAndLabels}
  </svg>`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
