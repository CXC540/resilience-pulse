/**
 * FORGED — Dashboard Generator (TEMPORARY DIAGNOSTIC VERSION)
 *
 * This is a debug-only variant of forged-dashboard-generator.mjs. It performs
 * the exact same Airtable lookup, but returns the actual runtime values of
 * AIRTABLE_BASE_ID, AIRTABLE_TABLE_ID, and whether AIRTABLE_API_KEY is present,
 * directly in the JSON response — so we can see precisely what the function
 * is using, without needing to interpret Netlify's log UI.
 *
 * DEPLOY THIS TEMPORARILY IN PLACE OF forged-dashboard-generator.mjs,
 * TEST IT ONCE, THEN REVERT TO THE REAL VERSION. Do not leave this live —
 * it does not expose secret values, but it is not meant for production use.
 */

const AIRTABLE_BASE_ID  = process.env.AIRTABLE_BASE_ID  || "app1W8ijaU1gfc9nX";
const AIRTABLE_TABLE_ID = process.env.AIRTABLE_TABLE_ID || "tblCKeMaj5p5Lwl0m";
const AIRTABLE_API_KEY  = process.env.AIRTABLE_API_KEY;

const FIELD_DASHBOARD_SLUG = "Dashboard Slug";

export default async function handler(req) {
  const url  = new URL(req.url);
  const slug = url.searchParams.get("slug") || "jacob-orange";

  const diagnostic = {
    runtime_AIRTABLE_BASE_ID: AIRTABLE_BASE_ID,
    runtime_AIRTABLE_TABLE_ID: AIRTABLE_TABLE_ID,
    AIRTABLE_API_KEY_present: Boolean(AIRTABLE_API_KEY),
    AIRTABLE_API_KEY_length: AIRTABLE_API_KEY ? AIRTABLE_API_KEY.length : 0,
    AIRTABLE_API_KEY_prefix: AIRTABLE_API_KEY ? AIRTABLE_API_KEY.slice(0, 4) : null,
  };

  try {
    const filterFormula = encodeURIComponent(`{${FIELD_DASHBOARD_SLUG}} = "${slug}"`);
    const airtableUrl =
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_ID}` +
      `?filterByFormula=${filterFormula}&maxRecords=1`;

    diagnostic.requested_airtable_url = airtableUrl;

    const airtableRes = await fetch(airtableUrl, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    });

    diagnostic.airtable_http_status = airtableRes.status;

    const bodyText = await airtableRes.text();
    diagnostic.airtable_response_body = bodyText;

    return new Response(JSON.stringify(diagnostic, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    diagnostic.unexpected_error = String(err);
    return new Response(JSON.stringify(diagnostic, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
