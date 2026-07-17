/**
 * FORGED — Team Pulse Submission Handler (Revision 1)
 * Netlify Function (HTTP endpoint, POST) — receives a completed Team
 * Pulse survey, writes it to Airtable, computes the respondent's own
 * Resilience (FRI) and Engagement (FEI) scores, and returns their
 * personal results page directly in the same request/response cycle.
 *
 * ── WHY THIS RETURNS HTML DIRECTLY, NOT A REDIRECT ─────────────────────
 * The original design (Airtable native Form) couldn't deliver a
 * personal dashboard on completion at all — a gap surfaced in this
 * session's pressure test. Returning the rendered results directly here
 * is the simplest fix: no second request, no redirect, no dependency on
 * email deliverability. The results are ALSO stored to Netlify Blobs
 * under a securely random slug, so the respondent can bookmark and
 * revisit later — but immediate display doesn't depend on that step
 * succeeding.
 *
 * ── SECURITY ────────────────────────────────────────────────────────
 * Slugs use crypto.randomBytes, the same fix applied to
 * forged-daily-nudge.mjs earlier this session — not a slice of a
 * non-random ID. This data includes psychological-safety and engagement
 * responses; the same entropy standard applies here as there.
 *
 * ── WHAT LEADERSHIP NEVER SEES ─────────────────────────────────────────
 * This function writes identified, individual-level responses to
 * Airtable for the aggregation step (still to be built) to consume —
 * but nothing in this function, or in what it returns to the browser,
 * exposes one respondent's answers to anyone but that respondent. The
 * employer-facing Team Map and Growth Plan are generated separately,
 * from aggregated data only, per the anonymisation design agreed this
 * session.
 *
 * Deploy at: netlify/functions/forged-teampulse-submit.mjs
 */

import { randomBytes } from "node:crypto";
import { getStore } from "@netlify/blobs";

const AIRTABLE_BASE  = process.env.AIRTABLE_BASE_ID || "app1W8ijaU1gfc9nX";
const RESPONSES_TBL  = process.env.TEAMPULSE_RESPONSES_TABLE_ID || ""; // TODO: set once the table exists
const AIRTABLE_KEY    = process.env.AIRTABLE_API_KEY;
const SCALE_MAX = 5;

const FORCES = [
  { key: "focus",      letter: "F", label: "Focus" },
  { key: "others",     letter: "O", label: "Others" },
  { key: "regulation", letter: "R", label: "Regulation" },
  { key: "grit",       letter: "G", label: "Grit" },
  { key: "energy",     letter: "E", label: "Energy" },
  { key: "direction",  letter: "D", label: "Direction" },
];

