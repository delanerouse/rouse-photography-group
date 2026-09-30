// POST /api/assignment
// Receives the Photographer Network Portal form (assignment.rousephotographygroup.com)
// and creates a record in the Assignments table of the RPG Photographer Requests base.
// Uses the same encrypted Pages environment variable as the contact form:
//   AIRTABLE_TOKEN  (must be able to write to the Assignments table)

const BASE_ID = "appxz89GW103YI3J8";
const TABLE_ID = "tblb2mwajIkIjBvMh";

const ALLOWED_ORIGIN = "https://assignment.rousephotographygroup.com";

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors },
  });

const clean = (v, max) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

const wholeNumber = (v) => {
  const n = Number(String(v ?? "").trim());
  return Number.isInteger(n) && n >= 1 && n <= 100000 ? n : null;
};

// Browsers send a preflight request before a cross-origin JSON POST.
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: cors });
}

export async function onRequestPost({ request, env }) {
  if (!env.AIRTABLE_TOKEN) {
    console.error("AIRTABLE_TOKEN is not set");
    return json(500, { ok: false, error: "server_not_configured" });
  }

  // Only the portal page should be posting here.
  const origin = request.headers.get("Origin");
  if (origin && origin !== ALLOWED_ORIGIN) {
    return json(403, { ok: false, error: "forbidden_origin" });
  }

  let data;
  try {
    data = await request.json();
  } catch {
    return json(400, { ok: false, error: "bad_request" });
  }

  // Honeypot: real people leave this empty. Bots fill it.
  // Return success so the bot does not learn it was caught.
  if (clean(data.website, 200)) return json(200, { ok: true });

  const folderName = clean(data.folderName, 200);
  const name = clean(data.name, 200);
  const email = clean(data.email, 200);
  const market = clean(data.market, 200);
  const client = clean(data.client, 200);
  const shootDate = clean(data.shootDate, 10);
  const people = wholeNumber(data.people);
  const photos = wholeNumber(data.photos);
  const notes = clean(data.notes, 5000);

  if (!folderName || !name || !email || !market || !client || !shootDate || people === null || photos === null) {
    return json(400, { ok: false, error: "missing_required" });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return json(400, { ok: false, error: "bad_email" });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shootDate)) {
    return json(400, { ok: false, error: "bad_date" });
  }

  const fields = {
    "Folder name": folderName,
    Photographer: name,
    "Photographer email": email,
    Market: market,
    Client: client,
    "Assignment date": shootDate,
    "People photographed": people,
    "Files uploaded": photos,
    Status: "New",
  };
  if (notes) fields["Notes for post-production"] = notes;

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
      console.error("Airtable rejected the assignment", res.status, await res.text());
      return json(502, { ok: false, error: "upstream_error" });
    }

    return json(200, { ok: true });
  } catch (err) {
    console.error("Request to Airtable failed", err);
    return json(502, { ok: false, error: "upstream_error" });
  }
}
