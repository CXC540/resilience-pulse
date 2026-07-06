/**
 * FORGED Resilience Coaching Lab — Score and Generate
 * Netlify Function (HTTP endpoint)
 *
 * Receives the Resilience Pulse Snapshot form submission from pulse.html,
 * calculates the FRI score and primary growth dimension, creates the
 * subscriber record in Airtable, and sends a WhatsApp notification
 * confirming the report is being generated.
 *
 * The full Pulse Snapshot HTML report is generated and sent as a
 * WhatsApp link by this function using the same dashboard generation
 * architecture as the Day 21 Progress Dashboard.
 *
 * Deploy at: netlify/functions/score-and-generate.js
 */

const AIRTABLE_BASE   = "app1W8ijaU1gfc9nX";
const SUBSCRIBERS_TBL = "tblCKeMaj5p5Lwl0m";
const PHONE_ID        = "1135778909625987";

const RCI_FIELD_IDS = {
  "Emotional Regulation":  "fldIWvC9FfkOqUnX0",
  "Cognitive Flexibility": "fldHp33Q5BYyBDWVx",
  "Social Support":        "fldmaQV0O9sBR3ySc",
  "Purpose & Meaning":     "fldqG7We5RCLLHZwH",
  "Physical Vitality":     "fldQeEn6qpBc7j9lk",
  "Adaptive Coping":       "fldVNcap86YDzqb1q",
  "Identity Stability":    "fldaektBEVq36faGW",
};

const PRIORITY_ORDER = [
  "Cognitive Flexibility",
  "Emotional Regulation",
  "Adaptive Coping",
  "Physical Vitality",
  "Social Support",
  "Purpose & Meaning",
  "Identity Stability",
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function getEnv(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing environment variable: ${key}`);
  return val;
}

function calculateFriScore(scores) {
  const values = Object.values(scores);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.round((avg / 5) * 100);
}

function findPrimaryGrowthDimension(scores) {
  const minScore = Math.min(...Object.values(scores));
  const tiedDimensions = PRIORITY_ORDER.filter(d => scores[d] === minScore);
  return tiedDimensions[0];
}

function friBand(score) {
  if (score >= 85) return "RESILIENCE FOUNDATION";
  if (score >= 70) return "BUILDING RESILIENCE";
  if (score >= 55) return "DEVELOPING RESILIENCE";
  return "RESILIENCE EMERGING";
}

function formatWhatsApp(number) {
  const digits = number.replace(/\D/g, "");
  if (digits.startsWith("264")) return digits;
  if (digits.startsWith("0")) return `264${digits.slice(1)}`;
  return `264${digits}`;
}

function buildRoleLine(jobTitle, organisation) {
  const title = (jobTitle || "").trim();
  const org   = (organisation || "").trim();
  if (title && org)  return `${title} · ${org}`;
  if (org)            return `Senior Leader · ${org}`;
  return "Senior Leader · across Africa";
}

// ── Airtable ─────────────────────────────────────────────────────────────────

async function createSubscriberRecord(apiKey, {
  fullName, whatsapp, email, jobTitle, organisation,
  scores, friScore, primaryDimension, friband
}) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${SUBSCRIBERS_TBL}`;

  const scoreFields = {};
  for (const [dim, fieldId] of Object.entries(RCI_FIELD_IDS)) {
    scoreFields[fieldId] = scores[dim] ?? 3;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        "Full Name":         fullName,
        "WhatsApp":          whatsapp,
        "Email":             email,
        "Job Title":         jobTitle,
        "Organisation":      organisation,
        "Status":            "Pending",
        "Start Date":        new Date().toISOString().split("T")[0],
        "FRI Score":         friScore,
        "FRI Band":          friband,
        "Primary Dimension": primaryDimension,
        ...scoreFields
      }
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Airtable record creation failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.id;
}

// ── WhatsApp ─────────────────────────────────────────────────────────────────

async function sendWhatsAppConfirmation(accessToken, to, {
  name, friScore, friband, primaryDimension, siteUrl
}) {
  const url = `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`;

  const message = `🔥 *FORGED — Your Resilience Pulse Snapshot*

${name.split(" ")[0]}, your FORGED Resilience Index (FRI) assessment has been received.

*Your FRI Score: ${friScore}/100*
Band: ${friband}

*Primary Growth Dimension:* ${primaryDimension}

Your full seven-dimension Resilience Pulse Snapshot report — with personalised insights and your Launchpad invitation — is ready at:

${siteUrl}/snapshot

Your coaching journey starts here. You have been seen — now let's build.

— Coach Orange · FORGED Resilience Coaching Lab`;

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message }
    })
  });

  if (!res.ok) {
    console.error(`[FORGED Score] WhatsApp send failed: ${await res.text()}`);
  }
}

// ── Main Handler ─────────────────────────────────────────────────────────────

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const AIRTABLE_KEY  = getEnv("AIRTABLE_API_KEY");
    const META_TOKEN    = getEnv("META_ACCESS_TOKEN");
    const siteUrl       = process.env.URL || "https://resilience-coaching.org";

    const body = await req.json();
    const { full_name, whatsapp, email, job_title, organisation, scores } = body;

    // Validate required fields
    if (!full_name || !whatsapp || !email || !job_title || !organisation || !scores) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400 });
    }

    // Calculate FRI
    const friScore         = calculateFriScore(scores);
    const primaryDimension = findPrimaryGrowthDimension(scores);
    const band             = friBand(friScore);
    const formattedNumber  = formatWhatsApp(whatsapp);
    const roleLine         = buildRoleLine(job_title, organisation);

    console.log(`[FORGED Score] ${full_name} | FRI: ${friScore} | Primary: ${primaryDimension}`);

    // Create Airtable record
    const recordId = await createSubscriberRecord(AIRTABLE_KEY, {
      fullName:         full_name,
      whatsapp:         formattedNumber,
      email,
      jobTitle:         job_title,
      organisation,
      scores,
      friScore,
      primaryDimension,
      friband:          band,
    });

    console.log(`[FORGED Score] Airtable record created: ${recordId}`);

    // Send WhatsApp confirmation
    await sendWhatsAppConfirmation(META_TOKEN, formattedNumber, {
      name:             full_name,
      friScore,
      friband:          band,
      primaryDimension,
      siteUrl,
    });

    console.log(`[FORGED Score] WhatsApp confirmation sent to ${formattedNumber}`);

    return new Response(JSON.stringify({
      success:   true,
      recordId,
      friScore,
      primaryDimension,
      band,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error(`[FORGED Score] Error: ${err.message}`);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