export default async function handler(req) {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const { engagement, name, answers } = body || {};
  if (!engagement || !name || !answers) {
    return json({ error: "Missing required fields" }, 400);
  }

  // Validate every expected item is present and in range — reject rather
  // than silently defaulting, since defaulted answers would corrupt the
  // aggregate data leadership eventually sees.
  for (const f of FORCES) {
    for (const prefix of ["fri_", "fei_"]) {
      const v = answers[prefix + f.key];
      if (typeof v !== "number" || v < 1 || v > 5) {
        return json({ error: `Missing or invalid answer for ${prefix}${f.key}` }, 400);
      }
    }
  }

  try {
    // 1. Write the identified response to Airtable, for the (separately
    //    built) aggregation step to consume. Wrapped in its own
    //    try/catch — a thrown network error must be exactly as non-fatal
    //    as a non-ok HTTP response; either way, the respondent should
    //    still see their own results.
    if (AIRTABLE_KEY && RESPONSES_TBL) {
      const fields = {
        "Engagement ID": engagement,
        "Respondent Name": name,
        "Submitted At": new Date().toISOString(),
      };
      for (const f of FORCES) {
        fields[`${f.label} (FRI)`] = answers[`fri_${f.key}`];
        fields[`${f.label} (FEI)`] = answers[`fei_${f.key}`];
      }

      try {
        const airtableRes = await fetch(
          `https://api.airtable.com/v0/${AIRTABLE_BASE}/${RESPONSES_TBL}`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ fields }),
          }
        );
        if (!airtableRes.ok) {
          console.error(`[Team Pulse] Airtable write failed (non-ok response): ${await airtableRes.text()}`);
        }
      } catch (err) {
        console.error(`[Team Pulse] Airtable write threw (non-fatal, respondent still sees results): ${err.message}`);
      }
    } else {
      console.warn("[Team Pulse] AIRTABLE_KEY or TEAMPULSE_RESPONSES_TABLE_ID not set — response not persisted.");
    }

    // 2. Compute this respondent's own FRI and FEI scores.
    const friScores = {};
    const feiScores = {};
    for (const f of FORCES) {
      friScores[f.key] = toPercent(answers[`fri_${f.key}`]);
      feiScores[f.key] = toPercent(answers[`fei_${f.key}`]);
    }
    const friOverall = Math.round(average(Object.values(friScores)));
    const feiOverall = Math.round(average(Object.values(feiScores)));

    // 3. Render personal results and store under a secure random slug —
    //    this is the ONLY copy of the results with a real, bookmarkable
    //    URL. A prior version returned this HTML directly for inline
    //    display, which left the browser's address bar on the survey
    //    form's URL — confirmed live in testing to make the page's own
    //    "bookmark this page" instruction false. Now: redirect to the
    //    stored slug's real URL whenever storage succeeds, so the URL
    //    the respondent ends up on is the one that actually reloads
    //    their results later.
    const slug = `${slugifyName(name)}-${randomBytes(12).toString("hex")}`;
    const html = renderResultsHtml({ name, friScores, feiScores, friOverall, feiOverall, slug });

    let stored = false;
    try {
      const store = getStore("forged-teampulse-results");
      await store.set(slug, html);
      stored = true;
    } catch (err) {
      console.error(`[Team Pulse] Blob storage failed (non-fatal — falling back to inline display, no bookmarkable link this time): ${err.message}`);
    }

    if (stored) {
      return json({ success: true, resultsUrl: `/.netlify/functions/forged-teampulse-view?slug=${encodeURIComponent(slug)}` });
    }
    // Fallback: storage failed, so there's no slug to redirect to —
    // show results inline this one time rather than lose them entirely.
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  } catch (err) {
    console.error(`[Team Pulse] Unexpected error: ${err.message}`);
    return json({ error: "Something went wrong processing your response." }, 500);
  }
}

function toPercent(raw) {
  return Math.max(0, Math.min(100, Math.round((raw / SCALE_MAX) * 100)));
}

