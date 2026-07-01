/**
 * FORGED — Dashboard Public View
 * Netlify Function (HTTP endpoint) — serves generated Day 21 dashboards
 * stored in Netlify Blobs by forged-dashboard-generator.mjs.
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

export default async function handler(req) {
  const url  = new URL(req.url);
  const slug = url.searchParams.get("slug");

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

    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });

  } catch (err) {
    console.error(`[FORGED Dashboard View] Error: ${err.message}`);
    return new Response("Something went wrong loading your dashboard.", { status: 500 });
  }
}
