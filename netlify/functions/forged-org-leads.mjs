/**
 * FORGED — Organisation Concentration Report
 * Netlify Scheduled Function — runs weekly, Monday 06:00 UTC (08:00 WAT)
 *
 * Purpose:
 *   Scans all Pulse Snapshot respondents in Airtable and groups them
 *   by Organisation. Any organisation with 2 or more completions is
 *   flagged as a corporate lead — surfaced to Coach Orange via
 *   WhatsApp and logged to a dedicated Leads table for follow-up.
 *
 *   This report is the direct commercial payoff of making Job Title
 *   and Organisation compulsory fields on the free Pulse Snapshot.
 */

export const config = {
  schedule: "0 6 * * 1" // every Monday, 06:00 UTC
};

const AIRTABLE_BASE   = "app1W8ijaU1gfc9nX";
const SUBSCRIBERS_TBL = "tblCKeMaj5p5Lwl0m";
const LEADS_TBL       = "tblOrgConcentrationLeads"; // create this table — see README below
const PHONE_ID        = "1135778909625987";
const COACH_NUMBER    = "264812221111"; // Coach Orange's own WhatsApp — alert recipient

function getEnv(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing environment variable: ${key}`);
  return val;
}

async function fetchAllRespondents(apiKey) {
  let records = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${SUBSCRIBERS_TBL}`);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`Airtable fetch failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);

  return records;
}

function groupByOrganisation(records) {
  const groups = {};
  for (const r of records) {
    const org = (r.fields["Organisation"] || "").trim();
    if (!org) continue; // skip legacy records with no organisation captured

    if (!groups[org]) groups[org] = [];
    groups[org].push({
      name:     r.fields["Name"] || "Unknown",
      title:    r.fields["Job Title"] || "",
      rciIndex: r.fields["RCI Index"] || null,
      status:   r.fields["Status"] || "",
      created:  r.fields["Created"] || r.createdTime,
    });
  }
  return groups;
}

function rankLeads(groups, minimumThreshold = 2) {
  return Object.entries(groups)
    .filter(([, people]) => people.length >= minimumThreshold)
    .map(([org, people]) => ({
      organisation: org,
      count:        people.length,
      people,
      avgRci:       Math.round(
        people.filter(p => p.rciIndex).reduce((a, p) => a + p.rciIndex, 0) /
        (people.filter(p => p.rciIndex).length || 1)
      ),
    }))
    .sort((a, b) => b.count - a.count);
}

async function logLeadToAirtable(apiKey, lead) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${LEADS_TBL}`;
  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        "Organisation":        lead.organisation,
        "Respondent Count":    lead.count,
        "Average RCI Index":   lead.avgRci,
        "Respondent Names":    lead.people.map(p => `${p.name} (${p.title || "no title"})`).join(", "),
        "Flagged Date":        new Date().toISOString().split("T")[0],
        "Lead Status":         "New — Awaiting Outreach",
      }
    })
  });
}

function buildAlertMessage(leads) {
  if (leads.length === 0) {
    return "🔥 *FORGED — Weekly Lead Scan*\n\nNo new multi-respondent organisations this week. Pipeline steady.";
  }

  const lines = leads.slice(0, 10).map((l, i) =>
    `${i + 1}. *${l.organisation}* — ${l.count} respondents · Avg RCI ${l.avgRci}/100`
  );

  return `🔥 *FORGED — Weekly Lead Scan*\n\n${leads.length} organisation${leads.length > 1 ? "s" : ""} flagged with 2+ Pulse Snapshot completions:\n\n${lines.join("\n")}\n\nFull detail logged to your Leads table. These are warm corporate conversations waiting to happen.`;
}

async function sendWhatsAppAlert(accessToken, to, message) {
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
  if (!res.ok) {
    const errText = await res.text();
    console.error(`[FORGED Leads] WhatsApp alert failed: ${errText}`);
  }
}

export default async function handler() {
  console.log(`[FORGED Leads] Organisation Concentration scan started — ${new Date().toISOString()}`);

  const AIRTABLE_KEY = getEnv("AIRTABLE_API_KEY");
  const META_TOKEN    = getEnv("META_ACCESS_TOKEN");

  try {
    const respondents = await fetchAllRespondents(AIRTABLE_KEY);
    console.log(`[FORGED Leads] Scanned ${respondents.length} total respondents`);

    const groups = groupByOrganisation(respondents);
    const leads  = rankLeads(groups, 2); // 2+ respondents from the same org = lead-worthy

    console.log(`[FORGED Leads] ${leads.length} organisations flagged at 2+ threshold`);

    for (const lead of leads) {
      await logLeadToAirtable(AIRTABLE_KEY, lead);
    }

    const alertMessage = buildAlertMessage(leads);
    await sendWhatsAppAlert(META_TOKEN, COACH_NUMBER, alertMessage);

    console.log(`[FORGED Leads] Scan complete — alert sent to Coach Orange`);
    return new Response(JSON.stringify({ organisationsFlagged: leads.length, leads }), { status: 200 });

  } catch (err) {
    console.error(`[FORGED Leads] Fatal error — ${err.message}`);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

/*
═══════════════════════════════════════════════════════════════════
README — ONE-TIME SETUP REQUIRED BEFORE THIS FUNCTION CAN RUN
═══════════════════════════════════════════════════════════════════

1. CREATE A NEW AIRTABLE TABLE: "Organisation Leads"
   Base: FORGED Resilience Lab (app1W8ijaU1gfc9nX)

   Fields required:
     Organisation        — Single line text
     Respondent Count    — Number
     Average RCI Index   — Number
     Respondent Names    — Long text
     Flagged Date         — Date
     Lead Status           — Single select
                             Options: New — Awaiting Outreach,
                                      Contacted, In Conversation,
                                      Converted, Not Interested

   Once created, copy its Table ID from the Airtable API docs for
   this base, and replace the placeholder LEADS_TBL constant at the
   top of this file (currently "tblOrgConcentrationLeads") with the
   real table ID.

2. DEPLOY THIS FILE
   Place at: netlify/functions/forged-org-leads.mjs
   Add to netlify.toml:

     [functions."forged-org-leads"]
       schedule = "0 6 * * 1"

3. CONFIRM ENVIRONMENT VARIABLES ALREADY EXIST
   AIRTABLE_API_KEY  — already set from forged-daily-nudge.mjs setup
   META_ACCESS_TOKEN — already set from forged-daily-nudge.mjs setup

4. COACH_NUMBER CONSTANT
   Currently set to Coach Orange's own WhatsApp (264812221111) so
   the weekly lead alert lands directly in his personal WhatsApp,
   separate from the subscriber-facing nudge number.

═══════════════════════════════════════════════════════════════════
*/
