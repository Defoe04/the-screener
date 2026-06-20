import React, { useState, useEffect, useCallback } from "react";

// ─── RULES ENGINE ───────────────────────────────────────────────────────────
const DEFAULT_RULES = {
  weights: { A: 0.05, B: 0.05, C: 0.20, D: 0.10, E: 0.10, F: 0.05, G: 0.10, H: 0.05, I: 0.10, J: 0.20 },
  mktCapFloor: 300, volHardVeto: 100000, volSoft: 500000,
  minAnalysts: 4, catalystWindow: 30, runwayMin: 2, runwayVeto: 0.5,
  goThreshold: 7.5, watchThreshold: 5.0,
  macro: { capeRed: 30, vixBlackSwan: 50, vixElevated: 30, fgFear: 25, fgGreed: 75, buffettOver: 150, yieldRestrictive: 4.5 },
};
const CLUSTER_NAMES = {
  A: "Valuation Sanity", B: "Price & Liquidity", C: "Balance Sheet", D: "Analyst Coverage",
  E: "Insider Activity", F: "Market Position", G: "PICPOT Narrative", H: "Competitive Moat",
  I: "Management Quality", J: "Catalyst & Lifecycle",
};
const QUESTION_OF = { C: "Can it survive?", J: "Will it move soon?", D: "Will it move soon?", E: "Do insiders believe?", I: "Do insiders believe?", G: "Is the story alive?", H: "Is the story alive?", A: "Is the price right?", F: "Is the price right?", B: "Is the price right?" };
const QUESTIONS = ["Can it survive?", "Will it move soon?", "Do insiders believe?", "Is the story alive?", "Is the price right?"];
const MACRO_LINKS = {
  cape: "https://www.multpl.com/shiller-pe", vix: "https://finance.yahoo.com/quote/%5EVIX/",
  fg: "https://www.cnn.com/markets/fear-and-greed", buffett: "https://www.currentmarketvaluation.com/models/buffett-indicator.php",
  yield: "https://finance.yahoo.com/quote/%5ETNX/", margin: "https://www.finra.org/investors/learn-to-invest/advanced-investing/margin-statistics",
};
const etfLink = etf => `https://finance.yahoo.com/quote/${encodeURIComponent(etf)}/`;
const CLUSTER_SOURCES = {
  A: "Refinitiv: TR.PriceToBookRatio, TR.PERatio", B: "Refinitiv: TR.PriceClose, TR.ADTV, TR.CompanyMarketCap",
  C: "Refinitiv: TR.TotalDebt, TR.CashAndSTInvestments, TR.NetCashFromOperatingActivities", D: "Refinitiv: TR.NumberOfAnalysts, TR.TargetPrice",
  E: "Refinitiv: TR.InsiderNetSharesPurchased12M, TR.InsiderPurchasesValue12M", F: "Refinitiv: TR.PriceLow52Week, TR.PriceChangePct1Y",
  G: "Web research (Claude first pass) + your edits", H: "Web research (Claude first pass) + your edits",
  I: "Earnings call transcript + web research (Claude first pass) + your edits", J: "Refinitiv + manual catalyst entry + your edits",
};
const QUAL_LABELS = {
  G: ["Proximity", "Impact", "Conflict", "Prominence", "Oddity", "Timeliness"],
  H: ["Brand loyalty", "Technical lead", "Mfg/Ops lead", "Reg head start", "Community", "First mover"],
  I: ["Unscripted tone", "Q&A directness", "Guidance clarity", "Low evasiveness", "CEO conviction"],
};

function tierPB(p) {
  if (p == null) return { score: 5, tier: "N/A — no peer data", rule: "P/B N/A → neutral 5" };
  if (p < -50) return { score: 9.5, tier: "50%+ discount to peers", rule: "P/B < -50% → 9.5" };
  if (p < -20) return { score: 7, tier: "20-50% discount", rule: "P/B -50..-20% → 7" };
  if (p < 20) return { score: 4.5, tier: "In line with peers", rule: "P/B ±20% → 4.5" };
  if (p < 50) return { score: 2.5, tier: "20-50% premium", rule: "P/B +20..50% → 2.5" };
  return { score: 0.5, tier: "50%+ premium", rule: "P/B > +50% → 0.5" };
}
function tierPE(pe, ind) {
  if (pe == null) return { score: 5, tier: "N/A — pre-revenue", rule: "P/E N/A → neutral 5" };
  if (pe < 0) return { score: 2, tier: "Negative earnings", rule: "P/E < 0 → 2 (flip timing in Cluster J)" };
  if (ind == null) return { score: 5, tier: "No industry comparison", rule: "No industry P/E → neutral 5" };
  const r = pe / ind;
  if (r < 0.5) return { score: 9.5, tier: "P/E < 50% of industry", rule: "ratio < 0.5 → 9.5" };
  if (r < 1) return { score: 7, tier: "Below industry avg", rule: "ratio < 1 → 7" };
  if (r < 1.5) return { score: 5, tier: "Slightly above industry", rule: "ratio < 1.5 → 5" };
  if (r < 2) return { score: 3, tier: "Well above industry", rule: "ratio < 2 → 3" };
  return { score: 1.5, tier: "2x+ industry avg", rule: "ratio ≥ 2 → 1.5" };
}
function tierPrice(p) {
  if (p == null) return { score: null, tier: "No price", rule: "—" };
  if (p < 1) return { score: "KO", tier: "Below $1 — Penny Stock Hell", rule: "Hard veto unless 2yr runway + 30d catalyst" };
  if (p <= 2) return { score: 9.5, tier: "$1-2 sweet spot", rule: "$1-2 → 9.5" };
  if (p <= 3) return { score: 7.5, tier: "$2-3", rule: "$2-3 → 7.5" };
  if (p <= 5) return { score: 5.5, tier: "$3-5", rule: "$3-5 → 5.5" };
  if (p <= 10) return { score: 3.5, tier: "$5-10 — above target range", rule: "$5-10 → 3.5" };
  return { score: 1.5, tier: "Above $10", rule: ">$10 → 1.5" };
}
function tierVol(v, r) {
  if (v == null) return { score: null, tier: "No volume data", rule: "—" };
  if (v < r.volHardVeto) return { score: "KO", tier: "Below 100k — illiquid", rule: `Hard Veto: vol < ${r.volHardVeto.toLocaleString()}` };
  if (v < r.volSoft) return { score: 3, tier: "100k-500k — thin", rule: "Soft floor → 3" };
  if (v < 1e6) return { score: 5.5, tier: "500k-1M", rule: "→ 5.5" };
  if (v < 2e6) return { score: 7.5, tier: "1M-2M", rule: "→ 7.5" };
  return { score: 9.5, tier: "2M+ — highly liquid", rule: "→ 9.5" };
}
function tierMktCap(m, r) {
  if (m == null) return { score: null, tier: "No mkt cap", rule: "—" };
  if (m < r.mktCapFloor) return { score: "KO", tier: `Below $${r.mktCapFloor}M floor`, rule: `Hard Veto: cap < $${r.mktCapFloor}M` };
  if (m < 500) return { score: 3.5, tier: "$300-500M", rule: "→ 3.5" };
  if (m < 1000) return { score: 5.5, tier: "$500M-1B", rule: "→ 5.5" };
  if (m < 2000) return { score: 7.5, tier: "$1-2B", rule: "→ 7.5" };
  return { score: 9.5, tier: "$2B+", rule: "→ 9.5" };
}
function tierDebtCash(d, c) {
  if (d == null || c == null) return { score: 5, tier: "N/A", rule: "Missing data → neutral 5" };
  if (c === 0) return { score: 0, tier: "No cash", rule: "Cash = 0 → 0" };
  const r = d / c;
  if (r === 0) return { score: 10, tier: "Zero debt — cannot go bankrupt", rule: "debt=0 → 10" };
  if (r < 0.1) return { score: 8.5, tier: "Debt < 10% of cash", rule: "→ 8.5" };
  if (r < 0.25) return { score: 6.5, tier: "Debt 10-25% of cash", rule: "→ 6.5" };
  if (r < 0.5) return { score: 4.5, tier: "Debt 25-50% of cash", rule: "→ 4.5" };
  if (r < 1) return { score: 2.5, tier: "Debt 50-100% of cash", rule: "→ 2.5" };
  return { score: 1, tier: "Debt exceeds cash", rule: "→ 1" };
}
function tierRunway(cash, burnQ, r) {
  if (cash == null || burnQ == null) return { score: 3, tier: "N/A — uncertain", rule: "Missing → 3" };
  if (burnQ >= 0) return { score: 9.5, tier: "Cash flow positive", rule: "Profitable → 9.5" };
  const yrs = cash / Math.abs(burnQ) * 0.25;
  if (yrs < r.runwayVeto) return { score: "KO", tier: `${yrs.toFixed(1)}y — below 6 months`, rule: "Hard Veto: runway < 0.5y", years: yrs };
  if (yrs >= 4) return { score: 9.5, tier: `${yrs.toFixed(1)}y runway`, rule: "4y+ → 9.5", years: yrs };
  if (yrs >= 3) return { score: 7.5, tier: `${yrs.toFixed(1)}y runway`, rule: "3-4y → 7.5", years: yrs };
  if (yrs >= 2) return { score: 5.5, tier: `${yrs.toFixed(1)}y runway`, rule: "2-3y → 5.5", years: yrs };
  if (yrs >= 1) return { score: 3, tier: `${yrs.toFixed(1)}y — below 2y minimum`, rule: "1-2y → 3 (heavy negative)", years: yrs };
  return { score: 1, tier: `${yrs.toFixed(1)}y — critical`, rule: "0.5-1y → 1", years: yrs };
}
function tierAnalysts(n, r) {
  if (n == null) return { score: 3, tier: "Unknown", rule: "Missing → 3" };
  if (n < 1) return { score: 0, tier: "No coverage", rule: "→ 0" };
  if (n < 2) return { score: 1.5, tier: "1 analyst", rule: "→ 1.5" };
  if (n < r.minAnalysts) return { score: 3, tier: `${n} — below min ${r.minAnalysts}`, rule: "→ 3" };
  if (n < 7) return { score: 5.5, tier: `${n} analysts`, rule: "4-6 → 5.5" };
  if (n < 10) return { score: 7.5, tier: `${n} analysts`, rule: "7-9 → 7.5" };
  return { score: 9.5, tier: `${n} analysts — heavy coverage`, rule: "10+ → 9.5" };
}
function tierUpside(t, p) {
  if (t == null || p == null || p === 0) return { score: 5, tier: "N/A", rule: "Missing → 5" };
  const u = (t - p) / p * 100;
  if (u < 0) return { score: 0, tier: `${u.toFixed(0)}% — downside consensus`, rule: "→ 0 (headwind)" };
  if (u < 50) return { score: 1.5, tier: `+${u.toFixed(0)}% — minimal tailwind`, rule: "→ 1.5" };
  if (u < 100) return { score: 3.5, tier: `+${u.toFixed(0)}% — slight tailwind`, rule: "→ 3.5" };
  if (u < 200) return { score: 5.5, tier: `+${u.toFixed(0)}% — moderate`, rule: "→ 5.5" };
  if (u < 500) return { score: 7.5, tier: `+${u.toFixed(0)}% — strong tailwind`, rule: "→ 7.5" };
  return { score: 9.5, tier: `+${u.toFixed(0)}% — exceptional`, rule: "→ 9.5" };
}
function tierInsiderNet(n) {
  if (n == null) return { score: 4, tier: "No data", rule: "→ 4 neutral" };
  if (n < -50000) return { score: "KO", tier: "Heavy net selling", rule: "Hard Veto: sustained insider selling" };
  if (n > 50000) return { score: 9.5, tier: "Strong net buying", rule: "→ 9.5" };
  if (n > 10000) return { score: 7.5, tier: "Moderate net buying", rule: "→ 7.5" };
  if (n > 0) return { score: 5.5, tier: "Slight net buying", rule: "→ 5.5" };
  if (n === 0) return { score: 4, tier: "No activity", rule: "→ 4" };
  if (n > -10000) return { score: 2.5, tier: "Slight net selling", rule: "→ 2.5" };
  return { score: 1, tier: "Net selling", rule: "→ 1" };
}
function tierInsiderFloor(b, p) {
  if (b == null || p == null || b === 0) return { score: 3, tier: "No significant insider buy", rule: "→ 3" };
  const r = p / b;
  if (r < 0.8) return { score: 9.5, tier: `20%+ below insider buy $${b}`, rule: "→ 9.5" };
  if (r < 1) return { score: 7.5, tier: `Below insider buy $${b}`, rule: "→ 7.5" };
  if (r === 1) return { score: 5.5, tier: "At insider buy level", rule: "→ 5.5" };
  if (r < 1.2) return { score: 3.5, tier: "0-20% above insider buy", rule: "→ 3.5" };
  return { score: 1.5, tier: `20%+ above insider buy $${b}`, rule: "→ 1.5" };
}
function tier52w(p, l) {
  if (p == null || l == null || l === 0) return { score: 5, tier: "N/A", rule: "→ 5" };
  const d = (p - l) / l * 100;
  if (d < 5) return { score: 9.5, tier: `${d.toFixed(0)}% above 52w low`, rule: "<5% → 9.5" };
  if (d < 15) return { score: 7.5, tier: `${d.toFixed(0)}% above low`, rule: "5-15% → 7.5" };
  if (d < 30) return { score: 5.5, tier: `${d.toFixed(0)}% above low`, rule: "15-30% → 5.5" };
  if (d < 50) return { score: 3.5, tier: `${d.toFixed(0)}% above low`, rule: "30-50% → 3.5" };
  return { score: 1.5, tier: `${d.toFixed(0)}% above low`, rule: "50%+ → 1.5" };
}
function tierYTD(y) {
  if (y == null) return { score: 5, tier: "N/A", rule: "→ 5" };
  if (y < -75) return { score: 9.5, tier: `${y.toFixed(0)}% — max dislocation`, rule: "→ 9.5" };
  if (y < -50) return { score: 7.5, tier: `${y.toFixed(0)}% YTD`, rule: "→ 7.5" };
  if (y < -25) return { score: 5.5, tier: `${y.toFixed(0)}% YTD`, rule: "→ 5.5" };
  if (y < 0) return { score: 3.5, tier: `${y.toFixed(0)}% YTD`, rule: "→ 3.5" };
  return { score: 1.5, tier: `+${y.toFixed(0)}% YTD`, rule: "→ 1.5" };
}
const qualToScore = v => (v === 3 ? 9.5 : v === 2 ? 5 : v === 1 ? 1.5 : null);
function tierCatalystDays(d) {
  if (d == null) return { score: 0, tier: "No catalyst identified", rule: "→ 0 (heavy negative)" };
  if (d <= 7) return { score: 9.5, tier: `${d}d — imminent`, rule: "≤7d → 9.5" };
  if (d <= 15) return { score: 7.5, tier: `${d}d away`, rule: "8-15d → 7.5" };
  if (d <= 30) return { score: 5.5, tier: `${d}d away`, rule: "16-30d → 5.5" };
  if (d <= 60) return { score: 3.5, tier: `${d}d — beyond window`, rule: "31-60d → 3.5" };
  if (d <= 90) return { score: 1.5, tier: `${d}d — distant`, rule: "61-90d → 1.5" };
  return { score: 0, tier: `${d}d — too far`, rule: ">90d → 0" };
}
function tierConfidence(c) {
  if (c === "High") return { score: 9.5, tier: "High confidence", rule: "→ 9.5" };
  if (c === "Medium") return { score: 5.5, tier: "Medium confidence", rule: "→ 5.5" };
  if (c === "Low") return { score: 2, tier: "Low confidence", rule: "→ 2" };
  return { score: 0.5, tier: "Unconfirmed", rule: "→ 0.5" };
}