function average(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function slugifyName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "respondent";
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Personal results page — deliberately distinct from the 12-month
 * membership dashboard template. A Team Pulse respondent isn't a
 * subscriber; the framing, copy, and layout reflect a one-time personal
 * takeaway, not an ongoing coaching relationship.
 */
// Deterministic FRI/FEI gap analysis — no AI call needed at the
// individual level, since this is pure per-force comparison arithmetic.
// Priority ordering matches the manually-validated commentary pattern:
// ties broken by whichever score is more concerning in absolute terms
// (lower resilience for "exposed," lower engagement for "unrecognised"),
// not just gap size alone.
const GAP_THRESHOLD = 20;

function analysePattern(friScores, feiScores) {
  const gaps = FORCES.map((f) => ({
    ...f,
    fri: friScores[f.key],
    fei: feiScores[f.key],
    gap: feiScores[f.key] - friScores[f.key],
  }));
  const exposed = gaps.filter((g) => g.gap >= GAP_THRESHOLD)
    .sort((a, b) => b.gap - a.gap || a.fri - b.fri);
  const unrecognised = gaps.filter((g) => g.gap <= -GAP_THRESHOLD)
    .sort((a, b) => a.gap - b.gap || a.fei - b.fei);
  return { exposed, unrecognised };
}

function renderCommentary(friScores, feiScores) {
  const { exposed, unrecognised } = analysePattern(friScores, feiScores);

  if (exposed.length === 0 && unrecognised.length === 0) {
    return `<p class="commentary-line">Your resilience and engagement scores move together across all six forces \u2014 no force stands out as a gap to prioritise right now.</p>`;
  }

  const lines = [];

  exposed.forEach((g, i) => {
    const opener = i === 0 ? `<strong>${escapeHtml(g.label)}</strong> is the one to watch.` : `<strong>${escapeHtml(g.label)}</strong> shows a milder version of the same shape.`;
    lines.push(`<p class="commentary-line">${opener} At ${g.fri}% resilience but ${g.fei}% engagement, this is a "motivated but exposed" pattern \u2014 real pull toward this area, with less capacity underneath it than the engagement score alone would suggest.</p>`);
  });

  unrecognised.forEach((g, i) => {
    const opener = i === 0 ? `<strong>${escapeHtml(g.label)}</strong> runs the opposite way.` : `<strong>${escapeHtml(g.label)}</strong> shows the same inverse pattern.`;
    lines.push(`<p class="commentary-line">${opener} ${g.fri}% resilience but only ${g.fei}% engagement \u2014 real capacity here that isn't yet showing up as a felt sense of support or recognition day to day.</p>`);
  });

  if (exposed.length > 0) {
    lines.push(`<p class="commentary-line summary">In short: the risk here isn't a lack of resilience overall \u2014 it's concentrated specifically where engagement is outrunning it, starting with ${escapeHtml(exposed[0].label)}.</p>`);
  }

  return lines.join("");
}

function renderResultsHtml({ name, friScores, feiScores, friOverall, feiOverall, slug }) {
  const firstName = String(name).split(" ")[0];
  const radarSvg = buildDualRadar(friScores, feiScores);

  const legendItems = FORCES.map((f) => `
    <div class="legend-item">
      <span class="legend-code">${f.letter}</span>
      <span class="legend-name">${escapeHtml(f.label)}</span>
      <span class="legend-scores"><span class="fri-tag">${friScores[f.key]}%</span><span class="fei-tag">${feiScores[f.key]}%</span></span>
    </div>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Your FORGED Team Pulse Results</title>
<style>
  :root { --navy:#1C3557; --navy-deep:#122540; --crimson:#8B1A1A; --gold:#B8860B; --cream:#F7F5F0; --ink:#1A1A1A; --muted:#5B6472; --line:#E3DFD6; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Calibri',sans-serif; color:var(--ink); background:var(--cream); line-height:1.6; }
  h1,.serif { font-family:Georgia,'Cambria',serif; }
  .header { background:linear-gradient(135deg, var(--navy) 0%, var(--navy-deep) 100%); color:#EDEAE2; padding:40px 20px 32px; border-bottom:5px solid var(--gold); text-align:center; }
  .eyebrow { letter-spacing:2.5px; text-transform:uppercase; font-size:12px; color:var(--gold); font-weight:700; }
  .header h1 { font-size:28px; font-weight:400; margin-top:14px; }
  .header h1 em { font-style:italic; color:#D9C6A0; font-family:Georgia,serif; }
  .beat { padding:32px 20px; max-width:520px; margin:0 auto; }
  .ring-row { display:flex; justify-content:center; gap:28px; flex-wrap:wrap; }
  .ring-wrap { display:flex; flex-direction:column; align-items:center; gap:10px; }
  .ring-label { font-size:13px; font-weight:600; color:var(--navy); }
  .beat-label { font-size:12px; letter-spacing:2px; text-transform:uppercase; color:var(--gold); font-weight:700; margin-bottom:18px; text-align:center; }
  .radar-wrap { display:flex; justify-content:center; }
  .radar-key { display:flex; justify-content:center; gap:20px; margin-top:10px; font-size:12px; }
  .key-gold { color:var(--gold); font-weight:700; } .key-crimson { color:var(--crimson); font-weight:700; }
  .legend-grid { margin-top:22px; }
  .legend-item { display:flex; align-items:center; gap:10px; background:#fff; border:1px solid var(--line); border-radius:6px; padding:10px 14px; margin-bottom:8px; }
  .legend-code { width:26px; height:26px; border-radius:50%; background:var(--navy); color:#fff; font-weight:800; font-family:Georgia,serif; display:flex; align-items:center; justify-content:center; font-size:13px; flex-shrink:0; }
  .legend-name { flex:1; font-size:14px; font-weight:600; }
  .legend-scores { display:flex; gap:8px; }
  .fri-tag { background:rgba(184,134,11,0.15); color:#8a660c; padding:3px 8px; border-radius:10px; font-size:12px; font-weight:700; }
  .fei-tag { background:rgba(139,26,26,0.12); color:var(--crimson); padding:3px 8px; border-radius:10px; font-size:12px; font-weight:700; }
  .save-note { text-align:center; background:#fff; border:1px dashed var(--line); border-radius:8px; padding:16px; font-size:13px; color:var(--muted); }
  .commentary-line { background:#fff; border:1px solid var(--line); border-left:4px solid var(--gold); border-radius:0 8px 8px 0; padding:16px 18px; margin-bottom:12px; font-size:14.5px; color:var(--ink); line-height:1.6; }
  .commentary-line strong { color:var(--navy); }
  .commentary-line.summary { border-left-color:var(--crimson); background:rgba(139,26,26,0.04); font-style:italic; color:var(--navy); }
  .footer { text-align:center; padding:30px 20px; font-size:13px; color:var(--muted); }
</style>
</head>
<body>
  <div class="header">
    <div class="eyebrow">FORGED &nbsp;·&nbsp; Team Pulse</div>
    <h1>Thank you, <em>${escapeHtml(firstName)}</em>.</h1>
  </div>

  <div class="beat">
    <div class="beat-label">Your Results</div>
    <div class="ring-row">
      ${ringHtml(friOverall, "Resilience (FRI)", "var(--gold)")}
      ${ringHtml(feiOverall, "Engagement (FEI)", "var(--crimson)")}
    </div>
  </div>

  <div class="beat">
    <div class="beat-label">Your Six Forces</div>
    <div class="radar-wrap">${radarSvg}</div>
    <div class="radar-key"><span class="key-gold">\u25CF Resilience</span><span class="key-crimson">\u25CF Engagement</span></div>
    <div class="legend-grid">${legendItems}</div>
  </div>

  <div class="beat">
    <div class="beat-label">What This Means</div>
    ${renderCommentary(friScores, feiScores)}
  </div>

  <div class="beat">
    <div class="save-note">Your results are saved. Bookmark this page to revisit them anytime.</div>
  </div>

  <div class="footer">FORGED Resilience Coaching Lab &nbsp;·&nbsp; Change Experience Consulting (CXC)<br/>Your individual answers are never shared with your employer \u2014 only anonymised, team-level results.</div>
</body>
</html>`;
}

// Renders one circular progress ring as inline SVG.
function ringHtml(pct, label, colorVar, size = 128, strokeWidth = 12) {
  const r = (size - strokeWidth) / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - pct / 100);
  return `
  <div class="ring-wrap">
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${strokeWidth}" />
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${colorVar}" stroke-width="${strokeWidth}"
        stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"
        transform="rotate(-90 ${c} ${c})"" />
      <text x="${c}" y="${c - 3}" text-anchor="middle" font-size="${Math.round(size * 0.21)}" font-family="Georgia, serif" fill="var(--ink)" font-weight="700">${pct}%</text>
    </svg>
    <div class="ring-label">${escapeHtml(label)}</div>
  </div>`;
}

function buildDualRadar(friScores, feiScores, size = 260) {
  const n = FORCES.length;
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

  const friPts = FORCES.map((f, i) => pointAt(i, maxR * (friScores[f.key] / 100)).join(",")).join(" ");
  const feiPts = FORCES.map((f, i) => pointAt(i, maxR * (feiScores[f.key] / 100)).join(",")).join(" ");

  const friPolygon = `<polygon points="${friPts}" fill="rgba(184,134,11,0.20)" stroke="var(--gold)" stroke-width="2.5" stroke-linejoin="round" />`;
  const feiPolygon = `<polygon points="${feiPts}" fill="rgba(139,26,26,0.15)" stroke="var(--crimson)" stroke-width="2.5" stroke-linejoin="round" stroke-dasharray="5,3" />`;

  const labels = FORCES.map((f, i) => {
    const [lx, ly] = pointAt(i, maxR + 22);
    return `<circle cx="${lx}" cy="${ly}" r="11" fill="var(--navy)" />
      <text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="central" font-size="12" font-weight="800" fill="#fff" font-family="Georgia,serif">${f.letter}</text>`;
  }).join("");

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${gridPolys}${spokes}${friPolygon}${feiPolygon}${labels}
  </svg>`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
