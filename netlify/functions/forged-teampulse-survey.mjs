/**
 * FORGED — Team Pulse Survey (Revision 1)
 * Netlify Function (HTTP endpoint) — serves the custom-branded employee
 * survey, replacing the originally-proposed Airtable native Form.
 *
 * ── WHY THIS REPLACED THE AIRTABLE FORM ────────────────────────────────
 * Pressure-tested this session: an Airtable-branded form undercuts the
 * "premium diagnostic" positioning Team Pulse is priced against
 * (Resilience Institute, PwC-tier competitors), and Airtable's native
 * form cannot dynamically redirect each respondent to their own
 * personal results — it only shows a static thank-you message. This
 * custom form fixes both: it's fully FORGED-branded, and on submission
 * it hands off to forged-teampulse-submit.mjs, which returns each
 * respondent's personal results directly, in the same page load.
 *
 * ── CONSENT, NOT BURIED ─────────────────────────────────────────────
 * The name/anonymity tradeoff is stated in plain language at the top of
 * the form itself — not left to the confidentiality statement, which
 * goes to the employer, not necessarily to each respondent before they
 * answer sensitive items.
 *
 * ── DATA MODEL — REQUIRES THIS TABLE TO EXIST IN AIRTABLE ─────────────
 * Table: Team Pulse Responses (create manually — no tool available this
 * session can create a new table in an existing base, only add fields
 * to one that already exists)
 *   - Engagement ID       (Single line text) — links responses to one
 *                          client engagement/company
 *   - Respondent Name     (Single line text)
 *   - Focus (FRI), Others (FRI), Regulation (FRI), Grit (FRI),
 *     Energy (FRI), Direction (FRI)                    (Number, 1-5)
 *   - Focus (FEI), Others (FEI), Regulation (FEI), Grit (FEI),
 *     Energy (FEI), Direction (FEI)                    (Number, 1-5)
 *   - Submitted At        (Date, includes time)
 *   - Personal Slug        (Single line text) — set by the submit
 *                          handler, not this form
 *
 * URL pattern: /.netlify/functions/forged-teampulse-survey?engagement=ENGAGEMENT_ID
 * (an "engagement" redirect, e.g. /pulse/:engagementId, can be added to
 * netlify.toml the same way /dashboard/:slug was, once this is live)
 *
 * Deploy at: netlify/functions/forged-teampulse-survey.mjs
 */

