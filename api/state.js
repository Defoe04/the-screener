// Cloud sync for The Screener — one JSON blob, gated by a sync key.
// Requires: a Vercel Blob store connected to the project (injects BLOB_READ_WRITE_TOKEN)
// and a SYNC_KEY environment variable set in Vercel project settings.
import { put, list } from "@vercel/blob";

const BLOB_NAME = "screener-state.json";

export default async function handler(req, res) {
  if (!process.env.SYNC_KEY) return res.status(500).json({ error: "SYNC_KEY not configured on the server" });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(500).json({ error: "No Blob store connected to this project" });
  if (req.headers["x-sync-key"] !== process.env.SYNC_KEY) return res.status(401).json({ error: "Bad sync key" });

  try {
    if (req.method === "GET") {
      const { blobs } = await list({ prefix: BLOB_NAME, limit: 1 });
      if (!blobs.length) return res.status(404).json({ error: "No cloud state yet" });
      const r = await fetch(`${blobs[0].url}?ts=${Date.now()}`, { cache: "no-store" });
      const text = await r.text();
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/json");
      return res.status(200).send(text);
    }
    if (req.method === "PUT" || req.method === "POST") {
      const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      if (!body || body === "undefined") return res.status(400).json({ error: "Empty payload" });
      if (body.length > 4000000) return res.status(413).json({ error: "State too large (>4MB)" });
      await put(BLOB_NAME, body, { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json", cacheControlMaxAge: 60 });
      return res.status(200).json({ ok: true, bytes: body.length });
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
}