function computeStock(s, rules) {
  const trace = {};
  const pbVs = s.pb != null && s.peerPB != null ? (s.pb - s.peerPB) / s.peerPB * 100 : null;
  const a1 = tierPB(pbVs), a2 = tierPE(s.pe, s.indPE);
  trace.A = { components: [
    { name: "P/B vs peers", input: pbVs != null ? `${pbVs.toFixed(0)}% (P/B ${s.pb} vs peer ${s.peerPB})` : "N/A", ...a1, weight: 0.5 },
    { name: "P/E trajectory", input: s.pe != null ? `P/E ${s.pe}${s.indPE ? ` vs industry ${s.indPE}` : ""}` : "Pre-revenue", ...a2, weight: 0.5 },
  ]};
  const scoreA = a1.score * 0.5 + a2.score * 0.5;

  const b1 = tierPrice(s.price), b2 = tierVol(s.volume, rules), b3 = tierMktCap(s.mktCap, rules);
  trace.B = { components: [
    { name: "Price range", input: s.price != null ? `$${s.price}` : "—", ...b1, weight: 0.333 },
    { name: "Daily volume", input: s.volume != null ? s.volume.toLocaleString() : "—", ...b2, weight: 0.333 },
    { name: "Market cap", input: s.mktCap != null ? `$${s.mktCap}M` : "—", ...b3, weight: 0.333 },
  ]};
  const koB = [b1, b2, b3].some(x => x.score === "KO");
  const scoreB = koB ? null : ((b1.score ?? 5) + (b2.score ?? 5) + (b3.score ?? 5)) / 3;

  const c1 = tierDebtCash(s.debt, s.cash), c2 = tierRunway(s.cash, s.burnQ, rules);
  const belowCash = s.cash != null && s.sharesOut != null && s.price != null && s.price < s.cash / s.sharesOut;
  trace.C = { components: [
    { name: "Debt/Cash", input: s.debt != null && s.cash != null ? `$${s.debt}M / $${s.cash}M = ${s.cash ? (s.debt / s.cash).toFixed(2) : "—"}` : "—", ...c1, weight: 0.5 },
    { name: "Cash runway", input: s.cash != null && s.burnQ != null ? `$${s.cash}M cash, $${Math.abs(s.burnQ)}M/qtr burn` : "—", ...c2, weight: 0.5 },
    ...(belowCash ? [{ name: "💎 Below cash/share", input: `Price $${s.price} < cash/share $${(s.cash / s.sharesOut).toFixed(2)}`, score: "+1", tier: "Trading below cash pile", rule: "Bonus +1 (capped at 10)", weight: 0 }] : []),
  ]};
  const koC = c2.score === "KO";
  const scoreC = koC ? null : Math.min(10, c1.score * 0.5 + c2.score * 0.5 + (belowCash ? 1 : 0));
  const runwayYears = c2.years;

  const d1 = tierAnalysts(s.analysts, rules), d2 = tierUpside(s.target, s.price);
  trace.D = { components: [
    { name: "Analyst count", input: s.analysts ?? "—", ...d1, weight: 0.5 },
    { name: "Consensus upside", input: s.target != null ? `Target $${s.target} vs $${s.price}` : "—", ...d2, weight: 0.5 },
  ]};
  const scoreD = d1.score * 0.5 + d2.score * 0.5;

  const e1 = tierInsiderNet(s.insiderNet), e2 = tierInsiderFloor(s.insiderBuyPrice, s.price);
  trace.E = { components: [
    { name: "Net insider 12M", input: s.insiderNet != null ? `${s.insiderNet > 0 ? "+" : ""}${s.insiderNet.toLocaleString()} shares` : "—", ...e1, weight: 0.5 },
    { name: "Insider price floor", input: s.insiderBuyPrice != null ? `Largest buy @ $${s.insiderBuyPrice}` : "None on record", ...e2, weight: 0.5 },
  ]};
  const koE = e1.score === "KO";
  const scoreE = koE ? null : e1.score * 0.5 + e2.score * 0.5;

  const f1 = tier52w(s.price, s.low52), f2 = tierYTD(s.ytd);
  trace.F = { components: [
    { name: "52w low proximity", input: s.low52 != null ? `$${s.price} vs low $${s.low52}` : "—", ...f1, weight: 0.5 },
    { name: "YTD change", input: s.ytd != null ? `${s.ytd}%` : "—", ...f2, weight: 0.5 },
  ]};
  const scoreF = f1.score * 0.5 + f2.score * 0.5;

  const qual = (key, comps, labels) => {
    const rat = (s.qualRationale && s.qualRationale[key]) || {};
    const items = comps.map((v, i) => ({
      name: labels[i], input: v === 3 ? "High" : v === 2 ? "Medium" : v === 1 ? "Low" : "—",
      score: qualToScore(v) ?? "—", tier: v ? ["", "Low", "Medium", "High"][v] : "Unscored",
      rule: v ? ["", "Low→1.5", "Medium→5", "High→9.5"][v] : "Not yet scored", weight: 1 / comps.length,
      rationale: rat[i]?.text || "", sources: rat[i]?.sources || [],
    }));
    const scored = comps.filter(v => v != null);
    const score = scored.length ? comps.reduce((a, v) => a + (qualToScore(v) ?? 5), 0) / comps.length : null;
    return { items, score };
  };
  const G = qual("G", s.picpot || Array(6).fill(null), QUAL_LABELS.G);
  const H = qual("H", s.moat || Array(6).fill(null), QUAL_LABELS.H);
  const I = qual("I", s.mgmt || Array(5).fill(null), QUAL_LABELS.I);
  trace.G = { components: G.items, note: s.picpotNote };
  trace.H = { components: H.items, note: s.moatNote };
  trace.I = { components: I.items, note: s.mgmtNote, lastEarnings: s.lastEarnings };

  const days = s.catalystDate ? Math.max(0, Math.ceil((new Date(s.catalystDate) - new Date()) / 86400000)) : null;
  const j1 = tierCatalystDays(days), j2 = tierConfidence(s.catalystConfidence);
  const springConds = [
    { name: "Reverse split history", met: !!s.revSplit },
    { name: "In/near Penny Stock Hell", met: s.price != null && s.price < 1.5 },
    { name: "Runway ≥ 2y", met: (runwayYears != null && runwayYears >= 2) || c2.score === 9.5 },
    { name: "Net insider buying", met: s.insiderNet != null && s.insiderNet > 0 },
    { name: `≥${rules.minAnalysts} analysts`, met: s.analysts != null && s.analysts >= rules.minAnalysts },
    { name: "Catalyst ≤ 30d", met: days != null && days <= 30 },
  ];
  const springMet = springConds.filter(c => c.met).length;
  const lifecycle = s.revSplit && s.price < 1.5 ? 9.5 : s.ipoDecline != null && s.ipoDecline < -50 ? 7.5 : 5;
  trace.J = { components: [
    { name: "Days to catalyst", input: s.catalystDate ? `${s.catalystType || "Catalyst"} on ${s.catalystDate}` : "None set", ...j1, weight: 0.35 },
    { name: "Confidence", input: s.catalystConfidence || "—", ...j2, weight: 0.35 },
    { name: "Compressed spring", input: `${springMet}/6 conditions`, score: springMet >= 4 ? 7.5 : springMet >= 2 ? 4.5 : 2, tier: springMet === 6 ? "🌀 FULL SPRING" : springMet >= 4 ? "Partial spring" : "Not coiled", rule: springMet === 6 ? "All 6 → bonus +1" : `${springMet}/6`, weight: 0.15 },
    { name: "Lifecycle", input: s.revSplit ? `Rev split: ${s.revSplit}` : s.ipoDecline != null ? `${s.ipoDecline}% from IPO` : "Standard", score: lifecycle, tier: lifecycle === 9.5 ? "Post-split, beaten down" : lifecycle === 7.5 ? "Crushed IPO near inflection" : "Standard", rule: "Lifecycle tier", weight: 0.15 },
  ], springConds };
  const springBonus = springMet === 6 ? 1 : springMet >= 4 ? 0.5 : 0;
  const scoreJ = Math.min(10, j1.score * 0.35 + j2.score * 0.35 + (springMet >= 4 ? 7.5 : springMet >= 2 ? 4.5 : 2) * 0.15 + lifecycle * 0.15 + springBonus);

  const knockouts = [];
  if (s.poisonPill) knockouts.push({ name: "Poison Pill", rule: "Hard Veto #1: active poison pill" });
  if (b3.score === "KO") knockouts.push({ name: "Market Cap", rule: `Hard Veto #2: $${s.mktCap}M < $${rules.mktCapFloor}M` });
  if (b2.score === "KO") knockouts.push({ name: "Volume", rule: `Hard Veto #3: ${s.volume?.toLocaleString()} < ${rules.volHardVeto.toLocaleString()}` });
  if (koC) knockouts.push({ name: "Cash Runway", rule: "Hard Veto #4: runway < 6 months" });
  if (b1.score === "KO" && !(runwayYears >= 2 && days != null && days <= 30)) knockouts.push({ name: "Sub-$1", rule: "Hard Veto #5: < $1 without 2y runway + 30d catalyst" });
  if (koE) knockouts.push({ name: "Insider Selling", rule: "Hard Veto #6: sustained net insider selling" });

  const computedScores = { A: scoreA, B: scoreB, C: scoreC, D: scoreD, E: scoreE, F: scoreF, G: G.score, H: H.score, I: I.score, J: scoreJ };
  const ov = s.overrideScores || {};
  const scores = {};
  Object.keys(computedScores).forEach(k => { scores[k] = ov[k] && ov[k].value != null ? ov[k].value : computedScores[k]; });
  let composite = 0, wUsed = 0;
  Object.entries(scores).forEach(([k, v]) => { if (typeof v === "number") { composite += v * rules.weights[k]; wUsed += rules.weights[k]; } });
  composite = wUsed > 0 ? composite / wUsed : 0;

  const decision = knockouts.length ? "DISQUALIFIED" : composite >= rules.goThreshold ? "GO" : composite >= rules.watchThreshold ? "WATCH" : "NO-GO";
  const signals = [];
  if (knockouts.length) signals.push(...knockouts.map(k => ({ level: "RED", text: k.name, rule: k.rule })));
  if (runwayYears != null && runwayYears < rules.runwayMin && runwayYears >= rules.runwayVeto) signals.push({ level: "WATCH", text: `Runway ${runwayYears.toFixed(1)}y < ${rules.runwayMin}y min`, rule: "Heavy negative weight zone" });
  if (days != null && days <= 7) signals.push({ level: "WATCH", text: `Catalyst in ${days}d`, rule: "Imminent event" });
  if (days == null) signals.push({ level: "WATCH", text: "No catalyst identified", rule: "Heavy negative on Cluster J" });
  if (s.insiderNet != null && s.insiderNet < 0 && s.insiderNet >= -50000) signals.push({ level: "WATCH", text: "Slight insider selling", rule: "Below veto threshold but negative" });
  if (s.lastEarnings && (new Date() - new Date(s.lastEarnings)) / 86400000 > 90) signals.push({ level: "STALE", text: "Mgmt scores >90 days old", rule: "Refresh earnings call analysis" });
  const sigLevel = signals.some(x => x.level === "RED") ? "RED" : signals.some(x => x.level === "WATCH") ? "WATCH" : "CLEAR";
  return { scores, computedScores, overrideScores: ov, composite: Math.round(composite * 10) / 10, decision, knockouts, signals, sigLevel, trace, daysToCatalyst: days, springMet, runwayYears };
}

function computeMacro(m, rules) {
  const tiles = [
    { key: "cape", label: "Shiller CAPE", val: m.cape, color: m.cape == null ? "grey" : m.cape > rules.macro.capeRed ? "red" : m.cape > 20 ? "yellow" : "green", note: m.cape > rules.macro.capeRed ? "Extreme" : m.cape > 20 ? "Elevated" : "Normal", rule: `Red > ${rules.macro.capeRed}` },
    { key: "vix", label: "VIX", val: m.vix, color: m.vix == null ? "grey" : m.vix > rules.macro.vixBlackSwan ? "green" : m.vix > rules.macro.vixElevated ? "yellow" : "red", note: m.vix > rules.macro.vixBlackSwan ? "Black Swan Buy!" : m.vix > rules.macro.vixElevated ? "Elevated fear" : "Complacent", rule: `Buy signal > ${rules.macro.vixBlackSwan}` },
    { key: "fg", label: "Fear & Greed", val: m.fearGreed, color: m.fearGreed == null ? "grey" : m.fearGreed < rules.macro.fgFear ? "green" : m.fearGreed > rules.macro.fgGreed ? "red" : "yellow", note: m.fearGreed < rules.macro.fgFear ? "Extreme fear — buy" : m.fearGreed > rules.macro.fgGreed ? "Extreme greed" : "Neutral", rule: `Fear < ${rules.macro.fgFear}, Greed > ${rules.macro.fgGreed}` },
    { key: "buffett", label: "Buffett Ind.", val: m.buffett, color: m.buffett == null ? "grey" : m.buffett > rules.macro.buffettOver ? "red" : m.buffett > 115 ? "yellow" : "green", note: m.buffett > rules.macro.buffettOver ? "Sig. overvalued" : m.buffett > 115 ? "Overvalued" : "Fair", rule: `Red > ${rules.macro.buffettOver}%` },
    { key: "yield", label: "10Y Yield", val: m.yield10, color: m.yield10 == null ? "grey" : m.yield10 > rules.macro.yieldRestrictive ? "red" : m.yield10 > 4 ? "yellow" : "green", note: m.yield10 > rules.macro.yieldRestrictive ? "Restrictive" : "OK for growth", rule: `Red > ${rules.macro.yieldRestrictive}%` },
    { key: "margin", label: "Margin Debt", val: m.marginDebt, color: m.marginDebt == null ? "grey" : m.marginDebt > 900 ? "red" : m.marginDebt > 750 ? "yellow" : "green", note: m.marginDebt > 900 ? "Extreme" : m.marginDebt > 750 ? "Elevated" : "Normal", rule: "Red > $900B" },
  ];
  const reds = tiles.filter(t => t.color === "red").length, greens = tiles.filter(t => t.color === "green").length;
  const temp = reds >= 4 ? { label: "RED", advice: "Defensive mode. Reduce position sizes.", color: "#E85C5C" }
    : reds >= 2 ? { label: "YELLOW", advice: "Cautious. Smaller positions this week.", color: "#E0B554" }
    : greens >= 3 ? { label: "GREEN", advice: "Favorable conditions. Full deployment.", color: "#3DCC7E" }
    : { label: "NEUTRAL", advice: "Mixed signals. Normal sizing.", color: "#6B7A8F" };
  return { tiles, temp };
}

