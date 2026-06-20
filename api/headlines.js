// Vercel serverless function — runs on the server, never in the browser.
// The browser hits /api/headlines; this talks to Anthropic with the secret key.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set in Vercel env vars." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const sectorList = (body && body.sectorList) || "";
  const tickers = (body && body.tickers) || "";
  const today = new Date().toISOString().slice(0, 10);

  const prompt = `You are a markets news scanner. Today is ${today}. Search the web for the most important market-moving news from the past 7 days relevant to these sectors: ${sectorList}. Also flag anything major affecting these tickers: ${tickers}.

Return ONLY a JSON array — no preamble, no markdown fences. Each item exactly:
{"impact":"tailwind"|"headwind"|"neutral","sector":"<one of the sectors listed, or 'General' for broad-market news>","headline":"<concise, max 18 words>","url":"<real source url from your search>"}

Rules:
- 6 to 10 items.
- Include 2-3 "General" broad-market items (Fed, rates, indices).
- "impact" is from the view of a long investor in that sector.
- Output the raw JSON array and nothing else.`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
      }),
    });
    const data = await r.json();
    if (data.error) return res.status(500).json({ error: data.error.message || "Anthropic API error" });
    return res.status(200).json({ content: data.content });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