export default async function handler(req) {
  const url = new URL(req.url);
  const engagementId = url.searchParams.get("engagement") || "";

  if (!engagementId) {
    return new Response("Missing engagement reference. Please use the link provided by your organisation.", { status: 400 });
  }

  const html = renderSurveyHtml(engagementId);
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

// The six FORGED working forces, in fixed order — used to build both the
// resilience and engagement item sets so the two stay perfectly aligned.
const FORCES = [
  { key: "focus",      letter: "F", label: "Focus" },
  { key: "others",     letter: "O", label: "Others" },
  { key: "regulation", letter: "R", label: "Regulation" },
  { key: "grit",       letter: "G", label: "Grit" },
  { key: "energy",     letter: "E", label: "Energy" },
  { key: "direction",  letter: "D", label: "Direction" },
];

// Resilience (FRI) items — original wording, one per force.
const FRI_ITEMS = {
  focus:      "When plans change unexpectedly, I can adjust my approach without losing momentum.",
  others:     "I have people I can rely on for support when things get difficult.",
  regulation: "I stay composed under pressure, even in high-stakes moments.",
  grit:       "I keep going on difficult tasks, even when progress is slow.",
  energy:     "I have enough physical energy to meet the demands of my role.",
  direction:  "I have a clear sense of purpose in my work.",
};

// Engagement (FEI) items — original wording, previously agreed this session.
const FEI_ITEMS = {
  focus:      "I have a clear sense of what success looks like in my role this quarter.",
  others:     "There is someone at work who actively supports my development.",
  regulation: "I feel comfortable raising concerns without fear of negative consequences.",
  grit:       "I have real opportunities to grow and take on new challenges here.",
  energy:     "My contributions are noticed and valued by the people I work with.",
  direction:  "I understand how my work connects to this organisation's larger purpose.",
};

function ratingRow(name, statement) {
  const buttons = [1, 2, 3, 4, 5].map((n) => `
    <label class="rate-btn">
      <input type="radio" name="${name}" value="${n}" required />
      <span>${n}</span>
    </label>`).join("");

  return `
    <div class="item">
      <p class="item-text">${escapeHtml(statement)}</p>
      <div class="rate-row">
        <span class="rate-anchor">Strongly disagree</span>
        <div class="rate-btns">${buttons}</div>
        <span class="rate-anchor">Strongly agree</span>
      </div>
    </div>`;
}

function renderSurveyHtml(engagementId) {
  const friItems = FORCES.map((f) => ratingRow(`fri_${f.key}`, FRI_ITEMS[f.key])).join("");
  const feiItems = FORCES.map((f) => ratingRow(`fei_${f.key}`, FEI_ITEMS[f.key])).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>FORGED Team Pulse — Your Response</title>
<style>
  :root { --navy:#1C3557; --navy-deep:#122540; --crimson:#8B1A1A; --gold:#B8860B; --cream:#F7F5F0; --ink:#1A1A1A; --muted:#5B6472; --line:#E3DFD6; }
  * { box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Calibri',sans-serif; color:var(--ink); background:var(--cream); line-height:1.6; }
  h1,h2,.serif { font-family:Georgia,'Cambria',serif; }

  .header { background:linear-gradient(135deg, var(--navy) 0%, var(--navy-deep) 100%); color:#EDEAE2; padding:40px 20px 32px; border-bottom:5px solid var(--gold); }
  .header-inner { max-width:560px; margin:0 auto; }
  .eyebrow { letter-spacing:2.5px; text-transform:uppercase; font-size:12px; color:var(--gold); font-weight:700; }
  .header h1 { font-size:26px; font-weight:400; margin-top:14px; }

  .consent { background:rgba(184,134,11,0.16); border-left:4px solid var(--gold); padding:16px 18px; margin-top:20px; border-radius:0 4px 4px 0; font-size:14px; color:#F1EBDD; line-height:1.55; }
  .consent strong { color:var(--gold); }

  form { max-width:560px; margin:0 auto; padding:28px 20px 60px; }

  .field { margin-bottom:26px; }
  .field label { display:block; font-size:13px; font-weight:700; color:var(--navy); text-transform:uppercase; letter-spacing:1px; margin-bottom:8px; }
  .field input[type="text"] { width:100%; padding:14px; font-size:16px; border:1px solid var(--line); border-radius:6px; background:#fff; }

  .section-label { font-size:13px; letter-spacing:2px; text-transform:uppercase; color:var(--gold); font-weight:700; margin:34px 0 6px; }
  .section-sub { font-size:13px; color:var(--muted); margin-bottom:18px; }

  .item { background:#fff; border:1px solid var(--line); border-radius:8px; padding:18px; margin-bottom:14px; }
  .item-text { font-size:15px; color:var(--ink); margin-bottom:14px; }
  .rate-row { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
  .rate-anchor { font-size:10.5px; color:var(--muted); flex:0 0 70px; }
  .rate-anchor:last-child { text-align:right; }
  .rate-btns { display:flex; gap:6px; flex:1; justify-content:center; }
  .rate-btn { position:relative; }
  .rate-btn input { position:absolute; opacity:0; width:100%; height:100%; cursor:pointer; margin:0; }
  .rate-btn span { display:flex; align-items:center; justify-content:center; width:38px; height:38px; border-radius:50%; border:2px solid var(--line); font-size:14px; font-weight:700; color:var(--muted); background:#fff; }
  .rate-btn input:checked + span { background:var(--crimson); border-color:var(--crimson); color:#fff; }

  .submit-btn { display:block; width:100%; text-align:center; background:var(--gold); color:var(--navy); font-weight:700; font-size:16px; padding:18px 20px; border-radius:8px; margin-top:30px; border:none; cursor:pointer; }
  .submit-btn:disabled { opacity:0.6; cursor:wait; }
  .error-msg { color:var(--crimson); font-size:14px; margin-top:12px; text-align:center; display:none; }
  .footer-note { text-align:center; font-size:12px; color:var(--muted); margin-top:20px; }
</style>
</head>
<body>
  <div class="header">
    <div class="header-inner">
      <div class="eyebrow">FORGED &nbsp;·&nbsp; Team Pulse</div>
      <h1>A quick, honest read on how your team is really doing.</h1>
      <div class="consent">
        <strong>Your name is used only to deliver your personal results to you.</strong> Your employer sees anonymised, aggregated results only — never your individual answers.
      </div>
    </div>
  </div>

  <form id="pulse-form">
    <input type="hidden" name="engagement" value="${escapeHtml(engagementId)}" />

    <div class="field">
      <label for="name">Your name</label>
      <input type="text" id="name" name="name" required placeholder="So we can show you your own results" />
    </div>

    <div class="section-label">Part 1 — Resilience</div>
    <div class="section-sub">How you tend to respond under pressure. Rate each statement 1 (strongly disagree) to 5 (strongly agree).</div>
    ${friItems}

    <div class="section-label">Part 2 — Engagement</div>
    <div class="section-sub">How you're actually experiencing work right now.</div>
    ${feiItems}

    <button type="submit" class="submit-btn" id="submit-btn">See my results</button>
    <div class="error-msg" id="error-msg">Something went wrong submitting your response. Please try again.</div>
    <div class="footer-note">FORGED Resilience Coaching Lab &nbsp;·&nbsp; Change Experience Consulting (CXC)</div>
  </form>

<script>
  document.getElementById('pulse-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    const btn = document.getElementById('submit-btn');
    const errorMsg = document.getElementById('error-msg');
    btn.disabled = true;
    btn.textContent = 'Submitting...';
    errorMsg.style.display = 'none';

    const formData = new FormData(e.target);
    const payload = { engagement: formData.get('engagement'), name: formData.get('name'), answers: {} };
    for (const [key, value] of formData.entries()) {
      if (key.startsWith('fri_') || key.startsWith('fei_')) payload.answers[key] = Number(value);
    }

    try {
      const res = await fetch('/.netlify/functions/forged-teampulse-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Submit failed');
      const html = await res.text();
      document.open();
      document.write(html);
      document.close();
    } catch (err) {
      errorMsg.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'See my results';
    }
  });
</script>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
