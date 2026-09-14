// POST /api/contact
// Receives the contact form and creates a record in the Inquiries table.
// Requires encrypted environment variables in Cloudflare Pages:
//   AIRTABLE_TOKEN    (existing)
//   TURNSTILE_SECRET  (new — from the Turnstile widget in the Cloudflare dashboard)

import { checkSpam } from "./_spam-filter.js";

const BASE_ID = "appxz89GW103YI3J8";
const TABLE_ID = "tbl81SAzXnIcfzPTh";

const CHOICES = [
  "On-site session for our team",
  "Studio Session for 1 Person",
  "Ongoing Studio Sessions for our local Office",
  "Something else...",
];

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const clean = (v, max) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/**
 * Ask Cloudflare whether this submission's Turnstile token is valid.
 *
 * Deliberate design choice: if TURNSTILE_SECRET is not configured, this
 * returns true and lets the submission through. A missing env var should
 * never take the contact form offline — that would cost real inquiries.
 * A token that IS checked and fails is rejected.
 */
async function verifyTurnstile(token, secret, ip) {
  if (!secret) {
    console.warn("TURNSTILE_SECRET is not set — skipping bot verification");
    return true;
  }
  if (!token) return false;

  try {
    const body = new FormData();
    body.append("secret", secret);
    body.append("response", token);
    if (ip) body.append("remoteip", ip);

    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body }
    );
    const out = await res.json();
    if (!out.success) {
      console.warn("Turnstile rejected a submission", JSON.stringify(out["error-codes"] || []));
    }
    return out.success === true;
  } catch (err) {
    // Cloudflare unreachable. Fail open rather than lose the inquiry —
    // the honeypot and the content filter still apply downstream.
    console.error("Turnstile verification call failed", err);
    return true;
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.AIRTABLE_TOKEN) {
    console.error("AIRTABLE_TOKEN is not set");
    return json(500, { ok: false, error: "server_not_configured" });
  }

  let data;
  try {
    const type = request.headers.get("content-type") || "";
    if (type.includes("application/json")) {
      data = await request.json();
    } else {
      data = Object.fromEntries(await request.formData());
    }
  } catch {
    return json(400, { ok: false, error: "bad_request" });
  }

  // Honeypot: real people leave this empty. Bots fill it.
  // Return success so the bot does not learn it was caught.
  if (clean(data.website, 200)) return json(200, { ok: true });

  // Turnstile: proves a real browser submitted this.
  const passed = await verifyTurnstile(
    clean(data.turnstileToken, 4000),
    env.TURNSTILE_SECRET,
    request.headers.get("CF-Connecting-IP")
  );
  if (!passed) {
    return json(403, { ok: false, error: "verification_failed" });
  }

  const name = clean(data.name, 200);
  const email = clean(data.email, 200);
  const phone = clean(data.phone, 50);
  const company = clean(data.company, 200);
  const topic = clean(data.topic, 200);
  const message = clean(data.message, 5000);

  if (!name || !email) {
    return json(400, { ok: false, error: "missing_required" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return json(400, { ok: false, error: "bad_email" });
  }

  // Spam check. Runs on the cleaned values, not the raw payload.
  // Caught submissions are still filed, with Status "Spam", so nothing
  // disappears silently and false positives stay auditable.
  const verdict = checkSpam({ name, email, phone, company, message, website: "" });
  if (verdict.spam) {
    console.log("Spam caught", verdict.score, verdict.reasons.join("; "), email);
  }

  const fields = {
    Name: name,
    Email: email,
    Message: message,
    Status: verdict.spam ? "Spam" : "New",
  };
  if (phone) fields["Phone"] = phone;
  if (company) fields["Company / Organization"] = company;
  if (CHOICES.includes(topic)) fields["What can we help with?"] = topic;

  try {
    const res = await fetch(
      `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.AIRTABLE_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ records: [{ fields }], typecast: false }),
      }
    );

    if (!res.ok) {
      console.error("Airtable rejected the record", res.status, await res.text());
      return json(502, { ok: false, error: "upstream_error" });
    }

    return json(200, { ok: true });
  } catch (err) {
    console.error("Request to Airtable failed", err);
    return json(502, { ok: false, error: "upstream_error" });
  }
}
