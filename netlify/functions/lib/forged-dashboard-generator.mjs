/**
 * FORGED — Day 21 Dashboard Generator
 * Module (not a standalone Netlify function) — imported by
 * forged-daily-nudge.mjs and called once per subscriber when day === 21.
 *
 * Builds a personalised version of the Day 21 Progress Dashboard HTML
 * template, substituting real subscriber data for the placeholder
 * values, and stores it via Netlify Blobs under a unique slug. The
 * generated dashboard is then served publicly by
 * forged-dashboard-view.mjs at /dashboard/{slug}.
 *
 * Deploy at: netlify/functions/lib/forged-dashboard-generator.mjs
 * (a non-scheduled helper module, imported by other functions —
 *  Netlify will not treat this as its own endpoint since it has
 *  no exported `handler` or `config`)
 *
 * Requires: @netlify/blobs (already available in Netlify's runtime,
 * no separate npm install needed for Netlify Functions v2)
 */

import { getStore } from "@netlify/blobs";

const RCI_COLOURS = {
  green: "#1A6B3C",
  amber: "#92600A",
  red:   "#8B1A1A",
};

function ragColour(score) {
  if (score >= 4) return RCI_COLOURS.green;
  if (score === 3) return RCI_COLOURS.amber;
  return RCI_COLOURS.red;
}

function deltaBadge(before, after) {
  const diff = after - before;
  if (diff > 0) return { cls: "up", label: `+${diff}` };
  if (diff < 0) return { cls: "down", label: `${diff}` };
  return { cls: "flat", label: "steady" };
}

function calculateFriScore(dimensions) {
  // Simple average-to-100-scale conversion, consistent with the
  // 74/100 example used throughout the confirmed templates this session.
  const values = Object.values(dimensions);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.round((avg / 5) * 100);
}

function buildComparisonRows(day1, day21) {
  const dims = [
    "Cognitive Flexibility",
    "Emotional Regulation",
    "Adaptive Coping",
    "Physical Vitality",
    "Identity Stability",
    "Social Support",
    "Purpose & Meaning",
  ];

  return dims.map(dim => {
    const before = day1[dim] ?? 3;
    const after  = day21[dim] ?? before;
    const delta  = deltaBadge(before, after);
    const star   = dim === findPrimaryGrowthDimension(day1) ? " ★" : "";

    return `
      <div class="compare-row">
        <div class="compare-name">${dim}${star}</div>
        <div class="compare-before">${before}/5</div>
        <div class="compare-arrow">→</div>
        <div class="compare-after">${after}/5</div>
        <div class="compare-delta ${delta.cls}">${delta.label}</div>
      </div>`;
  }).join("\n");
}

function findPrimaryGrowthDimension(day1Scores) {
  let lowest = Infinity, dim = "Cognitive Flexibility";
  for (const [d, s] of Object.entries(day1Scores)) {
    if (s < lowest) { lowest = s; dim = d; }
  }
  return dim;
}

function buildJournalEntries(entries) {
  if (!entries || entries.length === 0) {
    return `<div class="journal-entry"><div class="journal-text">No reflections were logged this round — that's alright. The dashboard above still reflects your real movement.</div></div>`;
  }
  // Show up to 3, prioritising spread across the 21 days
  return entries.slice(0, 3).map(e => `
    <div class="journal-entry">
      <div class="journal-day">DAY ${e.day} · ${(e.dimension || "").toUpperCase()}</div>
      <div class="journal-text">"${e.text}"</div>
    </div>`).join("\n");
}