// Snapshot = frozen full state of a stock at import time
function makeSnapshot(s, calc, date) {
  return {
    date, price: s.price, composite: calc.composite, decision: calc.decision, sigLevel: calc.sigLevel,
    scores: { ...calc.scores }, computedScores: { ...calc.computedScores }, overrideScores: JSON.parse(JSON.stringify(calc.overrideScores || {})),
    picpot: [...(s.picpot || [])], moat: [...(s.moat || [])], mgmt: [...(s.mgmt || [])],
    qualRationale: JSON.parse(JSON.stringify(s.qualRationale || {})),
    catalystType: s.catalystType, catalystDate: s.catalystDate, catalystConfidence: s.catalystConfidence,
    daysToCatalyst: calc.daysToCatalyst, knockouts: calc.knockouts.map(k => k.name), held: !!s.held, entryPrice: s.entryPrice ?? null,
  };
}

const SAMPLE = {
  macro: { cape: 32.1, vix: 21.4, fearGreed: 62, buffett: 178, yield10: 4.3, marginDebt: 815 },
  sectors: [
    { name: "AI", etf: "BOTZ", change: 2.1 }, { name: "Quantum", etf: "QTUM", change: -3.4 },
    { name: "Uranium", etf: "URA", change: 4.8 }, { name: "Space", etf: "ARKX", change: -1.2 },
    { name: "Fertilizers", etf: "SOIL", change: 0.6 },
  ],
  headlines: [],
  closed: [
    { ticker: "SOUN", name: "SoundHound AI", entryPrice: 4.10, entryDate: "2026-03-15", exitPrice: 6.85, exitDate: "2026-05-02", gainPct: 67.1, reason: "Catalyst fired — earnings beat, took profit", finalScore: 7.4 },
  ],
  stocks: [
    { ticker: "ATYR", name: "aTyr Pharma", sector: "Biotech", held: true, entryPrice: 3.20, entryDate: "2026-04-10", shares: 1000,
      price: 4.12, prevPrice: 3.85, prevScore: 7.1, prevScores: { A: 4.6, B: 6.1, C: 8.0, D: 7.0, E: 7.2, F: 5.0, G: 7.0, H: 5.5, I: 8.0, J: 7.4 },
      pb: 4.2, peerPB: 5.1, pe: null, indPE: null, mktCap: 380, volume: 1850000, debt: 0, cash: 92, burnQ: -11, sharesOut: 92,
      analysts: 6, target: 18, insiderNet: 42000, insiderBuyPrice: 3.45, low52: 1.21, ytd: -12,
      catalystType: "Phase 3 Data", catalystDate: "2026-06-28", catalystConfidence: "High", revSplit: "1:14 (2019)", ipoDecline: -78, lastEarnings: "2026-05-08",
      picpot: [2, 3, 2, 2, 3, 3], moat: [1, 3, 2, 3, 2, 2], mgmt: [3, 3, 2, 3, 3],
      picpotNote: "Strong biotech narrative, Phase 3 timeliness peak", moatNote: "2yr lead in tRNA synthetase platform", mgmtNote: "CEO unscripted on May call",
      qualRationale: {
        G: { 0: { text: "Rare-disease drug — defined patient population, not everyday consumers. Moderate proximity.", sources: ["aTyr pipeline page"] },
             1: { text: "Disease-modifying for pulmonary sarcoidosis if MOA works — high impact.", sources: ["Phase 2 readout coverage"] },
             5: { text: "Phase 3 data due within weeks — timeliness at peak.", sources: ["Company guidance Q1'26"] } },
        I: { 0: { text: "May call visibly unscripted — CEO went deep on mechanism unprompted.", sources: ["Q1 2026 earnings transcript"] } },
      },
      overrideScores: {}, notebook: [{ date: "2026-06-01", text: "Phase 3 readout is the whole thesis. Everything else secondary until data drops." }],
      reviewedWeek: null, overrides: [], decisions: [{ date: "2026-06-01", action: "Hold", reason: "Catalyst approaching, thesis intact" }] },
    { ticker: "QBTS", name: "D-Wave Quantum", sector: "Quantum", held: true, entryPrice: 2.10, entryDate: "2026-05-01", shares: 1500,
      price: 1.74, prevPrice: 2.05, prevScore: 6.4, prevScores: { A: 3.5, B: 6.5, C: 5.2, D: 6.0, E: 3.0, F: 6.0, G: 7.3, H: 4.4, I: 5.0, J: 5.8 },
      pb: 8.1, peerPB: 6.2, pe: null, indPE: null, mktCap: 410, volume: 3200000, debt: 12, cash: 64, burnQ: -16, sharesOut: 180,
      analysts: 5, target: 3.5, insiderNet: -8000, insiderBuyPrice: null, low52: 1.52, ytd: -38,
      catalystType: "Earnings Call", catalystDate: "2026-07-30", catalystConfidence: "Medium", revSplit: null, ipoDecline: -82, lastEarnings: "2026-02-20",
      picpot: [2, 3, 2, 2, 3, 2], moat: [1, 2, 1, 2, 2, 2], mgmt: [2, 2, 2, 2, 2],
      picpotNote: "Quantum hype cyclical", moatNote: "Annealing niche vs gate-based rivals", mgmtNote: "Scripted Feb call, vague on bookings",
      overrideScores: {}, notebook: [],
      overrides: [{ date: "2026-05-25", signal: "Slight insider selling", reason: "Single CFO sale, tax-related per filing", weeks: 3 }],
      decisions: [{ date: "2026-05-25", action: "Hold", reason: "Override insider flag — tax sale" }] },
    { ticker: "LEU", name: "Centrus Energy", sector: "Uranium", held: false, entryPrice: null, entryDate: null,
      price: 4.45, prevPrice: 4.02, prevScore: 6.8, prevScores: { A: 7.0, B: 5.5, C: 9.5, D: 5.5, E: 5.8, F: 4.5, G: 7.0, H: 6.5, I: 6.8, J: 6.2 },
      pb: 3.8, peerPB: 4.5, pe: 12, indPE: 18, mktCap: 720, volume: 950000, debt: 18, cash: 210, burnQ: 8, sharesOut: 160,
      analysts: 4, target: 9, insiderNet: 15000, insiderBuyPrice: 3.90, low52: 2.80, ytd: -22,
      catalystType: "DOE Contract", catalystDate: "2026-06-20", catalystConfidence: "Medium", revSplit: null, ipoDecline: null, lastEarnings: "2026-04-30",
      picpot: [3, 3, 2, 2, 2, 3], moat: [2, 3, 2, 3, 1, 3], mgmt: [2, 3, 2, 2, 3],
      picpotNote: "US enrichment sovereignty story", moatNote: "Only US HALEU producer", mgmtNote: "Direct on DOE timeline",
      overrideScores: {}, notebook: [], overrides: [], decisions: [] },
  ],
  snapshots: {
    ATYR: [
      { date: "2026-05-25", price: 3.60, composite: 6.9, decision: "WATCH", sigLevel: "WATCH", scores: { A: 4.5, B: 6.5, C: 8.0, D: 6.8, E: 7.0, F: 6.0, G: 6.8, H: 5.5, I: 7.5, J: 6.5 }, picpot: [2,3,2,2,2,3], moat: [1,3,2,3,2,2], mgmt: [3,3,2,2,3], qualRationale: {}, catalystType: "Phase 3 Data", catalystDate: "2026-06-28", catalystConfidence: "High", daysToCatalyst: 34, knockouts: [], held: true, entryPrice: 3.20 },
      { date: "2026-06-01", price: 3.85, composite: 7.1, decision: "WATCH", sigLevel: "WATCH", scores: { A: 4.6, B: 6.1, C: 8.0, D: 7.0, E: 7.2, F: 5.0, G: 7.0, H: 5.5, I: 8.0, J: 7.4 }, picpot: [2,3,2,2,3,3], moat: [1,3,2,3,2,2], mgmt: [3,3,2,3,3], qualRationale: {}, catalystType: "Phase 3 Data", catalystDate: "2026-06-28", catalystConfidence: "High", daysToCatalyst: 27, knockouts: [], held: true, entryPrice: 3.20 },
    ],
    QBTS: [
      { date: "2026-06-01", price: 2.05, composite: 6.4, decision: "WATCH", sigLevel: "WATCH", scores: { A: 3.5, B: 6.5, C: 5.2, D: 6.0, E: 3.0, F: 6.0, G: 7.3, H: 4.4, I: 5.0, J: 5.8 }, picpot: [2,3,2,2,3,2], moat: [1,2,1,2,2,2], mgmt: [2,2,2,2,2], qualRationale: {}, catalystType: "Earnings Call", catalystDate: "2026-07-30", catalystConfidence: "Medium", daysToCatalyst: 59, knockouts: [], held: true, entryPrice: 2.10 },
    ],
  },
  journal: [
    { week: "2026-06-01", ticker: "ATYR", decision: "GO", score: 7.1, priceScreen: 3.85, priceReview: 4.12, catalystFired: "No", thesisHeld: "Yes", right: "Insider buying continued, analyst upgrade", wrong: "", notes: "Holding into Phase 3 data" },
    { week: "2026-06-01", ticker: "QBTS", decision: "WATCH", score: 6.4, priceScreen: 2.05, priceReview: 1.74, catalystFired: "No", thesisHeld: "Partial", right: "", wrong: "Quantum sector -3.4%, dragged with peers", notes: "Override on insider flag still active" },
  ],
};

const COLORS = {
  bg: "#0E1420", panel: "#161F30", panelLight: "#1D2940", border: "#2A3A57",
  text: "#E8EDF5", dim: "#8A99B5", gold: "#E0B554", green: "#3DCC7E", red: "#E85C5C", yellow: "#E0B554", blue: "#5B8DD9",
};
const sigColor = l => (l === "RED" ? COLORS.red : l === "WATCH" ? COLORS.yellow : COLORS.green);
const tileColor = c => (c === "red" ? COLORS.red : c === "yellow" ? COLORS.yellow : c === "green" ? COLORS.green : COLORS.dim);
const decColor = d => (d === "GO" ? COLORS.green : d === "WATCH" ? COLORS.yellow : COLORS.red);
const scoreColor = v => (typeof v !== "number" ? COLORS.red : v >= 7 ? COLORS.green : v >= 4 ? COLORS.yellow : COLORS.red);