/**
 * Generates and stores the Day 21 dashboard for one subscriber.
 *
 * @param {object} params
 * @param {string} params.name - Subscriber's display name
 * @param {string} params.organisation - Subscriber's organisation (or "Sample Organisation" fallback)
 * @param {string} params.jobTitle - Subscriber's job title (or "Senior Leader" fallback)
 * @param {object} params.day1Scores - { "Cognitive Flexibility": 2, ... } — 7 dimensions
 * @param {object} params.day21Scores - same shape, from re-assessment
 * @param {number} params.nudgesEngaged - count out of 21
 * @param {number} params.journalCount - count of reflections logged
 * @param {number} params.callsCompleted - 0, 1, or 2
 * @param {Array}  params.journalEntries - [{ day, dimension, text }, ...]
 * @param {string} params.recordId - Airtable record ID, used to build the slug
 * @returns {Promise<string>} the public dashboard URL
 */
export async function generateAndStoreDay21Dashboard(params) {
  const {
    name, organisation, jobTitle,
    day1Scores, day21Scores,
    nudgesEngaged, journalCount, callsCompleted,
    journalEntries, recordId,
  } = params;

  const friBefore = calculateFriScore(day1Scores);
  const friAfter  = calculateFriScore(day21Scores);
  const consistencyPct = Math.round((nudgesEngaged / 21) * 100);
  const primaryDim = findPrimaryGrowthDimension(day1Scores);
  const role = jobTitle && organisation
    ? `${jobTitle} · ${organisation}`
    : organisation
    ? `Senior Leader · ${organisation}`
    : `Senior Leader · across Africa`;

  const day1Order = ["Identity Stability","Social Support","Purpose & Meaning","Emotional Regulation","Adaptive Coping","Physical Vitality","Cognitive Flexibility"];
  const day1Data  = day1Order.map(d => day1Scores[d] ?? 3);
  const day21Data = day1Order.map(d => day21Scores[d] ?? day1Scores[d] ?? 3);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Your Resilience Dashboard — ${name} — Day 21</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;1,400&family=DM+Sans:wght@300;400;500;600&family=DM+Mono&display=swap" rel="stylesheet" />
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"></script>
<style>
  :root {
    --crimson: #8B1A1A; --crimson-mid: #A52020; --crimson-light:#F5E8E8;
    --navy: #1C3557; --navy-mid: #264873; --navy-light: #E8EEF5;
    --gold: #B8860B; --gold-light: #FDF3DC;
    --black: #0D0D0D; --charcoal: #1A1A1A; --mid: #4A4A4A; --muted: #767676;
    --border: #E0E0E0; --bg: #F7F5F2; --white: #FFFFFF;
    --green: #1A6B3C; --green-bg: #E8F5EE; --amber: #92600A; --amber-bg: #FEF3DC;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); font-family: 'DM Sans', sans-serif; font-size: 15px; color: var(--charcoal); line-height: 1.6; }
  .page { max-width: 820px; margin: 0 auto; background: var(--white); }
  .header { background: var(--charcoal); padding: 32px 48px 28px; position: relative; overflow: hidden; }
  .header::before { content: ''; position: absolute; top: 0; left: 0; width: 6px; height: 100%; background: var(--gold); }
  .header-brand { font-family: 'DM Mono', monospace; font-size: 11px; letter-spacing: 0.18em; color: var(--gold); text-transform: uppercase; margin-bottom: 18px; }
  .header-title { font-family: 'Playfair Display', serif; font-size: 32px; font-weight: 400; color: var(--white); line-height: 1.2; margin-bottom: 6px; }
  .header-title em { font-style: italic; color: #C8A882; }
  .header-sub { font-size: 13px; color: #9A9A9A; }
  .header-meta { position: absolute; top: 40px; right: 48px; text-align: right; }
  .header-meta .day-badge { font-family: 'DM Mono', monospace; font-size: 11px; color: var(--gold); letter-spacing: 0.1em; background: rgba(184,134,11,0.15); border: 1px solid rgba(184,134,11,0.3); padding: 6px 14px; border-radius: 20px; }
  .identity-strip { background: linear-gradient(135deg, var(--navy) 0%, var(--navy-mid) 100%); padding: 28px 48px; display: flex; align-items: center; justify-content: space-between; }
  .identity-name { font-family: 'Playfair Display', serif; font-size: 22px; font-weight: 600; color: var(--white); margin-bottom: 4px; }
  .identity-role { font-size: 13px; color: #9BB5D4; margin-bottom: 10px; }
  .earned-titles { display: flex; gap: 8px; flex-wrap: wrap; }
  .earned-title-badge { background: rgba(184,134,11,0.2); border: 1px solid rgba(184,134,11,0.5); color: var(--gold-light); font-size: 11px; font-family: 'DM Mono', monospace; padding: 4px 11px; border-radius: 20px; letter-spacing: 0.04em; }
  .streak-display { text-align: right; }
  .streak-flame { font-size: 28px; }
  .streak-label { font-size: 11px; color: #9BB5D4; letter-spacing: 0.08em; text-transform: uppercase; margin-top: 4px; }
  .welcome { padding: 30px 48px; background: var(--gold-light); border-left: 4px solid var(--gold); }
  .welcome p { font-family: 'Playfair Display', serif; font-size: 17px; color: var(--navy); line-height: 1.7; font-style: italic; text-align: justify; hyphens: auto; }
  .welcome-attr { margin-top: 14px; font-size: 12px; color: var(--navy-mid); font-family: 'DM Mono', monospace; letter-spacing: 0.06em; }
  .section { padding: 30px 48px; border-bottom: 1px solid var(--border); }
  .section:last-child { border-bottom: none; }
  .section-label { font-family: 'DM Mono', monospace; font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase; color: var(--muted); margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
  .consistency-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 26px; }
  .consistency-card { background: var(--bg); border-radius: 6px; padding: 16px 10px; text-align: center; }
  .consistency-value { font-family: 'Playfair Display', serif; font-size: 26px; font-weight: 600; color: var(--navy); line-height: 1; }
  .consistency-value.gold { color: var(--gold); }
  .consistency-label { font-size: 10px; color: var(--muted); margin-top: 6px; line-height: 1.3; }
  .radar-wrap { display: flex; align-items: center; gap: 40px; margin-bottom: 20px; }
  .radar-canvas-wrap { flex: 0 0 280px; width: 100%; max-width: 280px; height: 280px; margin: 0 auto; }
  .radar-legend-title { font-family: 'Playfair Display', serif; font-size: 18px; color: var(--navy); margin-bottom: 6px; }
  .radar-legend-sub { font-size: 13px; color: var(--muted); line-height: 1.5; text-align: justify; hyphens: auto; margin-bottom: 14px; }
  .radar-key { display: flex; gap: 18px; }
  .radar-key-item { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--mid); }
  .radar-key-swatch { width: 14px; height: 3px; border-radius: 2px; }
  .radar-key-swatch.before { background: var(--muted); }
  .radar-key-swatch.after { background: var(--gold); }
  .compare-grid { display: grid; grid-template-columns: 1fr; gap: 8px; }
  .compare-row { display: grid; grid-template-columns: 1.4fr 70px 24px 70px 90px; align-items: center; gap: 10px; padding: 10px 14px; border: 1px solid var(--border); border-radius: 6px; }
  .compare-name { font-size: 12px; font-weight: 600; color: var(--navy); }
  .compare-before, .compare-after { font-family: 'Playfair Display', serif; font-size: 16px; font-weight: 600; text-align: center; }
  .compare-before { color: var(--muted); }
  .compare-after { color: var(--gold); }
  .compare-arrow { text-align: center; color: var(--muted); font-size: 14px; }
  .compare-delta { font-family: 'DM Mono', monospace; font-size: 11px; text-align: right; padding: 3px 8px; border-radius: 3px; font-weight: 500; }
  .compare-delta.up { background: var(--green-bg); color: var(--green); }
  .compare-delta.down { background: var(--crimson-light); color: var(--crimson); }
  .compare-delta.flat { background: var(--bg); color: var(--muted); }
  .revelation-panel { background: var(--navy-light); border-left: 4px solid var(--navy); border-radius: 0 6px 6px 0; padding: 24px 28px; }
  .revelation-label { font-family: 'DM Mono', monospace; font-size: 10px; letter-spacing: 0.15em; color: var(--navy); text-transform: uppercase; margin-bottom: 10px; }
  .revelation-text { font-size: 14px; color: var(--navy); line-height: 1.8; font-family: 'Playfair Display', serif; font-style: italic; text-align: justify; hyphens: auto; }
  .gap-panel { background: var(--crimson-light); border: 1px solid #D4A0A0; border-radius: 6px; padding: 24px 28px; }
  .gap-label { font-family: 'DM Mono', monospace; font-size: 10px; letter-spacing: 0.15em; color: var(--crimson); text-transform: uppercase; margin-bottom: 10px; }
  .gap-title { font-family: 'Playfair Display', serif; font-size: 19px; color: var(--crimson); margin-bottom: 10px; }
  .gap-text { font-size: 13px; color: var(--mid); line-height: 1.7; text-align: justify; hyphens: auto; }
  .journal-entry { border: 1px solid var(--border); border-radius: 6px; padding: 16px 18px; margin-bottom: 10px; }
  .journal-entry:last-child { margin-bottom: 0; }
  .journal-day { font-family: 'DM Mono', monospace; font-size: 10px; color: var(--gold); letter-spacing: 0.08em; margin-bottom: 6px; }
  .journal-text { font-size: 13px; color: var(--navy); font-style: italic; line-height: 1.6; }
  .invite-section { background: var(--charcoal); padding: 40px 48px; position: relative; overflow: hidden; }
  .invite-section::before { content: ''; position: absolute; top: 0; left: 0; width: 6px; height: 100%; background: var(--crimson); }
  .invite-eyebrow { font-family: 'DM Mono', monospace; font-size: 10px; letter-spacing: 0.18em; color: var(--crimson-mid); text-transform: uppercase; margin-bottom: 14px; }
  .invite-title { font-family: 'Playfair Display', serif; font-size: 26px; color: var(--white); margin-bottom: 12px; line-height: 1.3; }
  .invite-title em { font-style: italic; color: #E8A0A0; }
  .invite-body { font-size: 14px; color: #B0B0B0; line-height: 1.7; margin-bottom: 20px; text-align: justify; hyphens: auto; }
  .invite-quote { font-family: 'Playfair Display', serif; font-size: 15px; font-style: italic; color: #E8A0A0; line-height: 1.7; margin-bottom: 24px; padding-left: 16px; border-left: 2px solid var(--crimson); text-align: justify; hyphens: auto; }
  .invite-scarcity { display: flex; gap: 24px; margin-bottom: 24px; }
  .invite-scarcity-value { font-family: 'Playfair Display', serif; font-size: 20px; color: var(--white); font-weight: 600; }
  .invite-scarcity-label { font-size: 11px; color: #888; margin-top: 2px; }
  .invite-button { display: inline-block; background: var(--crimson); color: var(--white); font-size: 14px; font-weight: 600; padding: 14px 32px; border-radius: 4px; text-decoration: none; letter-spacing: 0.04em; margin-right: 14px; }
  .invite-button-secondary { display: inline-block; color: #9A9A9A; font-size: 13px; text-decoration: none; border-bottom: 1px solid #555; padding-bottom: 2px; }
  .invite-pricing { margin-top: 18px; font-family: 'DM Mono', monospace; font-size: 11px; color: #666; letter-spacing: 0.06em; }
  .signoff { padding: 32px 48px; border-top: 1px solid var(--border); display: flex; align-items: flex-start; gap: 20px; }
  .signoff-avatar { width: 52px; height: 52px; border-radius: 50%; background: var(--navy); display: flex; align-items: center; justify-content: center; font-family: 'Playfair Display', serif; font-size: 18px; color: var(--white); flex-shrink: 0; font-weight: 600; }
  .signoff-message { font-family: 'Playfair Display', serif; font-size: 15px; font-style: italic; color: var(--navy); line-height: 1.7; margin-bottom: 12px; text-align: justify; hyphens: auto; }
  .signoff-name { font-size: 13px; font-weight: 600; color: var(--charcoal); margin-bottom: 2px; }
  .signoff-creds { font-size: 11px; color: var(--muted); font-family: 'DM Mono', monospace; line-height: 1.6; }
  .confidentiality { padding: 20px 48px; background: var(--bg); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
  .confidentiality-label { font-family: 'DM Mono', monospace; font-size: 9px; letter-spacing: 0.12em; color: var(--muted); text-transform: uppercase; margin-bottom: 8px; }
  .confidentiality-text { font-size: 11px; color: var(--mid); line-height: 1.6; text-align: justify; hyphens: auto; }
  .footer { background: var(--black); padding: 26px 48px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px; }
  .footer-brand { font-family: 'DM Mono', monospace; font-size: 11px; color: var(--gold); letter-spacing: 0.1em; }
  .footer-brand span { color: var(--gold); }
  .footer-tagline { font-family: 'Playfair Display', serif; font-size: 11px; font-style: italic; color: var(--gold); }
  .footer-legal { font-size: 10px; color: var(--white); font-family: 'DM Mono', monospace; }
  @media (max-width: 680px) {
    .header, .section, .welcome, .signoff, .confidentiality { padding-left: 24px; padding-right: 24px; }
    .identity-strip { flex-direction: column; gap: 16px; text-align: center; padding: 24px; }
    .streak-display { text-align: center; }
    .earned-titles { justify-content: center; }
    .consistency-row { grid-template-columns: repeat(2, 1fr); }
    .radar-wrap { flex-direction: column; }
    .radar-canvas-wrap { flex: none; max-width: 240px; height: 240px; }
    .compare-row { grid-template-columns: 1fr 50px 18px 50px 70px; gap: 6px; padding: 10px; }
    .compare-name { font-size: 11px; }
    .invite-scarcity { flex-direction: column; gap: 10px; }
    .header-meta { position: static; margin-top: 12px; }
    .invite-section { padding: 30px 24px; }
    .footer { padding: 24px 24px; gap: 8px; }
  }
</style>
</head>
<body>
<div class="page">

  <div class="header">
    <div class="header-meta"><span class="day-badge">DAY 21 — COMPLETE</span></div>
    <div class="header-brand">FORGED &nbsp;·&nbsp; Resilience Coaching Lab</div>
    <h1 class="header-title">Your <em>Progress</em> Dashboard</h1>
    <p class="header-sub">Resilience Launchpad &nbsp;·&nbsp; 21 Days Complete &nbsp;·&nbsp; FRI Re-Assessment</p>
  </div>

  <div class="identity-strip">
    <div>
      <div class="identity-name">${name}</div>
      <div class="identity-role">${role}</div>
      <div class="earned-titles">
        <span class="earned-title-badge">🎓 Launchpad Graduate</span>
        <span class="earned-title-badge">🔥 Resilience Champion</span>
      </div>
    </div>
    <div class="streak-display">
      <div class="streak-flame">🔥</div>
      <div class="streak-label">21 of 21 days complete</div>
    </div>
  </div>

  <div class="welcome">
    <p>"Twenty-one days ago you took a starting measurement and chose to act on it. Today you are looking at a different shape — not because the pressure disappeared, but because your capacity to meet it has grown. Both titles below are earned, not given. You showed up."</p>
    <div class="welcome-attr">— Coach Orange &nbsp;·&nbsp; FORGED Resilience Coaching Lab</div>
  </div>

  <div class="section">
    <div class="section-label">Your 21-Day Engagement</div>
    <div class="consistency-row">
      <div class="consistency-card"><div class="consistency-value gold">${consistencyPct}%</div><div class="consistency-label">Consistency score</div></div>
      <div class="consistency-card"><div class="consistency-value">${nudgesEngaged}/21</div><div class="consistency-label">Nudges engaged</div></div>
      <div class="consistency-card"><div class="consistency-value">${journalCount}</div><div class="consistency-label">Journal reflections</div></div>
      <div class="consistency-card"><div class="consistency-value gold">${callsCompleted}/2</div><div class="consistency-label">15-min calls completed</div></div>
    </div>

    <div class="radar-wrap">
      <div class="radar-canvas-wrap"><canvas id="radarChart"></canvas></div>
      <div class="radar-legend">
        <div class="radar-legend-title">Day 1 vs Day 21</div>
        <div class="radar-legend-sub">The grey outline is where you started. The gold shape is where you stand now. Every point that moved outward is a dimension you actively strengthened over 21 days.</div>
        <div class="radar-key">
          <div class="radar-key-item"><span class="radar-key-swatch before"></span> Day 1 baseline</div>
          <div class="radar-key-item"><span class="radar-key-swatch after"></span> Day 21 result</div>
        </div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-label">Dimension-by-Dimension Movement</div>
    <div class="compare-grid">
      ${buildComparisonRows(day1Scores, day21Scores)}
    </div>
  </div>

  <div class="section">
    <div class="section-label">What 21 Days Revealed</div>
    <div class="revelation-panel">
      <div class="revelation-label">Your Pressure Revelation</div>
      <div class="revelation-text">"Over 21 days, your Launchpad consistently returned to ${primaryDim} — the dimension your Day 1 Pulse Snapshot identified as your primary growth opportunity. You engaged with ${nudgesEngaged} of 21 nudges. That is not compliance. That is a leader who chose to look inward when it would have been easier to look away. Your FRI Score moved from ${friBefore} to ${friAfter} — not because the pressure on you lessened, but because your capacity to meet it grew."</div>
    </div>
  </div>

  <div class="section">
    <div class="section-label">What Remains Unforged</div>
    <div class="gap-panel">
      <div class="gap-label">The Honest Next Question</div>
      <div class="gap-title">Twenty-one days of daily nudges moved what daily nudges can move.</div>
      <div class="gap-text">Some dimensions shifted measurably. Others held steady at their Day 1 levels — and that is real information, not a failure. What remains is the kind of sustained, structural work that only sustained, structured coaching can reach. The Resilience Forge Lab exists for exactly this — the dimensions that resist short-term intervention and respond to depth.</div>
    </div>
  </div>

  <div class="section">
    <div class="section-label">From Your Leadership Journal</div>
    ${buildJournalEntries(journalEntries)}
  </div>

  <div class="invite-section">
    <div class="invite-eyebrow">You Are Invited</div>
    <h2 class="invite-title">The <em>Resilience Forge Lab</em></h2>
    <p class="invite-body">The Resilience Forge Lab is a 6-month transformative coaching journey. The Lab is where the real excavation shapes lasting behavioural change.</p>
    <div class="invite-quote">"What you did over 21 days is rare. Most leaders know they need to look inward. Very few actually do it. You did. I would be honoured to go deeper with you in the Lab." — Coach Orange</div>
    <div class="invite-scarcity">
      <div class="invite-scarcity-item"><div class="invite-scarcity-value">12</div><div class="invite-scarcity-label">Leaders maximum per cohort</div></div>
      <div class="invite-scarcity-item"><div class="invite-scarcity-value">Aug 2026</div><div class="invite-scarcity-label">Next cohort opens</div></div>
      <div class="invite-scarcity-item"><div class="invite-scarcity-value">By invitation</div><div class="invite-scarcity-label">Not open enrolment</div></div>
    </div>
    <a href="https://wa.me/26481745151?text=LAB" class="invite-button">Register My Interest</a>
    <a href="https://wa.me/26481745151" class="invite-button-secondary">Book a call with Coach Orange first</a>
    <div class="invite-pricing">N$9,150 individual rate &nbsp;·&nbsp; Corporate cohort rates available</div>
  </div>

  <div class="signoff">
    <div class="signoff-avatar">CO</div>
    <div class="signoff-text">
      <div class="signoff-message">"Twenty-one days ago I read your Pulse Snapshot and saw where you were starting from. Today I am reading a different profile — one you built, day by day, reply by reply. Whatever you decide next, this growth is yours to keep."</div>
      <div class="signoff-name">Coach Orange</div>
      <div class="signoff-creds">Jacob Ntintin Orange &nbsp;·&nbsp; MPhil Management Coaching (USB) &nbsp;·&nbsp; MSc HRM (Heriot-Watt)<br>Founder &amp; Principal Consultant &nbsp;·&nbsp; Change Experience Consulting (CXC)</div>
    </div>
  </div>

  <div class="confidentiality">
    <div class="confidentiality-label">Confidentiality &amp; Ethics</div>
    <div class="confidentiality-text">This dashboard and the data behind it are confidential and aligned to ICF (International Coaching Federation) coaching ethics. Your individual scores, reflections, and journal entries are not shared with any third party without your explicit consent. Coach Orange holds all client information in strict confidence, consistent with ICF professional standards. FORGED, the AI coaching companion referenced within this platform, operates under the same confidentiality commitment — it is an AI system, not a human coach, and all coaching oversight remains with Coach Orange.</div>
  </div>

  <div class="footer">
    <div class="footer-brand"><span>FORGED</span> &nbsp;/&nbsp; Resilience Coaching Lab</div>
    <div class="footer-tagline">Resilient leaders are not created. They are forged.</div>
    <div class="footer-legal">Day 21 of 21 &nbsp;·&nbsp; RCL-2026-0001</div>
  </div>

</div>

<script>
const ctx = document.getElementById('radarChart').getContext('2d');
new Chart(ctx, {
  type: 'radar',
  data: {
    labels: ['Identity\\nStability','Social\\nSupport','Purpose &\\nMeaning','Emotional\\nRegulation','Adaptive\\nCoping','Physical\\nVitality','Cognitive\\nFlexibility'],
    datasets: [
      { label: 'Day 1 Baseline', data: ${JSON.stringify(day1Data)}, backgroundColor: 'rgba(118,118,118,0.06)', borderColor: '#999999', borderWidth: 1.5, borderDash: [4,3], pointBackgroundColor: '#999999', pointBorderColor: '#fff', pointBorderWidth: 1, pointRadius: 3 },
      { label: 'Day 21 Result', data: ${JSON.stringify(day21Data)}, backgroundColor: 'rgba(184,134,11,0.15)', borderColor: '#B8860B', borderWidth: 2, pointBackgroundColor: '#B8860B', pointBorderColor: '#fff', pointBorderWidth: 2, pointRadius: 5 }
    ]
  },
  options: {
    responsive: true, maintainAspectRatio: true,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => \`\${ctx.dataset.label}: \${ctx.raw}/5\` } } },
    scales: { r: { min: 0, max: 5, ticks: { stepSize: 1, display: false }, grid: { color: 'rgba(0,0,0,0.08)' }, angleLines: { color: 'rgba(0,0,0,0.08)' }, pointLabels: { font: { family: "'DM Sans', sans-serif", size: 10 }, color: '#4A4A4A' } } }
  }
});
</script>
</body>
</html>`;

  const store = getStore("forged-dashboards");
  const slug = `day21-${recordId}`;
  await store.set(slug, html, { metadata: { generatedAt: new Date().toISOString() } });

  const siteUrl = process.env.URL || "https://resilience-pulse.netlify.app";
  return `${siteUrl}/dashboard/${slug}`;
}