function Delta({ v, suffix = "" }) {
  if (v == null) return <span style={{ color: COLORS.dim }}>—</span>;
  return <span style={{ color: v > 0 ? COLORS.green : v < 0 ? COLORS.red : COLORS.dim, fontWeight: 600 }}>{v > 0 ? "▲" : v < 0 ? "▼" : "•"} {Math.abs(v).toFixed(1)}{suffix}</span>;
}
function ScoreRing({ score, size = 52, decision }) {
  const pct = score != null ? Math.min(score / 10, 1) : 0, r = size / 2 - 4, c = 2 * Math.PI * r;
  const col = decision ? decColor(decision) : COLORS.gold;
  return (
    <svg width={size} height={size}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={COLORS.border} strokeWidth="4" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={col} strokeWidth="4" strokeDasharray={`${c * pct} ${c}`} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="54%" textAnchor="middle" dominantBaseline="middle" fill={COLORS.text} fontSize={size / 3.4} fontWeight="700">{score != null ? score.toFixed(1) : "—"}</text>
    </svg>
  );
}
function HeadlineList({ items }) {
  if (!items?.length) return null;
  return (
    <div style={{ marginTop: 8, background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "8px 14px" }}>
      {items.map((h, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "5px 0", borderBottom: i < items.length - 1 ? `1px solid ${COLORS.border}` : "none", fontSize: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: h.impact === "tailwind" ? COLORS.green : h.impact === "headwind" ? COLORS.red : COLORS.dim, minWidth: 68, textTransform: "uppercase" }}>{h.impact}</span>
          {h.sector && h.sector !== "General" && <span style={{ color: COLORS.gold, fontWeight: 600, minWidth: 64 }}>{h.sector}</span>}
          <span style={{ flex: 1 }}>{h.headline}</span>
          {h.url && <a href={h.url} target="_blank" rel="noopener noreferrer" title="Read source" style={{ color: COLORS.blue, textDecoration: "none", fontSize: 12 }}>↗</a>}
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [data, setData] = useState(SAMPLE);
  const [rules] = useState(DEFAULT_RULES);
  const [room, setRoom] = useState("cockpit");
  const [selStock, setSelStock] = useState(null);
  const [selCluster, setSelCluster] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newTicker, setNewTicker] = useState("");
  const [newName, setNewName] = useState("");
  const [newSector, setNewSector] = useState("");
  const [fetchingTicker, setFetchingTicker] = useState(null);
  const [fetchMsg, setFetchMsg] = useState("");
  const [headlinesLoading, setHeadlinesLoading] = useState(false);
  const [drillTile, setDrillTile] = useState(null);
  const [journalEdit, setJournalEdit] = useState(null);
  const [briefModal, setBriefModal] = useState(null);
  const [syncModal, setSyncModal] = useState(false);
  const [syncText, setSyncText] = useState("");
  const [syncError, setSyncError] = useState("");
  const [editComp, setEditComp] = useState(null);
  const [clusterOvEdit, setClusterOvEdit] = useState(null);
  const [histDate, setHistDate] = useState(null);
  const [copyMsg, setCopyMsg] = useState("");

  useEffect(() => {
    try {
      const r = localStorage.getItem("screener-data-v3");
      if (r) setData(JSON.parse(r));
    } catch (e) { console.error("load failed", e); }
  }, []);
  const persist = useCallback(d => {
    setData(d);
    try { localStorage.setItem("screener-data-v3", JSON.stringify(d)); } catch (e) { console.error("save failed", e); }
  }, []);

  const macro = computeMacro(data.macro, rules);
  const computed = data.stocks.map(s => ({ ...s, calc: computeStock(s, rules) }));
  const sorted = [...computed].sort((a, b) => b.calc.composite - a.calc.composite);
  const positions = computed.filter(s => s.held && s.entryPrice != null);
  const watchlist = computed.filter(s => !(s.held && s.entryPrice != null));

  const attention = [];
  computed.forEach(s => s.calc.signals.filter(x => x.level === "RED").forEach(sig => attention.push({ pri: 0, icon: "🔴", text: `${s.ticker} — ${sig.text}`, rule: sig.rule, ticker: s.ticker })));
  computed.forEach(s => { if (s.calc.daysToCatalyst != null && s.calc.daysToCatalyst <= 7) attention.push({ pri: 1, icon: "🟠", text: `${s.ticker} — ${s.catalystType} in ${s.calc.daysToCatalyst}d`, rule: "Catalyst imminent", ticker: s.ticker }); });
  computed.forEach(s => { const d = s.prevScore != null ? s.calc.composite - s.prevScore : 0; if (d <= -1) attention.push({ pri: 2, icon: "🟠", text: `${s.ticker} — score dropped ${Math.abs(d).toFixed(1)}`, rule: "Biggest weekly mover", ticker: s.ticker }); });
  computed.forEach(s => { if (s.calc.signals.some(x => x.level === "STALE")) attention.push({ pri: 3, icon: "🟡", text: `${s.ticker} — stale mgmt scores (>90d)`, rule: "Refresh earnings analysis", ticker: s.ticker }); });
  computed.forEach(s => (s.overrides || []).forEach(o => { if (o.weeks >= 3) attention.push({ pri: 4, icon: "🟡", text: `${s.ticker} — override active ${o.weeks}w unreviewed`, rule: o.reason, ticker: s.ticker }); }));
  attention.sort((a, b) => a.pri - b.pri);

  const openDesk = t => { setSelStock(t); setSelCluster(null); setHistDate(null); setRoom("desk"); };

  const fetchHeadlines = async () => {
    setHeadlinesLoading(true);
    try {
      const sectorList = data.sectors.map(s => s.name).join(", ");
      const tickers = data.stocks.map(s => s.ticker).join(", ");
      const resp = await fetch("/api/headlines", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectorList, tickers }),
      });
      const d = await resp.json();
      if (d.error) { setFetchMsg(`Headlines failed: ${d.error}`); setHeadlinesLoading(false); return; }
      const text = (d.content || []).filter(i => i.type === "text").map(i => i.text).join("\n");
      const clean = text.replace(/```json|```/g, "").trim();
      const st = clean.indexOf("["), en = clean.lastIndexOf("]");
      if (st >= 0 && en > st) await persist({ ...data, headlines: JSON.parse(clean.slice(st, en + 1)), headlinesDate: new Date().toISOString().slice(0, 10) });
    } catch (e) { console.error(e); setFetchMsg(`Headlines failed: ${e.message}`); }
    setHeadlinesLoading(false);
  };

  // ─── LSEG quant fetch ───────────────────────────────────────────────────
  // Calls our own backend (/api/quant), which holds the key and talks to LSEG.
  const fetchQuant = async (ticker) => {
    const resp = await fetch("/api/quant", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker }),
    });
    const d = await resp.json();
    if (d.error) throw new Error(d.error || "API error");
    const text = (d.content || []).filter(i => i.type === "text").map(i => i.text).join("\n");
    const clean = text.replace(/```json|```/g, "").trim();
    const st = clean.indexOf("{"), en = clean.lastIndexOf("}");
    if (st < 0 || en < 0) throw new Error("LSEG returned no parseable data" + (text ? `: ${text.slice(0, 160)}` : "."));
    return JSON.parse(clean.slice(st, en + 1));
  };

  const QUANT_KEYS = ["price", "pb", "peerPB", "pe", "indPE", "mktCap", "volume", "debt", "cash", "burnQ", "sharesOut", "analysts", "target", "low52", "ytd", "insiderNet", "insiderBuyPrice"];
  const applyQuant = (stock, obj) => {
    const f = obj.fields || {};
    const merged = { ...stock };
    QUANT_KEYS.forEach(k => { if (f[k] != null) merged[k] = f[k]; }); // only overwrite what came back; manual values survive a partial fetch
    if (obj.name && (!merged.name || merged.name === merged.ticker)) merged.name = obj.name;
    merged.lastFetch = { date: new Date().toISOString().slice(0, 10), missing: obj.missing || [], notes: obj.notes || "", currency: obj.currency || "" };
    return merged;
  };

  const addStock = async () => {
    const t = newTicker.trim().toUpperCase();
    if (!t) return;
    if (data.stocks.find(s => s.ticker === t)) { setFetchMsg(`${t} is already in your list.`); return; }
    setFetchingTicker("__add__"); setFetchMsg("");
    let shell = { ticker: t, name: newName.trim() || t, sector: newSector.trim() || "", held: false, entryPrice: null,
      picpot: Array(6).fill(null), moat: Array(6).fill(null), mgmt: Array(5).fill(null), qualRationale: {}, overrideScores: {}, notebook: [], overrides: [], decisions: [] };
    try {
      const obj = await fetchQuant(t);
      shell = applyQuant(shell, obj);
      if (newSector.trim()) shell.sector = newSector.trim();
      const miss = obj.missing || [];
      setFetchMsg(miss.length ? `Added ${t}. LSEG didn't return: ${miss.join(", ")} — fill those manually.` : `Added ${t}. All quant fields fetched from LSEG.`);
    } catch (e) {
      setFetchMsg(`Added ${t} as a blank shell. LSEG fetch failed: ${e.message}. Enter the quant by hand.`);
    }
    await persist({ ...data, stocks: [...data.stocks, shell] });
    setFetchingTicker(null); setShowAdd(false); setNewTicker(""); setNewName(""); setNewSector("");
    openDesk(t);
  };

  const refreshQuant = async (ticker) => {
    setFetchingTicker(ticker); setFetchMsg("");
    try {
      const obj = await fetchQuant(ticker);
      const stocks = data.stocks.map(s => {
        if (s.ticker !== ticker) return s;
        const exCalc = computeStock(s, rules);
        const next = applyQuant(s, obj);
        next.prevPrice = s.price ?? null; next.prevScore = exCalc.composite; next.prevScores = exCalc.scores;
        return next;
      });
      await persist({ ...data, stocks });
      const miss = obj.missing || [];
      setFetchMsg(miss.length ? `Refreshed ${ticker}. LSEG didn't return: ${miss.join(", ")}.` : `Refreshed ${ticker}. All quant fields fetched.`);
    } catch (e) {
      setFetchMsg(`Refresh failed for ${ticker}: ${e.message}`);
    }
    setFetchingTicker(null);
  };

  const logOverride = async (ticker, signalText) => {
    const reason = prompt(`Override "${signalText}" on ${ticker} — one-line reason:`);
    if (reason == null) return;
    const stocks = data.stocks.map(s => s.ticker === ticker ? { ...s, overrides: [...(s.overrides || []), { date: new Date().toISOString().slice(0, 10), signal: signalText, reason, weeks: 0 }] } : s);
    await persist({ ...data, stocks });
  };
  const setClusterOverride = async (ticker, cluster, value, reason) => {
    const stocks = data.stocks.map(s => {
      if (s.ticker !== ticker) return s;
      const o = { ...(s.overrideScores || {}) };
      if (value == null || value === "") delete o[cluster];
      else o[cluster] = { value: parseFloat(value), reason: reason || "", date: new Date().toISOString().slice(0, 10) };
      return { ...s, overrideScores: o };
    });
    await persist({ ...data, stocks }); setClusterOvEdit(null);
  };
  const setQualComponent = async (ticker, cluster, idx, score, text, sourcesStr) => {
    const arrKey = cluster === "G" ? "picpot" : cluster === "H" ? "moat" : "mgmt";
    const stocks = data.stocks.map(s => {
      if (s.ticker !== ticker) return s;
      const arr = [...(s[arrKey] || Array(cluster === "I" ? 5 : 6).fill(null))];
      if (score != null) arr[idx] = parseInt(score);
      const qr = { ...(s.qualRationale || {}) }; qr[cluster] = { ...(qr[cluster] || {}) };
      qr[cluster][idx] = { text: text ?? qr[cluster][idx]?.text ?? "", sources: sourcesStr != null ? sourcesStr.split(",").map(x => x.trim()).filter(Boolean) : (qr[cluster][idx]?.sources || []) };
      return { ...s, [arrKey]: arr, qualRationale: qr };
    });
    await persist({ ...data, stocks }); setEditComp(null);
  };
  const updateStockField = async (ticker, field, value) => {
    const stocks = data.stocks.map(s => s.ticker === ticker ? { ...s, [field]: value === "" ? null : value } : s);
    await persist({ ...data, stocks });
  };
  const addNote = async (ticker, text) => {
    if (!text) return;
    const stocks = data.stocks.map(s => s.ticker === ticker ? { ...s, notebook: [{ date: new Date().toISOString().slice(0, 10), text }, ...(s.notebook || [])] } : s);
    await persist({ ...data, stocks });
  };

  // Verdict actions — drive positions
  const doVerdict = async (ticker, action) => {
    const s = data.stocks.find(x => x.ticker === ticker);
    const today = new Date().toISOString().slice(0, 10);
    if (action === "Add") {
      const priceStr = prompt(`Add ${ticker} — entry price (you'll mirror this on IBKR):`, s.price ?? "");
      if (priceStr == null) return;
      const price = parseFloat(priceStr); if (isNaN(price)) return;
      const sharesStr = prompt("Shares (optional):", s.shares ?? "");
      const reason = prompt("One-line reason:") || "";
      const stocks = data.stocks.map(x => {
        if (x.ticker !== ticker) return x;
        let entryPrice = price, shares = sharesStr ? parseFloat(sharesStr) : x.shares;
        if (x.held && x.entryPrice != null && x.shares && shares) { // average up/down
          const totOld = x.entryPrice * x.shares, totNew = price * (parseFloat(sharesStr) || 0);
          const totShares = x.shares + (parseFloat(sharesStr) || 0);
          entryPrice = totShares ? (totOld + totNew) / totShares : price; shares = totShares;
        }
        return { ...x, held: true, entryPrice: Math.round(entryPrice * 100) / 100, entryDate: x.entryDate || today, shares,
          decisions: [...(x.decisions || []), { date: today, action: "Add", reason: `@ $${price}${sharesStr ? ` × ${sharesStr}` : ""} — ${reason}` }], reviewedWeek: today };
      });
      await persist({ ...data, stocks });
    } else if (action === "Exit") {
      const priceStr = prompt(`Exit ${ticker} — exit price:`, s.price ?? "");
      if (priceStr == null) return;
      const exitPrice = parseFloat(priceStr); if (isNaN(exitPrice)) return;
      const reason = prompt("One-line reason for exit:") || "";
      const gainPct = s.entryPrice ? Math.round((exitPrice - s.entryPrice) / s.entryPrice * 1000) / 10 : null;
      const calc = computeStock(s, rules);
      const closed = [{ ticker, name: s.name, entryPrice: s.entryPrice, entryDate: s.entryDate, exitPrice, exitDate: today, gainPct, reason, finalScore: calc.composite }, ...(data.closed || [])];
      const stocks = data.stocks.map(x => x.ticker === ticker ? { ...x, held: false, entryPrice: null, shares: null,
        decisions: [...(x.decisions || []), { date: today, action: "Exit", reason: `@ $${exitPrice} (${gainPct != null ? (gainPct >= 0 ? "+" : "") + gainPct + "%" : "—"}) — ${reason}` }], reviewedWeek: today } : x);
      await persist({ ...data, stocks, closed });
    } else { // Hold / Trim
      const reason = prompt(`${action} ${ticker} — one-line reason:`); if (reason == null) return;
      const stocks = data.stocks.map(x => x.ticker === ticker ? { ...x, decisions: [...(x.decisions || []), { date: today, action, reason }], reviewedWeek: today } : x);
      await persist({ ...data, stocks });
    }
  };

  const deleteStock = async (ticker) => {
    if (!confirm(`Delete ${ticker} and ALL its history/snapshots? This frees storage and cannot be undone.`)) return;
    const stocks = data.stocks.filter(s => s.ticker !== ticker);
    const snapshots = { ...(data.snapshots || {}) }; delete snapshots[ticker];
    await persist({ ...data, stocks, snapshots });
    setSelStock(null); setRoom("cockpit");
  };
  const pruneSnapshots = async (ticker, beforeDate) => {
    const snapshots = { ...(data.snapshots || {}) };
    snapshots[ticker] = (snapshots[ticker] || []).filter(s => s.date >= beforeDate);
    await persist({ ...data, snapshots });
  };

  const buildBrief = (s) => {
    const c = s.calc, L = [];
    L.push(`POSITION BRIEF — ${s.ticker} (${s.name}) · ${s.sector}`);
    L.push(`Generated ${new Date().toISOString().slice(0, 10)} from The Screener`);
    L.push(`${s.held && s.entryPrice ? `HELD — entry $${s.entryPrice}${s.shares ? ` × ${s.shares}` : ""} since ${s.entryDate}` : "Watchlist"} · current price $${s.price ?? "?"}`);
    L.push(`Composite ${c.composite} → ${c.decision} · signal ${c.sigLevel}`);
    if (c.daysToCatalyst != null) L.push(`Catalyst: ${s.catalystType} in ${c.daysToCatalyst}d (${s.catalystConfidence} confidence)`);
    if (c.knockouts.length) L.push(`KNOCKOUTS: ${c.knockouts.map(k => k.name).join(", ")}`);
    L.push(""); L.push("CLUSTER SCORES:");
    Object.keys(CLUSTER_NAMES).forEach(k => {
      const v = c.scores[k], comp = c.computedScores[k], o = c.overrideScores[k];
      let line = `  ${k} ${CLUSTER_NAMES[k]} (w${(rules.weights[k] * 100).toFixed(0)}%): ${typeof v === "number" ? v.toFixed(1) : v ?? "—"}`;
      if (o && o.value != null) line += ` [OVERRIDE from ${typeof comp === "number" ? comp.toFixed(1) : comp}: ${o.reason}]`;
      L.push(line);
      if (["G", "H", "I"].includes(k)) c.trace[k].components.forEach(c2 => { if (c2.input !== "—" || c2.rationale) L.push(`     - ${c2.name}: ${c2.input}${c2.rationale ? ` — ${c2.rationale}` : ""}${c2.sources?.length ? ` [${c2.sources.join("; ")}]` : ""}`); });
    });
    if ((s.notebook || []).length) { L.push(""); L.push("NOTEBOOK:"); s.notebook.forEach(n => L.push(`  ${n.date}: ${n.text}`)); }
    L.push(""); L.push("Help me reassess the qualitative scores (PICPOT=G, moat=H, management=I). Research current sources. For each component propose Low/Medium/High with reasoning + sources. When done, give me a JSON block in EXACTLY this shape so I can sync it back:");
    L.push(`{"ticker":"${s.ticker}","G":[{"score":2,"rationale":"...","sources":["..."]}, ...6 items],"H":[...6],"I":[...5]}`);
    L.push("Score: 1=Low, 2=Medium, 3=High. Include all components even if unchanged.");
    return L.join("\n");
  };

  const applySync = async () => {
    setSyncError("");
    try {
      const start = syncText.indexOf("{"), end = syncText.lastIndexOf("}");
      if (start < 0 || end < 0) { setSyncError("No JSON object found. Paste the block Claude gave you, including the { } braces."); return; }
      let obj;
      try { obj = JSON.parse(syncText.slice(start, end + 1)); }
      catch (e) { setSyncError("JSON didn't parse: " + e.message + ". Make sure you copied the whole block."); return; }
      if (!obj.ticker) { setSyncError('Missing "ticker" field in the JSON.'); return; }
      if (!data.stocks.find(s => s.ticker === obj.ticker)) { setSyncError(`Ticker ${obj.ticker} isn't in your list.`); return; }
      const stocks = data.stocks.map(s => {
        if (s.ticker !== obj.ticker) return s;
        const next = { ...s };
        ["G", "H", "I"].forEach(cl => {
          if (Array.isArray(obj[cl])) {
            const arrKey = cl === "G" ? "picpot" : cl === "H" ? "moat" : "mgmt";
            const arr = [...(next[arrKey] || Array(cl === "I" ? 5 : 6).fill(null))];
            const qr = { ...(next.qualRationale || {}) }; qr[cl] = { ...(qr[cl] || {}) };
            obj[cl].forEach((comp, i) => { if (comp && comp.score != null) arr[i] = comp.score; if (comp) qr[cl][i] = { text: comp.rationale || qr[cl][i]?.text || "", sources: comp.sources || qr[cl][i]?.sources || [] }; });
            next[arrKey] = arr; next.qualRationale = qr;
          }
        });
        return next;
      });
      await persist({ ...data, stocks });
      setSyncModal(false); setSyncText(""); setSyncError("");
    } catch (e) { setSyncError("Unexpected error: " + e.message); }
  };

  const copyText = (text) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => { setCopyMsg("Copied!"); setTimeout(() => setCopyMsg(""), 1500); })
          .catch(() => { selectFallback(); });
      } else selectFallback();
    } catch { selectFallback(); }
    function selectFallback() {
      const ta = document.getElementById("briefTextArea");
      if (ta) { ta.focus(); ta.select(); try { document.execCommand("copy"); setCopyMsg("Copied!"); } catch { setCopyMsg("Press Ctrl+C to copy the selected text"); } setTimeout(() => setCopyMsg(""), 2500); }
    }
  };

  const snapshotToJournal = async () => {
    const week = new Date().toISOString().slice(0, 10);
    const entries = computed.map(s => ({ week, ticker: s.ticker, decision: s.calc.decision, score: s.calc.composite, priceScreen: s.price, priceReview: null, catalystFired: "", thesisHeld: "", right: "", wrong: "", notes: "" }));
    // Also freeze immutable full-state snapshots — this is the weekly cycle marker now that Excel import is gone.
    const snapshots = JSON.parse(JSON.stringify(data.snapshots || {}));
    computed.forEach(s => {
      if (!snapshots[s.ticker]) snapshots[s.ticker] = [];
      const snap = makeSnapshot(s, s.calc, week);
      const last = snapshots[s.ticker][snapshots[s.ticker].length - 1];
      if (!last || last.date !== week) snapshots[s.ticker].push(snap);
      else snapshots[s.ticker][snapshots[s.ticker].length - 1] = snap;
    });
    await persist({ ...data, journal: [...entries, ...(data.journal || [])], snapshots });
    setRoom("journal");
  };
  const updateJournal = async (i, field, value) => {
    const journal = [...data.journal];
    journal[i] = { ...journal[i], [field]: field.startsWith("price") ? (parseFloat(value) || null) : value };
    await persist({ ...data, journal });
  };

  const sel = selStock ? computed.find(s => s.ticker === selStock) : null;
  const generalHeadlines = (data.headlines || []).filter(h => h.sector === "General");
  const sectorHeadlines = (data.headlines || []).filter(h => h.sector !== "General");
  const journal = data.journal || [];
  const reviewed = journal.filter(j => j.priceReview != null && j.priceScreen != null);
  const avgReturn = reviewed.length ? reviewed.reduce((a, j) => a + (j.priceReview - j.priceScreen) / j.priceScreen * 100, 0) / reviewed.length : null;
  const goEntries = reviewed.filter(j => j.decision === "GO");
  const goAvg = goEntries.length ? goEntries.reduce((a, j) => a + (j.priceReview - j.priceScreen) / j.priceScreen * 100, 0) / goEntries.length : null;
  const thesisYes = journal.filter(j => j.thesisHeld === "Yes").length, thesisTotal = journal.filter(j => j.thesisHeld).length;
  const inp = { width: "100%", background: COLORS.bg, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: 6, marginTop: 4, boxSizing: "border-box", fontFamily: "inherit" };

  return (
    <div style={{ fontFamily: "'Segoe UI', system-ui, sans-serif", background: COLORS.bg, minHeight: "100vh", color: COLORS.text }}>
      {/* NAV */}
      <div style={{ display: "flex", alignItems: "center", padding: "14px 20px", borderBottom: `1px solid ${COLORS.border}`, gap: 14, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 800, fontSize: 17 }}>⚡ THE SCREENER</div>
        {[["cockpit", "🛩 Cockpit"], ["desk", "📋 Trading Desk"], ["positions", "💼 Positions"], ["journal", "📓 Journal"], ["lab", "🧪 Lab"]].map(([r, lbl]) => (
          <button key={r} onClick={() => { setRoom(r); if (r !== "desk") { setSelStock(null); setSelCluster(null); } }}
            style={{ background: room === r ? COLORS.panelLight : "transparent", color: room === r ? COLORS.gold : COLORS.dim, border: `1px solid ${room === r ? COLORS.gold : "transparent"}`, borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>{lbl}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={snapshotToJournal} style={{ background: COLORS.panelLight, color: COLORS.blue, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "7px 14px", cursor: "pointer", fontWeight: 600, fontSize: 12 }}>📸 Snapshot week</button>
        <button onClick={() => { setShowAdd(true); setFetchMsg(""); }} style={{ background: COLORS.gold, color: "#1B2A4A", border: "none", borderRadius: 8, padding: "7px 16px", cursor: "pointer", fontWeight: 700, fontSize: 13 }}>＋ Add ticker</button>
      </div>

      {/* FETCH STATUS TOAST */}
      {fetchMsg && (
        <div onClick={() => setFetchMsg("")} style={{ background: COLORS.panelLight, borderBottom: `1px solid ${COLORS.border}`, padding: "8px 20px", fontSize: 12, color: COLORS.text, cursor: "pointer", display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ color: COLORS.blue }}>LSEG</span><span>{fetchMsg}</span><span style={{ marginLeft: "auto", color: COLORS.dim }}>dismiss ✕</span>
        </div>
      )}

      {/* ADD TICKER MODAL */}
      {showAdd && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.gold}`, borderRadius: 14, padding: 24, width: "min(460px, 92vw)" }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>＋ Add a ticker</div>
            <div style={{ color: COLORS.dim, fontSize: 12, marginBottom: 14 }}>Enter a ticker and the app pulls the quant from LSEG (price, balance sheet, analysts, insider, peers). Catalyst and the qualitative scores you add afterward. Anything LSEG misses, you fill by hand.</div>
            <label style={{ fontSize: 11, color: COLORS.dim }}>Ticker (required)<br />
              <input autoFocus value={newTicker} onChange={e => setNewTicker(e.target.value)} placeholder="e.g. GROY" onKeyDown={e => { if (e.key === "Enter" && newTicker.trim()) addStock(); }} style={{ ...inp, textTransform: "uppercase" }} /></label>
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <label style={{ fontSize: 11, color: COLORS.dim, flex: 1 }}>Name (optional)<br /><input value={newName} onChange={e => setNewName(e.target.value)} placeholder="auto from LSEG" style={inp} /></label>
              <label style={{ fontSize: 11, color: COLORS.dim, flex: 1 }}>Sector (optional)<br /><input value={newSector} onChange={e => setNewSector(e.target.value)} placeholder="e.g. Gold" style={inp} /></label>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 16, justifyContent: "flex-end" }}>
              <button onClick={() => { setShowAdd(false); setNewTicker(""); setNewName(""); setNewSector(""); }} style={{ background: "transparent", color: COLORS.dim, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "8px 16px", cursor: "pointer" }}>Cancel</button>
              <button onClick={addStock} disabled={fetchingTicker === "__add__" || !newTicker.trim()} style={{ background: COLORS.gold, color: "#1B2A4A", border: "none", borderRadius: 8, padding: "8px 18px", cursor: fetchingTicker === "__add__" ? "wait" : "pointer", fontWeight: 700, opacity: !newTicker.trim() ? 0.5 : 1 }}>{fetchingTicker === "__add__" ? "Fetching from LSEG…" : "Add & fetch"}</button>
            </div>
          </div>
        </div>
      )}

      {/* BRIEF MODAL */}
      {briefModal && (() => {
        const s = computed.find(x => x.ticker === briefModal); const text = buildBrief(s);
        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.green}`, borderRadius: 14, padding: 24, width: "min(720px, 94vw)" }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>💬 Discuss {briefModal} with Claude</div>
              <div style={{ color: COLORS.dim, fontSize: 12, marginBottom: 12 }}>Copy this and paste into any Claude chat (even a brand-new one — this is how context survives a full conversation). We discuss, then Claude hands you a JSON block. Paste that into "Sync Claude's scores" to load it.</div>
              <textarea id="briefTextArea" readOnly value={text} onFocus={e => e.target.select()} style={{ ...inp, height: 280, fontSize: 11, fontFamily: "monospace" }} />
              <div style={{ display: "flex", gap: 10, marginTop: 12, justifyContent: "flex-end", alignItems: "center" }}>
                {copyMsg && <span style={{ fontSize: 12, color: COLORS.green }}>{copyMsg}</span>}
                <button onClick={() => copyText(text)} style={{ background: COLORS.green, color: "#0E1420", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontWeight: 700 }}>📋 Copy</button>
                <button onClick={() => { setBriefModal(null); setCopyMsg(""); }} style={{ background: "transparent", color: COLORS.dim, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "8px 16px", cursor: "pointer" }}>Close</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* SYNC MODAL */}
      {syncModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.blue}`, borderRadius: 14, padding: 24, width: "min(720px, 94vw)" }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>⬇ Sync Claude's scores</div>
            <div style={{ color: COLORS.dim, fontSize: 12, marginBottom: 12 }}>Paste the JSON block Claude returns after you discuss a position. Shape: <code style={{ color: COLORS.blue }}>{`{"ticker":"ATYR","G":[{"score":2,"rationale":"…","sources":["…"]}],"H":[…],"I":[…]}`}</code> — 1=Low, 2=Medium, 3=High. Only included components update.</div>
            <textarea value={syncText} onChange={e => { setSyncText(e.target.value); setSyncError(""); }} placeholder='{"ticker":"ATYR","G":[...],"H":[...],"I":[...]}' style={{ ...inp, height: 200, fontSize: 11, fontFamily: "monospace" }} />
            {syncError && <div style={{ color: COLORS.red, fontSize: 12, marginTop: 8 }}>⚠️ {syncError}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 12, justifyContent: "flex-end" }}>
              <button onClick={() => { setSyncModal(false); setSyncText(""); setSyncError(""); }} style={{ background: "transparent", color: COLORS.dim, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "8px 16px", cursor: "pointer" }}>Cancel</button>
              <button onClick={applySync} style={{ background: COLORS.blue, color: "#0E1420", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontWeight: 700 }}>Load scores</button>
            </div>
          </div>
        </div>
      )}

      {/* ══ COCKPIT ══ */}
      {room === "cockpit" && (
        <div style={{ padding: 20, maxWidth: 1100, margin: "0 auto" }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {macro.tiles.map(t => (
              <div key={t.key} onClick={() => setDrillTile(drillTile === t.key ? null : t.key)} style={{ flex: "1 1 120px", background: COLORS.panel, border: `1px solid ${drillTile === t.key ? tileColor(t.color) : COLORS.border}`, borderRadius: 10, padding: "10px 12px", cursor: "pointer", position: "relative" }}>
                <a href={MACRO_LINKS[t.key]} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} title="Open source" style={{ position: "absolute", top: 8, right: 8, color: COLORS.dim, textDecoration: "none", fontSize: 12 }}>↗</a>
                <div style={{ fontSize: 11, color: COLORS.dim }}>{t.label}</div>
                <div style={{ fontSize: 19, fontWeight: 700, color: tileColor(t.color) }}>{t.val ?? "—"}</div>
                <div style={{ fontSize: 10, color: COLORS.dim }}>{t.note}</div>
                {drillTile === t.key && <div style={{ fontSize: 10, color: COLORS.gold, marginTop: 6, borderTop: `1px solid ${COLORS.border}`, paddingTop: 6 }}>Rule: {t.rule}</div>}
              </div>
            ))}
            <div style={{ flex: "1.4 1 200px", background: COLORS.panel, border: `2px solid ${macro.temp.color}`, borderRadius: 10, padding: "10px 14px" }}>
              <div style={{ fontSize: 11, color: COLORS.dim }}>MARKET TEMPERATURE</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: macro.temp.color }}>{macro.temp.label}</div>
              <div style={{ fontSize: 11 }}>{macro.temp.advice}</div>
            </div>
          </div>
          <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.dim, letterSpacing: 1 }}>THIS WEEK — GENERAL MARKET</div>
            <button onClick={fetchHeadlines} disabled={headlinesLoading} style={{ background: COLORS.panelLight, color: COLORS.blue, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>{headlinesLoading ? "Searching the week's news…" : "🔄 Refresh All Headlines"}</button>
            {data.headlinesDate && <span style={{ fontSize: 10, color: COLORS.dim }}>updated {data.headlinesDate}</span>}
          </div>
          {generalHeadlines.length > 0 ? <HeadlineList items={generalHeadlines} /> : <div style={{ marginTop: 8, fontSize: 12, color: COLORS.dim, fontStyle: "italic" }}>No headlines yet — hit Refresh and the app searches the week's news itself.</div>}

          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.dim, letterSpacing: 1, marginBottom: 8 }}>SECTOR PULSE</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {data.sectors.map(s => (
                <div key={s.name} style={{ flex: "1 1 120px", background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "8px 12px", position: "relative" }}>
                  <a href={etfLink(s.etf)} target="_blank" rel="noopener noreferrer" title="Open ETF chart" style={{ position: "absolute", top: 6, right: 8, color: COLORS.dim, textDecoration: "none", fontSize: 12 }}>↗</a>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{s.name} <span style={{ color: COLORS.dim, fontWeight: 400, fontSize: 10 }}>{s.etf}</span></div>
                  <Delta v={s.change} suffix="%" />
                </div>
              ))}
            </div>
            <HeadlineList items={sectorHeadlines} />
          </div>

          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.dim, letterSpacing: 1, marginBottom: 8 }}>NEEDS ATTENTION</div>
            <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, overflow: "hidden" }}>
              {attention.length === 0 ? <div style={{ padding: 18, textAlign: "center", color: COLORS.green, fontWeight: 600 }}>✨ Nothing urgent. All positions stable.</div>
                : attention.map((a, i) => (
                  <div key={i} onClick={() => openDesk(a.ticker)} style={{ display: "flex", gap: 10, padding: "10px 14px", borderBottom: i < attention.length - 1 ? `1px solid ${COLORS.border}` : "none", cursor: "pointer", alignItems: "center" }} onMouseEnter={e => (e.currentTarget.style.background = COLORS.panelLight)} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                    <span>{a.icon}</span><span style={{ fontSize: 13, fontWeight: 600 }}>{a.text}</span><span style={{ fontSize: 11, color: COLORS.dim, marginLeft: "auto" }}>{a.rule} →</span>
                  </div>
                ))}
            </div>
          </div>

          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.dim, letterSpacing: 1, marginBottom: 8 }}>THE BOARD — ranked by score · tap to open analysis</div>
            <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, overflow: "auto" }}>
              <div style={{ minWidth: 720 }}>
                <div style={{ display: "grid", gridTemplateColumns: "70px 1fr 65px 75px 60px 85px 85px 95px", gap: 8, padding: "8px 14px", fontSize: 10, color: COLORS.dim, fontWeight: 700, borderBottom: `1px solid ${COLORS.border}` }}>
                  <span>TICKER</span><span>NAME</span><span>SCORE</span><span>Δ WEEK</span><span>SIGNAL</span><span>CATALYST</span><span>PRICE Δ</span><span>DECISION</span>
                </div>
                {sorted.map((s, i) => {
                  const delta = s.prevScore != null ? s.calc.composite - s.prevScore : null;
                  const pxDelta = s.prevPrice != null && s.price != null ? (s.price - s.prevPrice) / s.prevPrice * 100 : null;
                  return (
                    <div key={s.ticker} onClick={() => openDesk(s.ticker)} style={{ display: "grid", gridTemplateColumns: "70px 1fr 65px 75px 60px 85px 85px 95px", gap: 8, padding: "10px 14px", fontSize: 13, alignItems: "center", borderBottom: i < sorted.length - 1 ? `1px solid ${COLORS.border}` : "none", cursor: "pointer" }} onMouseEnter={e => (e.currentTarget.style.background = COLORS.panelLight)} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                      <span style={{ fontWeight: 800 }}>{s.ticker}{s.held && s.entryPrice != null && <span style={{ color: COLORS.gold }} title="Open position"> ●</span>}</span>
                      <span style={{ color: COLORS.dim, fontSize: 12 }}>{s.name}</span>
                      <span style={{ fontWeight: 700, color: decColor(s.calc.decision) }}>{s.calc.composite.toFixed(1)}</span>
                      <Delta v={delta} />
                      <span style={{ width: 12, height: 12, borderRadius: "50%", background: sigColor(s.calc.sigLevel), display: "inline-block" }} />
                      <span style={{ fontSize: 12, color: s.calc.daysToCatalyst != null && s.calc.daysToCatalyst <= 7 ? COLORS.yellow : COLORS.dim }}>{s.calc.daysToCatalyst != null ? `${s.calc.daysToCatalyst}d` : "—"}</span>
                      <Delta v={pxDelta} suffix="%" />
                      <span style={{ fontSize: 11, fontWeight: 700, color: decColor(s.calc.decision) }}>{s.calc.decision === "DISQUALIFIED" ? "❌ DQ" : s.calc.decision === "GO" ? "✅ GO" : s.calc.decision === "WATCH" ? "👁 WATCH" : "❌ NO-GO"}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div onClick={() => setRoom("journal")} style={{ marginTop: 20, background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "10px 16px", fontSize: 12, color: COLORS.dim, cursor: "pointer", display: "flex", gap: 16, flexWrap: "wrap" }}>
            <span>📓 <b style={{ color: COLORS.text }}>Journal:</b></span>
            {avgReturn != null && <span>reviewed picks avg <b style={{ color: avgReturn >= 0 ? COLORS.green : COLORS.red }}>{avgReturn >= 0 ? "+" : ""}{avgReturn.toFixed(1)}%</b></span>}
            {thesisTotal > 0 && <span>thesis hit rate <b style={{ color: COLORS.gold }}>{thesisYes}/{thesisTotal}</b></span>}
            <span style={{ marginLeft: "auto" }}>Open Journal →</span>
          </div>
        </div>
      )}

      {/* ══ POSITIONS ══ */}
      {room === "positions" && (
        <div style={{ padding: 20, maxWidth: 1100, margin: "0 auto" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.dim, letterSpacing: 1, marginBottom: 8 }}>OPEN POSITIONS — {positions.length} held · entries mirrored from IBKR</div>
          {positions.length === 0 ? <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 18, color: COLORS.dim, fontSize: 13 }}>No open positions. Use the <b>Add</b> verdict on a stock's Trading Desk card to open one.</div> : (
            <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, overflow: "auto" }}>
              <div style={{ minWidth: 760 }}>
                <div style={{ display: "grid", gridTemplateColumns: "70px 1fr 80px 80px 70px 80px 70px 70px 80px", gap: 8, padding: "8px 14px", fontSize: 10, color: COLORS.dim, fontWeight: 700, borderBottom: `1px solid ${COLORS.border}` }}>
                  <span>TICKER</span><span>NAME</span><span>ENTRY</span><span>CURRENT</span><span>P&L %</span><span>SHARES</span><span>SCORE</span><span>SIGNAL</span><span>DECISION</span>
                </div>
                {positions.map((s, i) => {
                  const pnl = s.entryPrice ? (s.price - s.entryPrice) / s.entryPrice * 100 : null;
                  return (
                    <div key={s.ticker} onClick={() => openDesk(s.ticker)} style={{ display: "grid", gridTemplateColumns: "70px 1fr 80px 80px 70px 80px 70px 70px 80px", gap: 8, padding: "10px 14px", fontSize: 13, alignItems: "center", borderBottom: i < positions.length - 1 ? `1px solid ${COLORS.border}` : "none", cursor: "pointer" }} onMouseEnter={e => (e.currentTarget.style.background = COLORS.panelLight)} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                      <span style={{ fontWeight: 800 }}>{s.ticker}</span>
                      <span style={{ color: COLORS.dim, fontSize: 12 }}>{s.name}<br /><span style={{ fontSize: 10 }}>since {s.entryDate}</span></span>
                      <span>${s.entryPrice?.toFixed(2)}</span>
                      <span>${s.price?.toFixed(2)}</span>
                      <span style={{ fontWeight: 700, color: pnl >= 0 ? COLORS.green : COLORS.red }}>{pnl != null ? `${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%` : "—"}</span>
                      <span style={{ color: COLORS.dim }}>{s.shares ?? "—"}</span>
                      <span style={{ fontWeight: 700, color: decColor(s.calc.decision) }}>{s.calc.composite.toFixed(1)}</span>
                      <span style={{ width: 12, height: 12, borderRadius: "50%", background: sigColor(s.calc.sigLevel), display: "inline-block" }} />
                      <span style={{ fontSize: 11, fontWeight: 700, color: decColor(s.calc.decision) }}>{s.calc.decision}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {(data.closed || []).length > 0 && (
            <div style={{ marginTop: 22 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.dim, letterSpacing: 1, marginBottom: 8 }}>CLOSED — booked results</div>
              <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, overflow: "auto" }}>
                <div style={{ minWidth: 700 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "70px 1fr 80px 80px 80px 90px 90px 1fr", gap: 8, padding: "8px 14px", fontSize: 10, color: COLORS.dim, fontWeight: 700, borderBottom: `1px solid ${COLORS.border}` }}>
                    <span>TICKER</span><span>NAME</span><span>ENTRY</span><span>EXIT</span><span>RESULT</span><span>HELD FROM</span><span>CLOSED</span><span>REASON</span>
                  </div>
                  {(data.closed || []).map((c, i) => (
                    <div key={i} style={{ display: "grid", gridTemplateColumns: "70px 1fr 80px 80px 80px 90px 90px 1fr", gap: 8, padding: "10px 14px", fontSize: 12, alignItems: "center", borderBottom: i < data.closed.length - 1 ? `1px solid ${COLORS.border}` : "none" }}>
                      <span style={{ fontWeight: 800 }}>{c.ticker}</span><span style={{ color: COLORS.dim }}>{c.name}</span>
                      <span>${c.entryPrice?.toFixed(2)}</span><span>${c.exitPrice?.toFixed(2)}</span>
                      <span style={{ fontWeight: 700, color: c.gainPct >= 0 ? COLORS.green : COLORS.red }}>{c.gainPct != null ? `${c.gainPct >= 0 ? "+" : ""}${c.gainPct}%` : "—"}</span>
                      <span style={{ color: COLORS.dim }}>{c.entryDate}</span><span style={{ color: COLORS.dim }}>{c.exitDate}</span>
                      <span style={{ color: COLORS.dim, fontSize: 11 }}>{c.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══ TRADING DESK ══ */}
      {room === "desk" && (
        <div style={{ padding: 20, maxWidth: 1100, margin: "0 auto" }}>
          {!sel ? (
            <>
              <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.dim, letterSpacing: 1, marginBottom: 12 }}>POSITIONS & WATCHLIST — tap a card to open the analysis</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(310px, 1fr))", gap: 14 }}>
                {sorted.map(s => {
                  const delta = s.prevScore != null ? s.calc.composite - s.prevScore : null;
                  const pxE = s.held && s.entryPrice ? (s.price - s.entryPrice) / s.entryPrice * 100 : null;
                  return (
                    <div key={s.ticker} onClick={() => openDesk(s.ticker)} style={{ background: COLORS.panel, border: `1px solid ${s.calc.sigLevel === "RED" ? COLORS.red : COLORS.border}`, borderRadius: 14, padding: 16, cursor: "pointer" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <ScoreRing score={s.calc.composite} decision={s.calc.decision} />
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 800, fontSize: 16 }}>{s.ticker} {s.held && s.entryPrice != null && <span style={{ color: COLORS.gold, fontSize: 11 }}>HELD</span>}</div>
                          <div style={{ fontSize: 11, color: COLORS.dim }}>{s.name}</div>
                          <div style={{ marginTop: 4 }}><Delta v={delta} /> <span style={{ fontSize: 10, color: COLORS.dim }}>vs last wk</span></div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontSize: 11, fontWeight: 800, color: sigColor(s.calc.sigLevel) }}>{s.calc.sigLevel === "CLEAR" ? "✓ CLEAR" : s.calc.sigLevel}</div>
                          {(s.overrides || []).length > 0 && <div style={{ fontSize: 9, color: COLORS.yellow }}>{s.overrides.length} overridden</div>}
                          <div style={{ fontSize: 11, color: COLORS.dim, marginTop: 4 }}>{s.calc.daysToCatalyst != null ? `⏱ ${s.calc.daysToCatalyst}d` : "no catalyst"}</div>
                          {pxE != null && <Delta v={pxE} suffix="% entry" />}
                          {s.reviewedWeek && <div style={{ fontSize: 9, color: COLORS.green, marginTop: 2 }}>✓ reviewed {s.reviewedWeek.slice(5)}</div>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : selCluster == null && !histDate ? (
            <>
              <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
                <button onClick={() => setSelStock(null)} style={{ background: "transparent", color: COLORS.dim, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontSize: 12 }}>← All positions</button>
                <span style={{ fontSize: 12, color: COLORS.dim }}>Tap any cluster bar to go deeper → evidence</span>
                <div style={{ flex: 1 }} />
                <button onClick={() => refreshQuant(sel.ticker)} disabled={fetchingTicker === sel.ticker} style={{ background: COLORS.panelLight, color: COLORS.gold, border: `1px solid ${COLORS.gold}`, borderRadius: 8, padding: "5px 14px", cursor: fetchingTicker === sel.ticker ? "wait" : "pointer", fontSize: 12, fontWeight: 600 }}>{fetchingTicker === sel.ticker ? "↻ Fetching…" : "↻ Refresh quant (LSEG)"}</button>
                <button onClick={() => { setBriefModal(sel.ticker); setCopyMsg(""); }} style={{ background: COLORS.panelLight, color: COLORS.green, border: `1px solid ${COLORS.green}`, borderRadius: 8, padding: "5px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>💬 Discuss with Claude</button>
                <button onClick={() => { setSyncModal(true); setSyncError(""); }} style={{ background: COLORS.panelLight, color: COLORS.blue, border: `1px solid ${COLORS.blue}`, borderRadius: 8, padding: "5px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>⬇ Sync Claude's scores</button>
              </div>

              <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: 22, marginBottom: 14 }}>
                <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
                  <ScoreRing score={sel.calc.composite} size={86} decision={sel.calc.decision} />
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ fontSize: 24, fontWeight: 800 }}>{sel.ticker} <span style={{ fontSize: 13, color: COLORS.dim, fontWeight: 400 }}>{sel.name} · {sel.sector}</span></div>
                    <div style={{ marginTop: 4, fontSize: 13 }}><Delta v={sel.prevScore != null ? sel.calc.composite - sel.prevScore : null} /> <span style={{ color: COLORS.dim }}>score vs last week</span></div>
                    <div style={{ marginTop: 8, display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
                      <span>💲 ${sel.price?.toFixed(2)} <Delta v={sel.prevPrice ? (sel.price - sel.prevPrice) / sel.prevPrice * 100 : null} suffix="% wk" /></span>
                      {sel.held && sel.entryPrice && <span>📍 Entry ${sel.entryPrice} <Delta v={(sel.price - sel.entryPrice) / sel.entryPrice * 100} suffix="%" /></span>}
                      <span style={{ color: sel.calc.daysToCatalyst != null && sel.calc.daysToCatalyst <= 7 ? COLORS.yellow : COLORS.dim }}>⏱ {sel.calc.daysToCatalyst != null ? `${sel.catalystType} in ${sel.calc.daysToCatalyst}d` : "No catalyst set"}</span>
                    </div>
                    {sel.lastFetch && <div style={{ marginTop: 6, fontSize: 11, color: COLORS.dim }}>LSEG fetched {sel.lastFetch.date}{sel.lastFetch.currency ? ` · ${sel.lastFetch.currency}` : ""}{sel.lastFetch.missing?.length ? ` · missing: ${sel.lastFetch.missing.join(", ")}` : " · all fields"}{sel.lastFetch.notes ? ` · ${sel.lastFetch.notes}` : ""}</div>}
                  </div>
                  <div style={{ textAlign: "center", padding: "12px 22px", borderRadius: 12, background: COLORS.bg, border: `2px solid ${sigColor(sel.calc.sigLevel)}` }}>
                    <div style={{ fontSize: 10, color: COLORS.dim, letterSpacing: 1 }}>SIGNAL STATUS</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: sigColor(sel.calc.sigLevel) }}>{sel.calc.sigLevel}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: decColor(sel.calc.decision), marginTop: 2 }}>{sel.calc.decision}</div>
                    {(sel.overrides || []).length > 0 && <div style={{ fontSize: 10, color: COLORS.yellow, marginTop: 2 }}>{sel.overrides.length} overridden</div>}
                  </div>
                </div>
                {sel.calc.signals.length > 0 && (
                  <div style={{ marginTop: 14, borderTop: `1px solid ${COLORS.border}`, paddingTop: 12 }}>
                    {sel.calc.signals.map((sig, i) => {
                      const overridden = (sel.overrides || []).some(o => o.signal === sig.text || sig.text.includes(o.signal) || o.signal.includes(sig.text.split(" ")[0]));
                      return (
                        <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", padding: "5px 0", fontSize: 13, opacity: overridden ? 0.55 : 1, flexWrap: "wrap" }}>
                          <span style={{ color: sig.level === "RED" ? COLORS.red : sig.level === "STALE" ? COLORS.blue : COLORS.yellow, fontWeight: 700, minWidth: 52, fontSize: 11 }}>{sig.level}</span>
                          <span>{sig.text}</span><span style={{ fontSize: 11, color: COLORS.dim }}>({sig.rule})</span>
                          {overridden ? <span style={{ marginLeft: "auto", fontSize: 11, color: COLORS.yellow }}>✓ overridden</span> : <button onClick={() => logOverride(sel.ticker, sig.text)} style={{ marginLeft: "auto", background: "transparent", color: COLORS.yellow, border: `1px solid ${COLORS.yellow}`, borderRadius: 6, padding: "2px 10px", cursor: "pointer", fontSize: 11 }}>Override</button>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {QUESTIONS.map(q => {
                const ks = Object.keys(CLUSTER_NAMES).filter(k => QUESTION_OF[k] === q);
                return (
                  <div key={q} style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: "14px 18px", marginBottom: 10 }}>
                    <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>{q}</div>
                    {ks.map(k => {
                      const v = sel.calc.scores[k], prev = sel.prevScores?.[k];
                      const d = typeof v === "number" && typeof prev === "number" ? v - prev : null;
                      const hasOv = sel.calc.overrideScores[k] && sel.calc.overrideScores[k].value != null;
                      return (
                        <div key={k} onClick={() => setSelCluster(k)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 6px", borderRadius: 8, fontSize: 13, cursor: "pointer" }} onMouseEnter={e => (e.currentTarget.style.background = COLORS.panelLight)} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                          <span style={{ minWidth: 170, color: COLORS.dim }}>{k} — {CLUSTER_NAMES[k]} {hasOv && <span title="overridden" style={{ color: COLORS.yellow }}>✏️</span>}</span>
                          <div style={{ flex: 1, height: 8, background: COLORS.bg, borderRadius: 4, overflow: "hidden" }}><div style={{ width: `${(typeof v === "number" ? v : 0) * 10}%`, height: "100%", background: scoreColor(v), borderRadius: 4 }} /></div>
                          <span style={{ fontWeight: 700, minWidth: 38, textAlign: "right", color: scoreColor(v) }}>{typeof v === "number" ? v.toFixed(1) : v == null ? "—" : "KO"}</span>
                          <span style={{ minWidth: 64, textAlign: "right" }}><Delta v={d} /></span>
                          <span style={{ fontSize: 11, color: COLORS.dim, minWidth: 32 }}>×{(rules.weights[k] * 100).toFixed(0)}%</span>
                          <span style={{ color: COLORS.gold, fontSize: 14 }}>›</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}

              {/* VERDICT */}
              <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: 18, marginTop: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                  <div style={{ fontWeight: 800, fontSize: 14 }}>Verdict</div>
                  {sel.reviewedWeek ? <span style={{ fontSize: 11, color: COLORS.green }}>✓ Reviewed {sel.reviewedWeek}</span> : <span style={{ fontSize: 11, color: COLORS.yellow }}>not yet reviewed this week</span>}
                  {sel.held && sel.entryPrice != null ? <span style={{ fontSize: 11, color: COLORS.gold, marginLeft: "auto" }}>● Open position @ ${sel.entryPrice}</span> : <span style={{ fontSize: 11, color: COLORS.dim, marginLeft: "auto" }}>Watchlist (not held)</span>}
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {["Hold", "Add", "Trim", "Exit"].map(a => {
                    const disabled = (a === "Trim" || a === "Exit" || a === "Hold") && !(sel.held && sel.entryPrice != null);
                    return (
                      <button key={a} disabled={disabled} onClick={() => doVerdict(sel.ticker, a)} title={disabled ? "No open position — use Add first" : ""}
                        style={{ flex: 1, minWidth: 80, background: disabled ? COLORS.bg : a === "Exit" ? COLORS.red : a === "Add" ? COLORS.green : COLORS.panelLight, color: disabled ? COLORS.dim : a === "Hold" || a === "Trim" ? COLORS.text : "#fff", border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "10px 0", cursor: disabled ? "not-allowed" : "pointer", fontWeight: 700, fontSize: 14, opacity: disabled ? 0.5 : 1 }}>{a}</button>
                    );
                  })}
                </div>
                <div style={{ fontSize: 11, color: COLORS.dim, marginTop: 8 }}>Add opens/increases a position (you mirror it on IBKR). Exit closes it and books the result to Positions → Closed.</div>
              </div>

              {/* NOTEBOOK */}
              <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: 18, marginTop: 14 }}>
                <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 10 }}>📓 Position notebook</div>
                <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                  <input id="newNote" placeholder="Add a note…" style={{ ...inp, marginTop: 0 }} onKeyDown={e => { if (e.key === "Enter") { addNote(sel.ticker, e.target.value); e.target.value = ""; } }} />
                  <button onClick={() => { const el = document.getElementById("newNote"); addNote(sel.ticker, el.value); el.value = ""; }} style={{ background: COLORS.gold, color: "#1B2A4A", border: "none", borderRadius: 8, padding: "0 16px", cursor: "pointer", fontWeight: 700 }}>Add</button>
                </div>
                {(sel.notebook || []).length === 0 ? <div style={{ fontSize: 12, color: COLORS.dim, fontStyle: "italic" }}>No notes yet.</div> : (sel.notebook || []).map((n, i) => (
                  <div key={i} style={{ fontSize: 12, padding: "6px 0", borderBottom: i < sel.notebook.length - 1 ? `1px solid ${COLORS.border}` : "none" }}><span style={{ color: COLORS.dim }}>{n.date}</span> — {n.text}</div>
                ))}
              </div>

              {/* HISTORY TIMELINE */}
              <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: 18, marginTop: 14 }}>
                <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ fontWeight: 800, fontSize: 14 }}>🕓 Weekly history</div>
                  <span style={{ fontSize: 11, color: COLORS.dim, marginLeft: 10 }}>frozen each snapshot — tap a week to see its full state</span>
                </div>
                {(data.snapshots?.[sel.ticker] || []).length === 0 ? <div style={{ fontSize: 12, color: COLORS.dim, fontStyle: "italic" }}>No snapshots yet. The first one is frozen on your next Snapshot week.</div> : (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {(data.snapshots[sel.ticker] || []).slice().reverse().map((snap, i) => (
                      <button key={i} onClick={() => setHistDate(snap.date)} style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "8px 12px", cursor: "pointer", textAlign: "left", color: COLORS.text }}>
                        <div style={{ fontSize: 11, color: COLORS.dim }}>{snap.date}</div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: decColor(snap.decision) }}>{snap.composite?.toFixed?.(1) ?? snap.composite}</div>
                        <div style={{ fontSize: 10, color: COLORS.dim }}>${snap.price} · {snap.decision}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* DANGER ZONE */}
              <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <button onClick={() => deleteStock(sel.ticker)} style={{ background: "transparent", color: COLORS.red, border: `1px solid ${COLORS.red}`, borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 12 }}>🗑 Delete {sel.ticker} + all history</button>
                {(data.snapshots?.[sel.ticker] || []).length > 2 && (
                  <button onClick={() => { const d = prompt("Prune snapshots before date (YYYY-MM-DD):"); if (d) pruneSnapshots(sel.ticker, d); }} style={{ background: "transparent", color: COLORS.dim, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 12 }}>Prune old snapshots</button>
                )}
                <span style={{ fontSize: 11, color: COLORS.dim }}>delete a bust to free storage</span>
              </div>
            </>
          ) : histDate ? (
            /* ── HISTORICAL SNAPSHOT VIEW ── */
            (() => {
              const snap = (data.snapshots[sel.ticker] || []).find(s => s.date === histDate);
              if (!snap) return <div>Snapshot not found. <button onClick={() => setHistDate(null)}>back</button></div>;
              return (
                <>
                  <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
                    <button onClick={() => setHistDate(null)} style={{ background: "transparent", color: COLORS.dim, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontSize: 12 }}>← {sel.ticker} current</button>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>{sel.ticker} — frozen state on {snap.date}</span>
                  </div>
                  <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.blue}`, borderRadius: 14, padding: 20 }}>
                    <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
                      <ScoreRing score={snap.composite} size={72} decision={snap.decision} />
                      <div>
                        <div style={{ fontSize: 18, fontWeight: 800 }}>{snap.composite?.toFixed?.(1)} · {snap.decision}</div>
                        <div style={{ fontSize: 12, color: COLORS.dim }}>price ${snap.price} · signal {snap.sigLevel}{snap.held ? ` · held @ $${snap.entryPrice}` : ""}</div>
                        {snap.catalystDate && <div style={{ fontSize: 12, color: COLORS.dim }}>catalyst: {snap.catalystType} on {snap.catalystDate} ({snap.daysToCatalyst}d out then)</div>}
                        {snap.knockouts?.length > 0 && <div style={{ fontSize: 12, color: COLORS.red }}>⛔ {snap.knockouts.join(", ")}</div>}
                      </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
                      {Object.keys(CLUSTER_NAMES).map(k => {
                        const v = snap.scores?.[k], cur = sel.calc.scores[k];
                        const d = typeof v === "number" && typeof cur === "number" ? cur - v : null;
                        return (
                          <div key={k} style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 10 }}>
                            <div style={{ fontSize: 10, color: COLORS.dim }}>{k} — {CLUSTER_NAMES[k]}</div>
                            <div style={{ fontSize: 16, fontWeight: 800, color: scoreColor(v) }}>{typeof v === "number" ? v.toFixed(1) : "—"}</div>
                            {d != null && <div style={{ fontSize: 10 }}>now: {cur.toFixed(1)} <Delta v={d} /></div>}
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ fontSize: 11, color: COLORS.dim, marginTop: 12 }}>This is a read-only snapshot. Qualitative ratings then: PICPOT [{(snap.picpot || []).join(", ") || "—"}], Moat [{(snap.moat || []).join(", ") || "—"}], Mgmt [{(snap.mgmt || []).join(", ") || "—"}] (1=Low,2=Med,3=High).</div>
                  </div>
                </>
              );
            })()
          ) : (
            /* ── EVIDENCE VIEW ── */
            (() => {
              const k = selCluster, t = sel.calc.trace[k], v = sel.calc.scores[k];
              return (
                <>
                  <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
                    <button onClick={() => setSelCluster(null)} style={{ background: "transparent", color: COLORS.dim, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontSize: 12 }}>← {sel.ticker} analysis</button>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>{sel.ticker} · {k} — {CLUSTER_NAMES[k]} · Evidence Room</span>
                  </div>
                  <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.gold}`, borderRadius: 14, padding: 20 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4, flexWrap: "wrap" }}>
                      <div style={{ fontSize: 28, fontWeight: 800, color: scoreColor(v) }}>{typeof v === "number" ? v.toFixed(1) : v == null ? "unscored" : "KNOCKOUT"}</div>
                      <div style={{ fontSize: 12, color: COLORS.dim }}>weight ×{(rules.weights[k] * 100).toFixed(0)}% → contributes <b style={{ color: COLORS.text }}>{typeof v === "number" ? (v * rules.weights[k]).toFixed(2) : "0"}</b> to composite {sel.calc.composite.toFixed(1)}</div>
                      <div style={{ marginLeft: "auto", fontSize: 11, color: COLORS.dim }}>Source: {CLUSTER_SOURCES[k]}</div>
                    </div>
                    {sel.calc.overrideScores[k] && sel.calc.overrideScores[k].value != null && (
                      <div style={{ fontSize: 12, color: COLORS.yellow, marginBottom: 8, padding: "6px 10px", background: "rgba(224,181,84,0.1)", borderRadius: 8 }}>
                        ✏️ Your override: system computed <b>{typeof sel.calc.computedScores[k] === "number" ? sel.calc.computedScores[k].toFixed(1) : sel.calc.computedScores[k]}</b>, you set <b>{sel.calc.overrideScores[k].value}</b> — {sel.calc.overrideScores[k].reason}
                        <button onClick={() => setClusterOverride(sel.ticker, k, null)} style={{ marginLeft: 10, background: "transparent", color: COLORS.dim, border: `1px solid ${COLORS.border}`, borderRadius: 5, padding: "1px 8px", cursor: "pointer", fontSize: 11 }}>clear</button>
                      </div>
                    )}
                    {sel.prevScores?.[k] != null && typeof v === "number" && <div style={{ fontSize: 12, color: COLORS.dim, marginBottom: 12 }}>Last week: {sel.prevScores[k].toFixed(1)} → this week: {v.toFixed(1)} <Delta v={v - sel.prevScores[k]} /></div>}

                    {["G", "H", "I"].includes(k) ? (
                      <div style={{ display: "grid", gap: 10 }}>
                        {t.components.map((c, i) => {
                          const isEd = editComp && editComp.cluster === k && editComp.idx === i;
                          return (
                            <div key={i} style={{ background: COLORS.bg, border: `1px solid ${isEd ? COLORS.gold : COLORS.border}`, borderRadius: 10, padding: 12 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                <span style={{ fontWeight: 700, fontSize: 13, minWidth: 120 }}>{c.name}</span>
                                <span style={{ fontSize: 12, fontWeight: 700, padding: "2px 10px", borderRadius: 20, background: c.input === "High" ? "rgba(61,204,126,0.15)" : c.input === "Medium" ? "rgba(224,181,84,0.15)" : c.input === "Low" ? "rgba(232,92,92,0.15)" : COLORS.panel, color: c.input === "High" ? COLORS.green : c.input === "Medium" ? COLORS.yellow : c.input === "Low" ? COLORS.red : COLORS.dim }}>{c.input}</span>
                                <span style={{ fontSize: 11, color: COLORS.dim }}>{c.score !== "—" ? `→ ${c.score}` : "unscored"}</span>
                                <button onClick={() => setEditComp(isEd ? null : { cluster: k, idx: i })} style={{ marginLeft: "auto", background: "transparent", color: COLORS.gold, border: `1px solid ${COLORS.gold}`, borderRadius: 6, padding: "2px 10px", cursor: "pointer", fontSize: 11 }}>{isEd ? "close" : "edit"}</button>
                              </div>
                              {c.rationale ? <div style={{ fontSize: 12, color: COLORS.text, marginTop: 8, lineHeight: 1.5 }}>{c.rationale}</div> : <div style={{ fontSize: 12, color: COLORS.dim, marginTop: 8, fontStyle: "italic" }}>No reasoning yet — use "Discuss with Claude" to draft one, or edit directly.</div>}
                              {c.sources?.length > 0 && <div style={{ fontSize: 11, color: COLORS.blue, marginTop: 6 }}>📎 {c.sources.join(" · ")}</div>}
                              {isEd && (
                                <div style={{ marginTop: 10, borderTop: `1px solid ${COLORS.border}`, paddingTop: 10, display: "grid", gap: 8 }}>
                                  <div style={{ display: "flex", gap: 6 }}>
                                    {[1, 2, 3].map(sv => (
                                      <button key={sv} onClick={() => setQualComponent(sel.ticker, k, i, sv, undefined, undefined)} style={{ flex: 1, background: c.input === ["", "Low", "Medium", "High"][sv] ? COLORS.gold : COLORS.panel, color: c.input === ["", "Low", "Medium", "High"][sv] ? "#1B2A4A" : COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: "6px 0", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{["", "Low", "Medium", "High"][sv]}</button>
                                    ))}
                                  </div>
                                  <textarea defaultValue={c.rationale} placeholder="Your reasoning…" id={`rat-${k}-${i}`} style={{ ...inp, height: 60, fontSize: 12 }} />
                                  <input defaultValue={(c.sources || []).join(", ")} placeholder="Sources (comma-separated)" id={`src-${k}-${i}`} style={{ ...inp, color: COLORS.blue, fontSize: 12 }} />
                                  <button onClick={() => setQualComponent(sel.ticker, k, i, null, document.getElementById(`rat-${k}-${i}`).value, document.getElementById(`src-${k}-${i}`).value)} style={{ background: COLORS.gold, color: "#1B2A4A", border: "none", borderRadius: 6, padding: "7px 0", cursor: "pointer", fontWeight: 700, fontSize: 12 }}>Save reasoning & sources</button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                        <thead><tr style={{ color: COLORS.dim, textAlign: "left", fontSize: 10 }}>
                          <th style={{ padding: "4px 8px" }}>COMPONENT</th><th style={{ padding: "4px 8px" }}>RAW INPUT</th><th style={{ padding: "4px 8px" }}>TIER</th><th style={{ padding: "4px 8px" }}>RULE APPLIED</th><th style={{ padding: "4px 8px", textAlign: "right" }}>SCORE</th><th style={{ padding: "4px 8px", textAlign: "right" }}>SUB-WT</th>
                        </tr></thead>
                        <tbody>
                          {t.components.map((c, i) => (
                            <tr key={i} style={{ borderTop: `1px solid ${COLORS.border}` }}>
                              <td style={{ padding: "8px", fontWeight: 600 }}>{c.name}</td><td style={{ padding: "8px", color: COLORS.blue }}>{c.input}</td>
                              <td style={{ padding: "8px", color: COLORS.dim }}>{c.tier}</td><td style={{ padding: "8px", color: COLORS.dim, fontSize: 11 }}>{c.rule}</td>
                              <td style={{ padding: "8px", textAlign: "right", fontWeight: 700, color: c.score === "KO" ? COLORS.red : COLORS.text }}>{c.score}</td>
                              <td style={{ padding: "8px", textAlign: "right", color: COLORS.dim }}>{c.weight ? `${(c.weight * 100).toFixed(0)}%` : "bonus"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}

                    {t.note && <div style={{ marginTop: 10, fontSize: 12, color: COLORS.dim, fontStyle: "italic" }}>📝 Summary note: {t.note}</div>}
                    {t.lastEarnings && <div style={{ marginTop: 4, fontSize: 11, color: COLORS.dim }}>Last earnings call analyzed: {t.lastEarnings}</div>}
                    {k === "J" && t.springConds && (
                      <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {t.springConds.map((c, i) => <span key={i} style={{ fontSize: 11, padding: "3px 10px", borderRadius: 20, background: c.met ? "rgba(61,204,126,0.15)" : COLORS.bg, color: c.met ? COLORS.green : COLORS.dim, border: `1px solid ${c.met ? COLORS.green : COLORS.border}` }}>{c.met ? "✓" : "✗"} {c.name}</span>)}
                      </div>
                    )}
                    {/* Cluster J: editable catalyst + lifecycle inputs (moved here from stock-inputs) */}
                    {k === "J" && (
                      <div style={{ marginTop: 12, borderTop: `1px solid ${COLORS.border}`, paddingTop: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.dim, marginBottom: 8 }}>Edit catalyst & lifecycle inputs (manual — drive this score)</div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
                          <label style={{ fontSize: 11, color: COLORS.dim }}>Catalyst type<br /><input defaultValue={sel.catalystType || ""} onBlur={e => updateStockField(sel.ticker, "catalystType", e.target.value)} style={inp} /></label>
                          <label style={{ fontSize: 11, color: COLORS.dim }}>Catalyst date<br /><input type="date" defaultValue={sel.catalystDate || ""} onBlur={e => updateStockField(sel.ticker, "catalystDate", e.target.value)} style={inp} /></label>
                          <label style={{ fontSize: 11, color: COLORS.dim }}>Confidence<br /><select defaultValue={sel.catalystConfidence || ""} onChange={e => updateStockField(sel.ticker, "catalystConfidence", e.target.value)} style={inp}><option value="">—</option><option>High</option><option>Medium</option><option>Low</option></select></label>
                          <label style={{ fontSize: 11, color: COLORS.dim }}>Reverse split history<br /><input defaultValue={sel.revSplit || ""} placeholder="e.g. 1:14 (2019)" onBlur={e => updateStockField(sel.ticker, "revSplit", e.target.value)} style={inp} /></label>
                        </div>
                      </div>
                    )}
                    {k === "C" && sel.calc.knockouts.length > 0 && (
                      <div style={{ marginTop: 12, padding: 12, background: "rgba(232,92,92,0.1)", border: `1px solid ${COLORS.red}`, borderRadius: 10 }}>
                        <div style={{ fontWeight: 800, color: COLORS.red, fontSize: 12, marginBottom: 4 }}>⛔ ACTIVE KNOCKOUTS</div>
                        {sel.calc.knockouts.map((ko, i) => <div key={i} style={{ fontSize: 12 }}><b>{ko.name}</b> — {ko.rule}</div>)}
                      </div>
                    )}

                    <div style={{ marginTop: 14, borderTop: `1px solid ${COLORS.border}`, paddingTop: 12 }}>
                      {clusterOvEdit === k ? (
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <span style={{ fontSize: 12, color: COLORS.dim }}>Override this cluster score:</span>
                          <input type="number" min="0" max="10" step="0.1" id={`ov-${k}`} defaultValue={typeof v === "number" ? v.toFixed(1) : ""} style={{ ...inp, width: 70, marginTop: 0 }} />
                          <input id={`ovr-${k}`} placeholder="reason for override" style={{ ...inp, flex: 1, minWidth: 160, marginTop: 0 }} />
                          <button onClick={() => setClusterOverride(sel.ticker, k, document.getElementById(`ov-${k}`).value, document.getElementById(`ovr-${k}`).value)} style={{ background: COLORS.gold, color: "#1B2A4A", border: "none", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontWeight: 700, fontSize: 12 }}>Save</button>
                          <button onClick={() => setClusterOvEdit(null)} style={{ background: "transparent", color: COLORS.dim, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 12 }}>Cancel</button>
                        </div>
                      ) : <button onClick={() => setClusterOvEdit(k)} style={{ background: "transparent", color: COLORS.yellow, border: `1px solid ${COLORS.yellow}`, borderRadius: 6, padding: "5px 14px", cursor: "pointer", fontSize: 12 }}>✏️ Override {k} cluster score</button>}
                    </div>
                  </div>

                  <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: 18, marginTop: 14 }}>
                    <div style={{ fontWeight: 800, marginBottom: 10, fontSize: 13 }}>📜 {sel.ticker} — Decision & Override Trail</div>
                    {(sel.decisions || []).length === 0 && (sel.overrides || []).length === 0 && <div style={{ fontSize: 12, color: COLORS.dim }}>No decisions logged yet.</div>}
                    {(sel.overrides || []).map((o, i) => <div key={`o${i}`} style={{ fontSize: 12, padding: "6px 0", borderBottom: `1px solid ${COLORS.border}` }}><span style={{ color: COLORS.yellow, fontWeight: 700 }}>OVERRIDE</span> <span style={{ color: COLORS.dim }}>{o.date}</span> — "{o.signal}" — <i>{o.reason}</i></div>)}
                    {(sel.decisions || []).map((d, i) => <div key={`d${i}`} style={{ fontSize: 12, padding: "6px 0", borderBottom: `1px solid ${COLORS.border}` }}><span style={{ color: COLORS.blue, fontWeight: 700 }}>{d.action.toUpperCase()}</span> <span style={{ color: COLORS.dim }}>{d.date}</span> — <i>{d.reason}</i></div>)}
                  </div>
                </>
              );
            })()
          )}
        </div>
      )}

      {/* ══ JOURNAL ══ */}
      {room === "journal" && (
        <div style={{ padding: 20, maxWidth: 1100, margin: "0 auto" }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
            {[["ALL REVIEWED PICKS", avgReturn == null ? "—" : `${avgReturn >= 0 ? "+" : ""}${avgReturn.toFixed(1)}%`, avgReturn == null ? COLORS.dim : avgReturn >= 0 ? COLORS.green : COLORS.red, `${reviewed.length} with review prices`],
              ["GO PICKS AVG", goAvg == null ? "—" : `${goAvg >= 0 ? "+" : ""}${goAvg.toFixed(1)}%`, goAvg == null ? COLORS.dim : goAvg >= 0 ? COLORS.green : COLORS.red, "does GO actually win?"],
              ["THESIS HIT RATE", thesisTotal ? `${thesisYes}/${thesisTotal}` : "—", COLORS.gold, "theses that held"],
              ["OVERRIDES ACTIVE", String(computed.reduce((a, s) => a + (s.overrides || []).length, 0)), COLORS.yellow, "your judgment, tracked"]].map(([t, val, col, sub], i) => (
              <div key={i} style={{ flex: "1 1 140px", background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "12px 14px" }}>
                <div style={{ fontSize: 11, color: COLORS.dim }}>{t}</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: col }}>{val}</div>
                <div style={{ fontSize: 10, color: COLORS.dim }}>{sub}</div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.dim, letterSpacing: 1 }}>WEEKLY LOG — tap a row to fill in the review</div>
            <button onClick={snapshotToJournal} style={{ background: COLORS.panelLight, color: COLORS.blue, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>📸 Snapshot current board</button>
          </div>
          <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, overflow: "auto" }}>
            <div style={{ minWidth: 860 }}>
              <div style={{ display: "grid", gridTemplateColumns: "90px 70px 80px 60px 90px 90px 80px 90px 90px 1fr", gap: 8, padding: "8px 14px", fontSize: 10, color: COLORS.dim, fontWeight: 700, borderBottom: `1px solid ${COLORS.border}` }}>
                <span>WEEK</span><span>TICKER</span><span>DECISION</span><span>SCORE</span><span>PRICE@SCREEN</span><span>PRICE@REVIEW</span><span>% CHG</span><span>CATALYST?</span><span>THESIS?</span><span>NOTES</span>
              </div>
              {journal.length === 0 && <div style={{ padding: 18, textAlign: "center", color: COLORS.dim, fontSize: 13 }}>No entries yet. Hit "Snapshot current board".</div>}
              {journal.map((j, i) => {
                const pct = j.priceScreen != null && j.priceReview != null ? (j.priceReview - j.priceScreen) / j.priceScreen * 100 : null;
                const editing = journalEdit === i;
                return (
                  <div key={i}>
                    <div onClick={() => setJournalEdit(editing ? null : i)} style={{ display: "grid", gridTemplateColumns: "90px 70px 80px 60px 90px 90px 80px 90px 90px 1fr", gap: 8, padding: "9px 14px", fontSize: 12, alignItems: "center", borderBottom: `1px solid ${COLORS.border}`, cursor: "pointer", background: editing ? COLORS.panelLight : "transparent" }}>
                      <span style={{ color: COLORS.dim }}>{j.week}</span><span style={{ fontWeight: 800 }}>{j.ticker}</span>
                      <span style={{ fontWeight: 700, color: decColor(j.decision === "DISQUALIFIED" ? "NO-GO" : j.decision) }}>{j.decision}</span>
                      <span>{j.score?.toFixed?.(1) ?? j.score}</span><span>{j.priceScreen != null ? `$${j.priceScreen}` : "—"}</span>
                      <span>{j.priceReview != null ? `$${j.priceReview}` : <span style={{ color: COLORS.yellow }}>pending</span>}</span>
                      <Delta v={pct} suffix="%" />
                      <span style={{ color: j.catalystFired === "Yes" ? COLORS.green : COLORS.dim }}>{j.catalystFired || "—"}</span>
                      <span style={{ color: j.thesisHeld === "Yes" ? COLORS.green : j.thesisHeld === "No" ? COLORS.red : j.thesisHeld === "Partial" ? COLORS.yellow : COLORS.dim }}>{j.thesisHeld || "—"}</span>
                      <span style={{ color: COLORS.dim, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.notes || j.right || j.wrong || ""}</span>
                    </div>
                    {editing && (
                      <div style={{ padding: "12px 14px", borderBottom: `1px solid ${COLORS.border}`, background: COLORS.bg, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
                        <label style={{ fontSize: 11, color: COLORS.dim }}>Price at review<br /><input type="number" step="0.01" defaultValue={j.priceReview ?? ""} onBlur={e => updateJournal(i, "priceReview", e.target.value)} style={inp} /></label>
                        <label style={{ fontSize: 11, color: COLORS.dim }}>Catalyst fired?<br /><select defaultValue={j.catalystFired || ""} onChange={e => updateJournal(i, "catalystFired", e.target.value)} style={inp}><option value="">—</option><option>Yes</option><option>No</option><option>Delayed</option></select></label>
                        <label style={{ fontSize: 11, color: COLORS.dim }}>Thesis held?<br /><select defaultValue={j.thesisHeld || ""} onChange={e => updateJournal(i, "thesisHeld", e.target.value)} style={inp}><option value="">—</option><option>Yes</option><option>Partial</option><option>No</option></select></label>
                        <label style={{ fontSize: 11, color: COLORS.dim, gridColumn: "1 / -1" }}>What went right<br /><input defaultValue={j.right || ""} onBlur={e => updateJournal(i, "right", e.target.value)} style={{ ...inp, color: COLORS.green }} /></label>
                        <label style={{ fontSize: 11, color: COLORS.dim, gridColumn: "1 / -1" }}>What went wrong<br /><input defaultValue={j.wrong || ""} onBlur={e => updateJournal(i, "wrong", e.target.value)} style={{ ...inp, color: COLORS.red }} /></label>
                        <label style={{ fontSize: 11, color: COLORS.dim, gridColumn: "1 / -1" }}>Notes / next action<br /><input defaultValue={j.notes || ""} onBlur={e => updateJournal(i, "notes", e.target.value)} style={inp} /></label>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ══ LAB ══ */}
      {room === "lab" && (
        <div style={{ padding: 60, textAlign: "center", color: COLORS.dim }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🧪</div>
          <div style={{ fontWeight: 700, fontSize: 18, color: COLORS.text, marginBottom: 6 }}>The Lab</div>
          <div style={{ fontSize: 13, maxWidth: 420, margin: "0 auto" }}>New-candidate screening with guided qualitative scoring — next build session.</div>
        </div>
      )}
    </div>
  );
}
