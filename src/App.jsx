import React, { useState, useEffect, useCallback, useRef } from "react";
import { Gauge, LayoutList, Briefcase, Settings, Zap, X, Upload, Download, MessageSquare, ClipboardPaste, Radar, TrendingUp, TrendingDown } from "lucide-react";

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
  A: "Skill scan (tier rules in the skill) + your override", B: "Skill scan + your override",
  C: "Skill scan + your override", D: "Skill scan + your override",
  E: "Skill scan + your override", F: "Skill scan + your override",
  G: "Skill scan items + your edits/override", H: "Skill scan items + your edits/override",
  I: "Earnings call via skill scan + your edits/override", J: "Skill scan + manual catalyst entry + your override",
};
const QUAL_LABELS = {
  G: ["Proximity", "Impact", "Conflict", "Prominence", "Oddity", "Timeliness"],
  H: ["Brand loyalty", "Technical lead", "Mfg/Ops lead", "Reg head start", "Community", "First mover"],
  I: ["Unscripted tone", "Q&A directness", "Guidance clarity", "Low evasiveness", "CEO conviction"],
};

const qualToScore = v => (v === 3 ? 9.5 : v === 2 ? 5 : v === 1 ? 1.5 : null);
// ─── SCORING ────────────────────────────────────────────────────────────────
// The scoring brain lives in the Claude Skill — the app runs NO tier math and
// NO veto logic of its own. Cluster scores come from the last scan (claudeScan);
// G/H/I recompute live from the (editable) qual items; your overrides beat
// everything. The only arithmetic left here: the weighted average and the
// decision bands, both driven by config.
function computeStock(s, rules) {
  const cs = s.claudeScan || null;
  const cScores = (cs && cs.clusters) || {};

  // G/H/I: average of item anchors (Low=1.5, Med=5, High=9.5). Items arrive from
  // the scan and stay editable in the Evidence Room, so these recompute live.
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
  const trace = {
    G: { components: G.items, note: s.picpotNote },
    H: { components: H.items, note: s.moatNote },
    I: { components: I.items, note: s.mgmtNote, lastEarnings: s.lastEarnings },
  };

  const claudeScore = k => (typeof cScores[k]?.score === "number" ? cScores[k].score : null);
  const computedScores = {
    A: claudeScore("A"), B: claudeScore("B"), C: claudeScore("C"), D: claudeScore("D"),
    E: claudeScore("E"), F: claudeScore("F"),
    G: G.score ?? claudeScore("G"), H: H.score ?? claudeScore("H"), I: I.score ?? claudeScore("I"),
    J: claudeScore("J"),
  };
  const ov = s.overrideScores || {};
  const scores = {};
  Object.keys(computedScores).forEach(k => { scores[k] = ov[k] && ov[k].value != null ? ov[k].value : computedScores[k]; });

  let composite = 0, wUsed = 0;
  Object.entries(scores).forEach(([k, v]) => { if (typeof v === "number") { composite += v * rules.weights[k]; wUsed += rules.weights[k]; } });
  composite = wUsed > 0 ? composite / wUsed : 0;

  // Vetoes come straight from the scan.
  const knockouts = ((cs && cs.vetoes && cs.vetoes.tripped) || []).map(t => ({ name: t, rule: "Hard veto (from scan)" }));

  // Live countdown for display only — J score is frozen at scan time by design.
  const days = s.catalystDate ? Math.max(0, Math.ceil((new Date(s.catalystDate) - new Date()) / 86400000)) : null;

  const decision = knockouts.length ? "DISQUALIFIED" : composite >= rules.goThreshold ? "GO" : composite >= rules.watchThreshold ? "WATCH" : "NO-GO";
  const signals = [];
  if (knockouts.length) signals.push(...knockouts.map(k => ({ level: "RED", text: k.name, rule: k.rule })));
  if (days != null && days <= 7) signals.push({ level: "WATCH", text: `Catalyst in ${days}d`, rule: "Imminent event" });
  if (days == null) signals.push({ level: "WATCH", text: "No catalyst identified", rule: "Heavy negative on Cluster J" });
  if (!cs) signals.push({ level: "WATCH", text: "Never full-scanned", rule: "Run a FULL SCAN through the skill to score this stock" });
  if (s.lastEarnings && (new Date() - new Date(s.lastEarnings)) / 86400000 > 90) signals.push({ level: "STALE", text: "Mgmt scores >90 days old", rule: "Refresh earnings call analysis" });
  const sigLevel = signals.some(x => x.level === "RED") ? "RED" : signals.some(x => x.level === "WATCH") ? "WATCH" : "CLEAR";
  return { scores, computedScores, overrideScores: ov, composite: Math.round(composite * 10) / 10, decision, knockouts, signals, sigLevel, trace, daysToCatalyst: days };
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
function makeSnapshot(s, calc, date, summary) {
  return {
    date, price: s.price, composite: calc.composite, decision: calc.decision, sigLevel: calc.sigLevel,
    fields: { price: s.price ?? null, mktCap: s.mktCap ?? null, debt: s.debt ?? null, cash: s.cash ?? null, burnQ: s.burnQ ?? null, volume: s.volume ?? null, insiderNet: s.insiderNet ?? null },
    summary: summary || "",
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

// Soft dark: deep blue-ink base, raised panels, pastel state colors that glow.
const COLORS = {
  bg: "#101321", panel: "#171B2C", panelLight: "#202538", border: "#262C42",
  text: "#EDEFF7", dim: "#7C84A3", gold: "#E9B458", green: "#5EE7A3", red: "#FF7A8A", yellow: "#F5C26B", blue: "#7FA6FF",
};
const glow = (c, s = 16) => `0 0 ${s}px ${c}40`;
const GLOBAL_CSS = `
  button { transition: transform .16s ease, box-shadow .16s ease, background .16s ease, color .16s ease, border-color .16s ease; }
  button:hover { transform: translateY(-1px); }
  button:active { transform: translateY(0) scale(.97); }
  input, textarea, select { transition: border-color .16s ease, box-shadow .16s ease; }
  input:focus, textarea:focus { outline: none; border-color: ${COLORS.blue} !important; box-shadow: 0 0 0 3px ${COLORS.blue}26; }
  .room { animation: rise .32s ease both; }
  .hcard { transition: transform .18s ease, background .18s ease, box-shadow .18s ease, border-color .18s ease; }
  .hcard:hover { transform: translateY(-2px); box-shadow: 0 8px 28px rgba(0,0,0,.38); }
  @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  ::selection { background: ${COLORS.blue}55; }
  @media (prefers-reduced-motion: reduce) { *, .room, .hcard { animation: none !important; transition: none !important; } }
`;
// Counts a score up/down to its new value — the "alive" numbers.
function AnimNum({ v, decimals = 1, style, prefix = "", suffix = "" }) {
  const [disp, setDisp] = useState(v);
  const prev = useRef(v);
  useEffect(() => {
    const from = prev.current, to = v; prev.current = v;
    if (from === to || typeof to !== "number" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setDisp(to); return; }
    const t0 = performance.now(), dur = 550; let raf;
    const tick = t => { const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3); setDisp(from + (to - from) * e); if (p < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [v]);
  return <span style={style}>{prefix}{typeof disp === "number" ? disp.toFixed(decimals) : "—"}{suffix}</span>;
}
const sigColor = l => (l === "RED" ? COLORS.red : l === "WATCH" ? COLORS.yellow : COLORS.green);
const tileColor = c => (c === "red" ? COLORS.red : c === "yellow" ? COLORS.yellow : c === "green" ? COLORS.green : COLORS.dim);
const decColor = d => (d === "GO" ? COLORS.green : d === "WATCH" ? COLORS.yellow : COLORS.red);
const scoreColor = v => (typeof v !== "number" ? COLORS.red : v >= 7 ? COLORS.green : v >= 4 ? COLORS.yellow : COLORS.red);

function Delta({ v, suffix = "" }) {
  if (v == null) return <span style={{ color: COLORS.dim }}>—</span>;
  return <span style={{ color: v > 0 ? COLORS.green : v < 0 ? COLORS.red : COLORS.dim, fontWeight: 600 }}>{v > 0 ? "▲" : v < 0 ? "▼" : "•"} {Math.abs(v).toFixed(1)}{suffix}</span>;
}
// ─── UI KIT ─────────────────────────────────────────────────────────────────
function useWide(bp = 860) {
  const [wide, setWide] = useState(typeof window !== "undefined" ? window.innerWidth >= bp : true);
  useEffect(() => {
    const on = () => setWide(window.innerWidth >= bp);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [bp]);
  return wide;
}
function Btn({ children, icon: I, color = COLORS.dim, accent, onClick, title, style }) {
  const c = accent || color;
  return (
    <button onClick={onClick} title={title} style={{ display: "inline-flex", alignItems: "center", gap: 7, background: accent ? `${c}14` : "transparent", color: accent ? c : COLORS.dim, border: `1px solid ${accent ? `${c}55` : COLORS.border}`, borderRadius: 10, padding: "8px 15px", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit", ...style }}>
      {I && <I size={15} strokeWidth={2.2} />} {children}
    </button>
  );
}
function PageHeader({ title, sub, children }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 14, flexWrap: "wrap", marginBottom: 26 }}>
      <div style={{ minWidth: 200 }}>
        <div style={{ fontSize: 27, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.1 }}>{title}</div>
        {sub && <div style={{ fontSize: 13.5, color: COLORS.dim, marginTop: 5 }}>{sub}</div>}
      </div>
      <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>{children}</div>
    </div>
  );
}
function Eyebrow({ children, style }) {
  return <div style={{ fontSize: 11, fontWeight: 600, color: COLORS.dim, letterSpacing: 1.4, textTransform: "uppercase", marginBottom: 10, ...style }}>{children}</div>;
}

function ScoreRing({ score, size = 52, decision }) {
  const pct = score != null ? Math.min(score / 10, 1) : 0, r = size / 2 - 4, c = 2 * Math.PI * r;
  const col = decision ? decColor(decision) : COLORS.gold;
  return (
    <svg width={size} height={size} style={{ filter: decision === "GO" ? `drop-shadow(0 0 8px ${col}66)` : "none" }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={COLORS.border} strokeWidth="4" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={col} strokeWidth="4" strokeDasharray={`${c * pct} ${c}`} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: "stroke-dasharray .6s ease, stroke .3s ease" }} />
      <text x="50%" y="54%" textAnchor="middle" dominantBaseline="middle" fill={COLORS.text} fontSize={size / 3.4} fontWeight="700">{score != null ? score.toFixed(1) : "—"}</text>
    </svg>
  );
}
function HeadlineList({ items }) {
  if (!items?.length) return null;
  return (
    <div style={{ marginTop: 8, background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: "8px 14px" }}>
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
  // Rules persist inside data.rules (merged over defaults) — edited in the Config room,
  // and they ride into every brief as CONFIG, which beats the skill's own defaults.
  const rules = {
    ...DEFAULT_RULES, ...(data.rules || {}),
    weights: { ...DEFAULT_RULES.weights, ...((data.rules || {}).weights || {}) },
    macro: { ...DEFAULT_RULES.macro, ...((data.rules || {}).macro || {}) },
  };
  const [room, setRoom] = useState("cockpit");
  const [selStock, setSelStock] = useState(null);
  const [selCluster, setSelCluster] = useState(null);
  const [fetchMsg, setFetchMsg] = useState("");
  const [drillTile, setDrillTile] = useState(null);
  const [briefModal, setBriefModal] = useState(null);
  const [syncModal, setSyncModal] = useState(false);
  const [syncText, setSyncText] = useState("");
  const [syncError, setSyncError] = useState("");
  const [editComp, setEditComp] = useState(null);
  const [clusterOvEdit, setClusterOvEdit] = useState(null);
  const [histDate, setHistDate] = useState(null);
  const [sectorEdit, setSectorEdit] = useState(false);
  const [copyMsg, setCopyMsg] = useState("");

  // ─── CLOUD SYNC ───────────────────────────────────────────────────────────
  // localStorage is the instant cache; Vercel Blob (via /api/state) is the truth
  // shared across devices. Last write wins by updatedAt. The sync key lives only
  // in this browser and gates the API.
  const [syncKey, setSyncKeyState] = useState(() => { try { return localStorage.getItem("screener-sync-key") || ""; } catch { return ""; } });
  const [syncStatus, setSyncStatus] = useState(syncKey ? "idle" : "off");
  const pushTimer = useRef(null);
  const setSyncKey = k => {
    const v = (k || "").trim();
    try { v ? localStorage.setItem("screener-sync-key", v) : localStorage.removeItem("screener-sync-key"); } catch {}
    setSyncKeyState(v); setSyncStatus(v ? "idle" : "off");
  };
  const cloudPush = useCallback((d, key) => {
    if (!key) return;
    clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(async () => {
      try {
        setSyncStatus("saving");
        const r = await fetch("/api/state", { method: "PUT", headers: { "Content-Type": "application/json", "x-sync-key": key }, body: JSON.stringify(d) });
        setSyncStatus(r.ok ? "synced" : "error");
      } catch { setSyncStatus("error"); }
    }, 1200);
  }, []);
  useEffect(() => {
    let local = null;
    try {
      const r = localStorage.getItem("screener-data-v3");
      if (r) { local = JSON.parse(r); setData(local); }
    } catch (e) { console.error("load failed", e); }
    if (!syncKey) return;
    (async () => {
      try {
        setSyncStatus("loading");
        const r = await fetch("/api/state", { headers: { "x-sync-key": syncKey } });
        if (r.status === 404) { if (local) cloudPush(local, syncKey); setSyncStatus("synced"); return; }
        if (r.status === 401) { setSyncStatus("badkey"); return; }
        if (!r.ok) { setSyncStatus("error"); return; }
        const cloud = await r.json();
        if (cloud && (!local || (cloud.updatedAt || 0) >= (local.updatedAt || 0))) {
          setData(cloud);
          try { localStorage.setItem("screener-data-v3", JSON.stringify(cloud)); } catch {}
        } else if (local) cloudPush(local, syncKey);
        setSyncStatus("synced");
      } catch { setSyncStatus("error"); }
    })();
  }, []);
  const persist = useCallback(d => {
    const stamped = { ...d, updatedAt: Date.now() };
    setData(stamped);
    try { localStorage.setItem("screener-data-v3", JSON.stringify(stamped)); } catch (e) { console.error("save failed", e); }
    cloudPush(stamped, syncKey);
  }, [syncKey, cloudPush]);

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

  const QUANT_KEYS = ["price", "pb", "peerPB", "pe", "indPE", "mktCap", "volume", "debt", "cash", "burnQ", "sharesOut", "analysts", "target", "low52", "ytd", "insiderNet", "insiderBuyPrice"];
  const applyQuant = (stock, obj) => {
    const f = obj.fields || {};
    const merged = { ...stock };
    QUANT_KEYS.forEach(k => { if (f[k] != null) merged[k] = f[k]; }); // only overwrite what came back; manual values survive a partial fetch
    if (obj.name && (!merged.name || merged.name === merged.ticker)) merged.name = obj.name;
    merged.lastFetch = { date: new Date().toISOString().slice(0, 10), missing: obj.missing || [], notes: obj.notes || "", currency: obj.currency || "" };
    return merged;
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

  // ─── BRIEF GENERATOR ────────────────────────────────────────────────────
  // Builds the paste-into-Claude brief for UPDATE SCAN or DISCUSS. The brief IS
  // Claude's memory: prior scores, reasoning, watch items, verdict, overrides.
  // ─── EDITABLE RULES ─────────────────────────────────────────────────────
  const setRule = async (key, value) => {
    const v = value === "" ? null : parseFloat(value);
    if (v == null || isNaN(v)) return;
    await persist({ ...data, rules: { ...(data.rules || {}), [key]: v } });
  };
  const setWeight = async (cluster, value) => {
    const v = parseFloat(value);
    if (isNaN(v) || v < 0) return;
    const weights = { ...rules.weights, [cluster]: v / 100 };
    await persist({ ...data, rules: { ...(data.rules || {}), weights } });
  };
  const resetRules = async () => {
    if (!confirm("Reset all weights, bands and veto thresholds to the framework defaults?")) return;
    await persist({ ...data, rules: {} });
  };

  // ─── PORTFOLIO ──────────────────────────────────────────────────────────
  const buildPortfolioBrief = () => [
    "PORTFOLIO UPDATE",
    `TRACKED: ${data.stocks.map(s => s.ticker).join(", ") || "none"}`,
    "(attach a screenshot of your broker holdings — the skill transcribes it and returns a portfolio_update block)",
  ].join("\n");
  const applyPortfolioUpdate = (d, obj) => {
    const today = obj.date || new Date().toISOString().slice(0, 10);
    const positions = (Array.isArray(obj.positions) ? obj.positions : []).filter(p => p && p.ticker);
    // Broker is ground truth for held stocks: shares + avg cost reconcile automatically.
    // Only kind:"stock" rows touch the book — options/ETFs display but don't set cost basis.
    const stocks = d.stocks.map(s => {
      const m = positions.find(p => (p.ticker || "").toUpperCase() === s.ticker && (p.kind || "stock") === "stock");
      if (!m) return s;
      return { ...s, held: true, shares: m.qty ?? s.shares, entryPrice: m.avgPrice ?? s.entryPrice, entryDate: s.entryDate || today };
    });
    return { stocks, portfolio: { date: today, cash: obj.cash ?? null, read: obj.read || "", positions } };
  };

  // ─── MARKET BRIEF + EDITABLE MACRO/SECTORS ──────────────────────────────
  const buildMarketBrief = () => {
    const L = [];
    L.push("MARKET UPDATE");
    L.push(`INCLUDE: ${(data.sectors || []).map(s => `${s.name}${s.etf ? ` (${s.etf})` : ""}`).join(", ") || "none"}`);
    L.push(`TICKERS: ${data.stocks.map(s => s.ticker).join(", ") || "none"}`);
    return L.join("\n");
  };
  const MACRO_FIELD = { cape: "cape", vix: "vix", fg: "fearGreed", buffett: "buffett", yield: "yield10", margin: "marginDebt" };
  const updateMacro = async (tileKey, value) => {
    const field = MACRO_FIELD[tileKey];
    const v = value === "" ? null : parseFloat(value);
    if (value !== "" && isNaN(v)) return;
    await persist({ ...data, macro: { ...data.macro, [field]: v }, macroDate: new Date().toISOString().slice(0, 10) });
  };
  const addSector = async (name, etf) => {
    if (!name.trim()) return;
    if ((data.sectors || []).some(x => x.name.toLowerCase() === name.trim().toLowerCase())) { setFetchMsg(`${name.trim()} is already in the sector list.`); return; }
    await persist({ ...data, sectors: [...(data.sectors || []), { name: name.trim(), etf: etf.trim(), change: null, read: "" }] });
  };
  const removeSector = async (name) => {
    if (!confirm(`Remove ${name} from the sector list? Market updates will stop covering it.`)) return;
    await persist({ ...data, sectors: (data.sectors || []).filter(x => x.name !== name) });
  };

  const buildBrief = (s, mode) => {
    const c = s.calc, cs = s.claudeScan, L = [];
    L.push(`${mode === "discuss" ? "DISCUSS" : "UPDATE SCAN"}: ${s.ticker}`);
    L.push("CONFIG");
    L.push(`  weights: ${JSON.stringify(rules.weights)}`);
    L.push(`  bands: { go: ${rules.goThreshold}, watch: ${rules.watchThreshold} }`);
    L.push(`  vetoes: { mktCapFloorM: ${rules.mktCapFloor}, minDailyVolume: ${rules.volHardVeto}, runwayVetoYears: ${rules.runwayVeto}, runwayMinYears: ${rules.runwayMin}, minAnalysts: ${rules.minAnalysts}, catalystWindowDays: ${rules.catalystWindow} }`);
    L.push(`LAST SCAN: ${cs?.date || "never (no full scan on record)"}`);
    const pf = {};
    QUANT_KEYS.forEach(k => { if (s[k] != null) pf[k] = s[k]; });
    L.push(`PRIOR FIELDS: ${JSON.stringify(pf)}`);
    L.push(`PRIOR CATALYST: ${s.catalystDate ? JSON.stringify({ type: s.catalystType, date: s.catalystDate, confidence: s.catalystConfidence }) : "none"}`);
    L.push("PRIOR CLUSTERS:");
    Object.keys(CLUSTER_NAMES).forEach(k => {
      const v = c.scores[k], cd = cs?.clusters?.[k];
      let line = `  ${k} ${CLUSTER_NAMES[k]}: ${typeof v === "number" ? v.toFixed(1) : "unscored"}`;
      if (cd?.reasoning) line += ` — ${cd.reasoning}`;
      L.push(line);
      if (["G", "H", "I"].includes(k)) {
        const items = c.trace[k].components.filter(x => x.input !== "—");
        if (items.length) L.push(`     items: ${items.map(x => `${x.name}=${x.input}`).join(", ")}`);
        items.forEach(x => { if (x.rationale) L.push(`     - ${x.name}: ${x.rationale}`); });
      }
      if (cd?.watch?.length) L.push(`     watch: ${cd.watch.join(" | ")}`);
    });
    L.push(`PRIOR VERDICT: ${cs?.verdict ? JSON.stringify(cs.verdict) : "none"}`);
    const ovs = Object.entries(c.overrideScores || {}).filter(([, o]) => o && o.value != null);
    L.push(`USER OVERRIDES: ${ovs.length ? ovs.map(([k, o]) => `${k}=${o.value} (${o.reason || "no reason logged"})`).join("; ") : "none"}`);
    if (cs?.vetoes?.tripped?.length) L.push(`PRIOR VETOES TRIPPED: ${cs.vetoes.tripped.join("; ")}`);
    if ((s.notebook || []).length) { L.push("NOTEBOOK:"); s.notebook.slice(0, 5).forEach(n => L.push(`  ${n.date}: ${n.text}`)); }
    return L.join("\n");
  };

  // ─── UNIVERSAL SYNC ─────────────────────────────────────────────────────
  // Merges one stock block (quant fields + catalyst + G/H/I quals) into a stocks array.
  // capturePrev freezes prevPrice/prevScore/prevScores before applying — the weekly cycle marker.
  const applyStockBlock = (stocksArr, obj, capturePrev) => {
    const idx = stocksArr.findIndex(s => s.ticker === obj.ticker);
    const added = idx < 0;
    let next = added
      ? { ticker: obj.ticker, name: obj.name || obj.ticker, sector: obj.sector || "", held: false, entryPrice: null,
          picpot: Array(6).fill(null), moat: Array(6).fill(null), mgmt: Array(5).fill(null),
          qualRationale: {}, overrideScores: {}, notebook: [], overrides: [], decisions: [] }
      : { ...stocksArr[idx] };
    if (capturePrev && !added) {
      const exCalc = computeStock(stocksArr[idx], rules);
      next.prevPrice = stocksArr[idx].price ?? null; next.prevScore = exCalc.composite; next.prevScores = exCalc.scores;
    }
    if (obj.fields && typeof obj.fields === "object") next = applyQuant(next, obj);
    if (obj.catalyst === null) { next.catalystType = null; next.catalystDate = null; next.catalystConfidence = null; }
    else if (obj.catalyst && typeof obj.catalyst === "object") {
      if (obj.catalyst.type != null) next.catalystType = obj.catalyst.type;
      if (obj.catalyst.date != null) next.catalystDate = obj.catalyst.date;
      if (obj.catalyst.confidence != null) next.catalystConfidence = obj.catalyst.confidence;
    }
    ["G", "H", "I"].forEach(cl => {
      if (Array.isArray(obj[cl])) {
        const arrKey = cl === "G" ? "picpot" : cl === "H" ? "moat" : "mgmt";
        const arr = [...(next[arrKey] || Array(cl === "I" ? 5 : 6).fill(null))];
        const qr = { ...(next.qualRationale || {}) }; qr[cl] = { ...(qr[cl] || {}) };
        obj[cl].forEach((comp, i) => { if (comp && comp.score != null) arr[i] = comp.score; if (comp) qr[cl][i] = { text: comp.rationale || qr[cl][i]?.text || "", sources: comp.sources || qr[cl][i]?.sources || [] }; });
        next[arrKey] = arr; next.qualRationale = qr;
      }
    });
    const stocks = added ? [...stocksArr, next] : stocksArr.map((s, i) => (i === idx ? next : s));
    return { stocks, added };
  };

  // ─── FULL SCAN ingest ───────────────────────────────────────────────────
  // Deep dossier from the skill's full_scan block. Creates the stock on the board
  // (replaces Add Ticker), or refreshes an existing one. Quant, catalyst, quals and
  // the dossier are replaced; position, notes, decisions and history survive.
  const applyFullScan = (stocksArr, obj) => {
    const idx = stocksArr.findIndex(s => s.ticker === obj.ticker);
    const added = idx < 0;
    let next = added
      ? { ticker: obj.ticker, name: obj.name || obj.ticker, sector: obj.sector || "", held: false, entryPrice: null,
          picpot: Array(6).fill(null), moat: Array(6).fill(null), mgmt: Array(5).fill(null),
          qualRationale: {}, overrideScores: {}, notebook: [], overrides: [], decisions: [] }
      : { ...stocksArr[idx] };
    if (!added) {
      const exCalc = computeStock(stocksArr[idx], rules);
      next.prevPrice = stocksArr[idx].price ?? null; next.prevScore = exCalc.composite; next.prevScores = exCalc.scores;
    }
    if (obj.name) next.name = obj.name;
    if (obj.fields && typeof obj.fields === "object") next = applyQuant(next, obj);
    if (obj.catalyst === null) { next.catalystType = null; next.catalystDate = null; next.catalystConfidence = null; }
    else if (obj.catalyst && typeof obj.catalyst === "object") {
      next.catalystType = obj.catalyst.type ?? next.catalystType;
      next.catalystDate = obj.catalyst.date ?? next.catalystDate;
      next.catalystConfidence = obj.catalyst.confidence ?? next.catalystConfidence;
    }
    const cl = obj.clusters || {};
    ["G", "H", "I"].forEach(k => {
      const items = cl[k] && Array.isArray(cl[k].items) ? cl[k].items : null;
      if (items) {
        const arrKey = k === "G" ? "picpot" : k === "H" ? "moat" : "mgmt";
        const arr = Array(k === "I" ? 5 : 6).fill(null);
        const qr = { ...(next.qualRationale || {}) }; qr[k] = {};
        items.forEach((c, i) => {
          if (c && c.score != null) arr[i] = c.score;
          if (c) qr[k][i] = { text: c.rationale || "", sources: c.sources || [] };
        });
        next[arrKey] = arr; next.qualRationale = qr;
      }
    });
    // The dossier layer — Claude's facts, reasoning, watch items, verdict, bear case.
    next.claudeScan = {
      kind: "full_scan", date: obj.date || new Date().toISOString().slice(0, 10),
      clusters: Object.fromEntries(Object.entries(cl).map(([k, c]) => [k, {
        score: typeof c.score === "number" ? c.score : null,
        facts: Array.isArray(c.facts) ? c.facts : [],
        reasoning: c.reasoning || "",
        watch: Array.isArray(c.watch) ? c.watch : [],
      }])),
      composite: typeof obj.composite === "number" ? obj.composite : null,
      band: obj.band || "", vetoes: obj.vetoes || null,
      verdict: obj.verdict || null, bearCase: obj.bearCase || "", summary: obj.summary || "",
    };
    const stocks = added ? [...stocksArr, next] : stocksArr.map((s, i) => (i === idx ? next : s));
    return { stocks, added };
  };

  // ─── UPDATE SCAN ingest ─────────────────────────────────────────────────
  // Refreshes a tracked stock from an update_scan block (from an UPDATE SCAN or
  // a finalized DISCUSS). Captures prev state for the diff arrows, freezes a
  // snapshot of the NEW state into history (with the update's summary), merges
  // the dossier with per-cluster changed/changeNote, watch check, verdict.
  const applyUpdateScan = (d, obj) => {
    const idx = d.stocks.findIndex(s => s.ticker === obj.ticker);
    if (idx < 0) return { error: `${obj.ticker} isn't on the board. Run a FULL SCAN first — updates only refresh existing stocks.` };
    const prior = d.stocks[idx];
    const exCalc = computeStock(prior, rules);
    let next = { ...prior, prevPrice: prior.price ?? null, prevScore: exCalc.composite, prevScores: exCalc.scores };
    if (obj.fields && typeof obj.fields === "object") next = applyQuant(next, obj);
    if (obj.catalyst === null) { next.catalystType = null; next.catalystDate = null; next.catalystConfidence = null; }
    else if (obj.catalyst && typeof obj.catalyst === "object") {
      next.catalystType = obj.catalyst.type ?? next.catalystType;
      next.catalystDate = obj.catalyst.date ?? next.catalystDate;
      next.catalystConfidence = obj.catalyst.confidence ?? next.catalystConfidence;
    }
    const cl = obj.clusters || {};
    ["G", "H", "I"].forEach(k => {
      const items = cl[k] && Array.isArray(cl[k].items) ? cl[k].items : null;
      if (items) {
        const arrKey = k === "G" ? "picpot" : k === "H" ? "moat" : "mgmt";
        const arr = Array(k === "I" ? 5 : 6).fill(null);
        const qr = { ...(next.qualRationale || {}) }; qr[k] = {};
        items.forEach((c, i) => {
          if (c && c.score != null) arr[i] = c.score;
          if (c) qr[k][i] = { text: c.rationale || "", sources: c.sources || [] };
        });
        next[arrKey] = arr; next.qualRationale = qr;
      }
    });
    const prevClusters = (prior.claudeScan && prior.claudeScan.clusters) || {};
    const mergedClusters = { ...prevClusters };
    Object.entries(cl).forEach(([k, c]) => {
      mergedClusters[k] = {
        score: typeof c.score === "number" ? c.score : (prevClusters[k]?.score ?? null),
        facts: Array.isArray(c.facts) ? c.facts : (prevClusters[k]?.facts || []),
        reasoning: c.reasoning || prevClusters[k]?.reasoning || "",
        watch: Array.isArray(c.watch) ? c.watch : (prevClusters[k]?.watch || []),
        changed: !!c.changed, changeNote: c.changed ? (c.changeNote || "") : null,
      };
    });
    next.claudeScan = {
      kind: obj.type || "update_scan", date: obj.date || new Date().toISOString().slice(0, 10),
      clusters: mergedClusters,
      composite: typeof obj.composite === "number" ? obj.composite : (prior.claudeScan?.composite ?? null),
      band: obj.band || prior.claudeScan?.band || "",
      vetoes: obj.vetoes || prior.claudeScan?.vetoes || null,
      verdict: obj.verdict || prior.claudeScan?.verdict || null,
      bearCase: prior.claudeScan?.bearCase || "",
      summary: obj.summary || "",
      watchCheck: Array.isArray(obj.watchCheck) ? obj.watchCheck : [],
    };
    const stocks = d.stocks.map((s, i) => (i === idx ? next : s));
    // Freeze the post-update state into history, keyed by the scan date.
    const newCalc = computeStock(next, rules);
    const snapshots = JSON.parse(JSON.stringify(d.snapshots || {}));
    if (!snapshots[obj.ticker]) snapshots[obj.ticker] = [];
    const snap = makeSnapshot(next, newCalc, next.claudeScan.date, obj.summary || "");
    const last = snapshots[obj.ticker][snapshots[obj.ticker].length - 1];
    if (last && last.date === snap.date) snapshots[obj.ticker][snapshots[obj.ticker].length - 1] = snap;
    else snapshots[obj.ticker].push(snap);
    return { stocks, snapshots };
  };

  const applySync = async () => {
    setSyncError("");
    try {
      const start = syncText.indexOf("{"), end = syncText.lastIndexOf("}");
      if (start < 0 || end < 0) { setSyncError("No JSON object found. Paste the block Claude gave you, including the { } braces."); return; }
      let obj;
      try { obj = JSON.parse(syncText.slice(start, end + 1)); }
      catch (e) { setSyncError("JSON didn't parse: " + e.message + ". Make sure you copied the whole block."); return; }

      // ── PORTFOLIO UPDATE: broker screenshot transcription → reconcile the book ──
      if (obj.type === "portfolio_update") {
        const res = applyPortfolioUpdate(data, obj);
        await persist({ ...data, stocks: res.stocks, portfolio: res.portfolio });
        setSyncModal(false); setSyncText("");
        const matched = res.portfolio.positions.filter(p => (p.kind || "stock") === "stock" && data.stocks.some(s => s.ticker === (p.ticker || "").toUpperCase())).length;
        setFetchMsg(`Portfolio imported — ${res.portfolio.positions.length} holdings read, ${matched} reconciled with the board`);
        setRoom("positions");
        return;
      }

      // ── MARKET UPDATE: macro tiles + sector reads + headlines + backdrop ──
      if (obj.type === "market_update") {
        const report = [];
        let d = { ...data };
        if (obj.macro && typeof obj.macro === "object") {
          const m = { ...d.macro }; let n = 0;
          ["cape", "vix", "fearGreed", "buffett", "yield10", "marginDebt"].forEach(k => { if (obj.macro[k] != null) { m[k] = obj.macro[k]; n++; } });
          if (n) { d.macro = m; report.push(`macro ${n}/6`); }
        }
        if (Array.isArray(obj.sectors)) {
          const sectors = [...(d.sectors || [])]; let upd = 0, addS = 0;
          obj.sectors.forEach(sec => {
            if (!sec || !sec.name) return;
            const i = sectors.findIndex(x => (x.name || "").toLowerCase() === sec.name.toLowerCase());
            const patch = { ...(sec.etf ? { etf: sec.etf } : {}), ...(sec.change != null ? { change: sec.change } : {}), ...(sec.read ? { read: sec.read } : {}) };
            if (i >= 0) { sectors[i] = { ...sectors[i], ...patch }; upd++; }
            else { sectors.push({ name: sec.name, etf: sec.etf || "", change: sec.change ?? null, read: sec.read || "" }); addS++; }
          });
          d.sectors = sectors; report.push(`sectors ${upd}${addS ? `+${addS} new` : ""}`);
        }
        if (Array.isArray(obj.headlines)) {
          d.headlines = obj.headlines.filter(h => h && h.headline);
          d.headlinesDate = obj.date || new Date().toISOString().slice(0, 10);
          report.push(`${d.headlines.length} headlines`);
        }
        if (obj.read) { d.marketRead = obj.read; report.push("backdrop read"); }
        d.macroDate = obj.date || new Date().toISOString().slice(0, 10);
        await persist(d);
        setSyncModal(false); setSyncText("");
        setFetchMsg(`Market update applied — ${report.join(" · ") || "nothing recognized in the block"}`);
        setRoom("cockpit");
        return;
      }

      // ── UPDATE SCAN: refresh a tracked stock, freeze snapshot, render the diff ──
      if (obj.type === "update_scan") {
        if (!obj.ticker) { setSyncError('update_scan block is missing "ticker".'); return; }
        const res = applyUpdateScan(data, obj);
        if (res.error) { setSyncError(res.error); return; }
        await persist({ ...data, stocks: res.stocks, snapshots: res.snapshots });
        setSyncModal(false); setSyncText("");
        const changed = Object.entries(obj.clusters || {}).filter(([, c]) => c && c.changed).map(([k]) => k);
        setFetchMsg(`${obj.ticker} updated — verdict ${obj.verdict?.call ? obj.verdict.call.split("_").join(" ") : "—"}${changed.length ? ` · moved: ${changed.join(", ")}` : " · no cluster changes"} · snapshot frozen`);
        openDesk(obj.ticker);
        return;
      }

      // ── FULL SCAN: deep dossier — creates the stock, or overwrites after confirm ──
      if (obj.type === "full_scan") {
        if (!obj.ticker) { setSyncError('full_scan block is missing "ticker".'); return; }
        const exists = data.stocks.some(s => s.ticker === obj.ticker);
        if (exists && !window.confirm(`${obj.ticker} is already on the board. Overwrite with this full scan?\n\nQuant, catalyst, qual scores and the dossier get replaced. Your position, notes, decisions and history stay.`)) return;
        const res = applyFullScan(data.stocks, obj);
        await persist({ ...data, stocks: res.stocks });
        setSyncModal(false); setSyncText("");
        const miss = obj.missing || [];
        setFetchMsg(`${obj.ticker} full scan ${res.added ? "added to the board" : "refreshed"} — Claude's verdict: ${obj.verdict?.call ? obj.verdict.call.split("_").join(" ") : "—"}${miss.length ? ` · not verified: ${miss.join(", ")}` : ""}`);
        openDesk(obj.ticker);
        return;
      }

      // ── WEEKLY UPDATE: macro + sectors + headlines + all stocks in one block ──
      if (obj.type === "weekly_update") {
        const report = [];
        let d = { ...data };
        if (obj.macro && typeof obj.macro === "object") {
          const m = { ...d.macro }; let n = 0;
          ["cape", "vix", "fearGreed", "buffett", "yield10", "marginDebt"].forEach(k => { if (obj.macro[k] != null) { m[k] = obj.macro[k]; n++; } });
          if (n) { d.macro = m; report.push(`macro ${n}/6`); }
        }
        if (Array.isArray(obj.sectors)) {
          const sectors = [...(d.sectors || [])]; let upd = 0, addS = 0;
          obj.sectors.forEach(sec => {
            if (!sec || !sec.name) return;
            const i = sectors.findIndex(x => (x.name || "").toLowerCase() === sec.name.toLowerCase());
            if (i >= 0) { sectors[i] = { ...sectors[i], ...(sec.etf ? { etf: sec.etf } : {}), ...(sec.change != null ? { change: sec.change } : {}) }; upd++; }
            else { sectors.push({ name: sec.name, etf: sec.etf || "", change: sec.change ?? null }); addS++; }
          });
          d.sectors = sectors; report.push(`sectors ${upd}${addS ? `+${addS} new` : ""}`);
        }
        if (Array.isArray(obj.headlines)) {
          d.headlines = obj.headlines.filter(h => h && h.headline);
          d.headlinesDate = obj.date || new Date().toISOString().slice(0, 10);
          report.push(`${d.headlines.length} headlines`);
        }
        if (Array.isArray(obj.stocks)) {
          let stocks = [...d.stocks]; let upd = 0; const addedT = [];
          obj.stocks.forEach(sb => {
            if (!sb || !sb.ticker) return;
            const res = applyStockBlock(stocks, sb, true);
            stocks = res.stocks; if (res.added) addedT.push(sb.ticker); else upd++;
          });
          d.stocks = stocks; report.push(`${upd} stocks updated${addedT.length ? `, added ${addedT.join(", ")}` : ""}`);
        }
        await persist(d);
        setSyncModal(false); setSyncText("");
        setFetchMsg(`Weekly update applied — ${report.join(" · ") || "nothing recognized in the block"}`);
        return;
      }

      // ── SINGLE STOCK: stock_update, or a legacy qual-only block ──
      if (!obj.ticker) { setSyncError('Missing "ticker" field in the JSON (and no "type":"weekly_update" found).'); return; }
      const res = applyStockBlock(data.stocks, obj, obj.type === "stock_update");
      await persist({ ...data, stocks: res.stocks });
      setSyncModal(false); setSyncText("");
      setFetchMsg(res.added ? `${obj.ticker} added to the board from Claude's block.` : `${obj.ticker} updated from Claude's block.`);
      if (res.added) openDesk(obj.ticker);
    } catch (e) { setSyncError("Unexpected error: " + e.message); }
  };

  // ─── BACKUP: full-state export / import ───────────────────────────────
  const exportAll = () => {
    const payload = { app: "the-screener", backupVersion: 1, exportDate: new Date().toISOString(), data };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `screener-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setFetchMsg("Backup downloaded. Keep it somewhere safe (Files, iCloud).");
  };

  const importAll = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const payload = JSON.parse(ev.target.result);
        const d = payload && payload.app === "the-screener" && payload.data ? payload.data : payload;
        if (!d || !Array.isArray(d.stocks)) { setFetchMsg("Import failed: this file doesn't look like a Screener backup (no stocks array)."); return; }
        const when = payload.exportDate ? new Date(payload.exportDate).toISOString().slice(0, 10) : "unknown date";
        const ok = window.confirm(`Restore backup from ${when}?\n\nThis REPLACES everything currently in the app (${data.stocks.length} stocks now vs ${d.stocks.length} in the backup). This cannot be undone.\n\nTip: export a backup of the current state first if unsure.`);
        if (!ok) { setFetchMsg("Import cancelled. Nothing changed."); return; }
        await persist(d);
        setFetchMsg(`Backup from ${when} restored: ${d.stocks.length} stocks.`);
      } catch (e) {
        setFetchMsg("Import failed: couldn't read that file as JSON. " + e.message);
      }
    };
    reader.readAsText(file);
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

  const sel = selStock ? computed.find(s => s.ticker === selStock) : null;
  const generalHeadlines = (data.headlines || []).filter(h => h.sector === "General");
  const sectorHeadlines = (data.headlines || []).filter(h => h.sector !== "General");
  const inp = { width: "100%", background: COLORS.bg, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 9, padding: 6, marginTop: 4, boxSizing: "border-box", fontFamily: "inherit" };
  const wide = useWide();
  const NAV_ITEMS = [["cockpit", "Cockpit", Gauge], ["desk", "Trading desk", LayoutList], ["positions", "Positions", Briefcase], ["config", "Config", Settings]];
  const goRoom = r => { setRoom(r); if (r !== "desk") { setSelStock(null); setSelCluster(null); } };

  return (
    <div style={{ fontFamily: "'Outfit', 'Segoe UI', system-ui, sans-serif", fontVariantNumeric: "tabular-nums", background: COLORS.bg, minHeight: "100vh", color: COLORS.text }}>
      <style>{GLOBAL_CSS}</style>
      <div style={{ display: "flex", minHeight: "100vh", alignItems: "stretch" }}>

      {/* SIDEBAR (wide screens) */}
      {wide && (
        <aside style={{ width: 218, flexShrink: 0, borderRight: `1px solid ${COLORS.border}`, padding: "22px 14px", display: "flex", flexDirection: "column", gap: 3, position: "sticky", top: 0, alignSelf: "flex-start", height: "100vh", boxSizing: "border-box" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "2px 10px 22px" }}>
            <div style={{ width: 32, height: 32, borderRadius: 10, background: `${COLORS.gold}1A`, border: `1px solid ${COLORS.gold}55`, boxShadow: glow(COLORS.gold, 10), display: "flex", alignItems: "center", justifyContent: "center" }}><Zap size={15} color={COLORS.gold} /></div>
            <div>
              <div style={{ fontWeight: 800, fontSize: 14.5, letterSpacing: "-0.01em", lineHeight: 1.15 }}>The Screener</div>
              <div style={{ fontSize: 10.5, color: COLORS.dim }}>micro-cap radar</div>
            </div>
          </div>
          {NAV_ITEMS.map(([r, lbl, I]) => (
            <button key={r} onClick={() => goRoom(r)} style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", textAlign: "left", background: room === r ? COLORS.panelLight : "transparent", color: room === r ? COLORS.text : COLORS.dim, border: "none", borderRadius: 11, padding: "10px 12px", cursor: "pointer", fontSize: 13.5, fontWeight: 600, fontFamily: "inherit" }}>
              <I size={17} strokeWidth={2.1} color={room === r ? COLORS.gold : COLORS.dim} /> {lbl}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 11, color: COLORS.dim, padding: "0 12px", lineHeight: 1.7 }}>
            {data.stocks.length} on the board<br />{positions.length} held{data.portfolio ? ` · imported ${data.portfolio.date.slice(5)}` : ""}<br />
            <span style={{ color: syncStatus === "synced" ? COLORS.green : syncStatus === "error" || syncStatus === "badkey" ? COLORS.red : COLORS.dim }}>
              ● cloud {syncStatus === "off" ? "sync off" : syncStatus === "badkey" ? "bad key" : syncStatus}
            </span>
          </div>
        </aside>
      )}

      <div style={{ flex: 1, minWidth: 0 }}>

      {/* TOP BAR (narrow screens) */}
      {!wide && (
        <div style={{ display: "flex", alignItems: "center", padding: "12px 16px", borderBottom: `1px solid ${COLORS.border}`, gap: 8, overflowX: "auto" }}>
          <div style={{ width: 28, height: 28, minWidth: 28, borderRadius: 9, background: `${COLORS.gold}1A`, border: `1px solid ${COLORS.gold}55`, display: "flex", alignItems: "center", justifyContent: "center" }}><Zap size={13} color={COLORS.gold} /></div>
          {NAV_ITEMS.map(([r, lbl, I]) => (
            <button key={r} onClick={() => goRoom(r)} style={{ display: "inline-flex", alignItems: "center", gap: 7, background: room === r ? COLORS.panelLight : "transparent", color: room === r ? COLORS.text : COLORS.dim, border: `1px solid ${room === r ? COLORS.border : "transparent"}`, borderRadius: 999, padding: "6px 14px", cursor: "pointer", fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", fontFamily: "inherit" }}><I size={14} color={room === r ? COLORS.gold : COLORS.dim} /> {lbl}</button>
          ))}
        </div>
      )}

      {/* STATUS TOAST */}
      {fetchMsg && (
        <div onClick={() => setFetchMsg("")} style={{ margin: "14px 26px 0", background: COLORS.panelLight, border: `1px solid ${COLORS.blue}44`, borderRadius: 12, boxShadow: glow(COLORS.blue, 12), padding: "9px 16px", fontSize: 12.5, color: COLORS.text, cursor: "pointer", display: "flex", gap: 10, alignItems: "center" }}>
          <Zap size={14} color={COLORS.blue} style={{ minWidth: 14 }} /><span>{fetchMsg}</span><X size={13} color={COLORS.dim} style={{ marginLeft: "auto", minWidth: 13 }} />
        </div>
      )}

      {/* BRIEF MODAL */}
      {briefModal && (() => {
        const isMarket = briefModal.mode === "market", isPortfolio = briefModal.mode === "portfolio";
        const s = isMarket || isPortfolio ? null : computed.find(x => x.ticker === briefModal.ticker);
        const text = isPortfolio ? buildPortfolioBrief() : isMarket ? buildMarketBrief() : buildBrief(s, briefModal.mode);
        const isDiscuss = briefModal.mode === "discuss";
        const accent = isMarket || isPortfolio ? COLORS.blue : isDiscuss ? COLORS.green : COLORS.gold;
        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ background: COLORS.panel, border: `1px solid ${accent}`, borderRadius: 18, padding: 24, width: "min(720px, 94vw)" }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>{isPortfolio ? "💼 Portfolio import brief" : isMarket ? "🌍 Market update brief" : isDiscuss ? `💬 Discuss ${briefModal.ticker} with Claude` : `📤 Update scan brief — ${briefModal.ticker}`}</div>
              <div style={{ color: COLORS.dim, fontSize: 12, marginBottom: 12 }}>{isPortfolio
                ? "Copy this into any Claude chat and ATTACH a screenshot of your broker holdings (IBKR positions page works great). The skill transcribes every row and returns a portfolio_update block — paste it back via Paste portfolio and the book reconciles itself."
                : isMarket
                ? "Copy this into any Claude chat. The skill refreshes the macro tiles, reads each sector, pulls the week's headlines and hands back a market_update block. Paste it back via Paste market. Want to skip a sector this pass? Add an EXCLUDE: line before sending."
                : isDiscuss
                ? "Copy this into any Claude chat and argue it out — scores, thesis, overrides. Claude has the full prior state and won't emit JSON until you say finalize. When you do, paste the update_scan block back via Paste result."
                : "Copy this into any Claude chat. The skill re-researches the stock against this prior state, works the watch list, and hands back an update_scan block. Paste that back via Paste result — the app draws the diff and freezes a snapshot."}</div>
              <textarea id="briefTextArea" readOnly value={text} onFocus={e => e.target.select()} style={{ ...inp, height: isMarket || isPortfolio ? 120 : 280, fontSize: 11, fontFamily: "monospace" }} />
              <div style={{ display: "flex", gap: 10, marginTop: 12, justifyContent: "flex-end", alignItems: "center" }}>
                {copyMsg && <span style={{ fontSize: 12, color: COLORS.green }}>{copyMsg}</span>}
                <button onClick={() => copyText(text)} style={{ background: accent, color: "#0E1420", border: "none", borderRadius: 10, padding: "8px 18px", cursor: "pointer", fontWeight: 700 }}>📋 Copy</button>
                <button onClick={() => { setBriefModal(null); setCopyMsg(""); }} style={{ background: "transparent", color: COLORS.dim, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "8px 16px", cursor: "pointer" }}>Close</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* SYNC MODAL */}
      {syncModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.blue}`, borderRadius: 18, padding: 24, width: "min(720px, 94vw)" }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>⬇ Sync from Claude</div>
            <div style={{ color: COLORS.dim, fontSize: 12, marginBottom: 12 }}>Paste any JSON block Claude returns — a <code style={{ color: COLORS.blue }}>full_scan</code> (adds or overwrites a stock with the deep dossier), an <code style={{ color: COLORS.blue }}>update_scan</code> (refreshes a tracked stock, draws the diff, freezes a snapshot — also what a finalized DISCUSS emits), a <code style={{ color: COLORS.blue }}>weekly_update</code>, a <code style={{ color: COLORS.blue }}>stock_update</code>, or an old qual-only block. Manual values survive: only fields present in the block are overwritten.</div>
            <textarea value={syncText} onChange={e => { setSyncText(e.target.value); setSyncError(""); }} placeholder='{"ticker":"ATYR","G":[...],"H":[...],"I":[...]}' style={{ ...inp, height: 200, fontSize: 11, fontFamily: "monospace" }} />
            {syncError && <div style={{ color: COLORS.red, fontSize: 12, marginTop: 8 }}>⚠️ {syncError}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 12, justifyContent: "flex-end" }}>
              <button onClick={() => { setSyncModal(false); setSyncText(""); setSyncError(""); }} style={{ background: "transparent", color: COLORS.dim, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "8px 16px", cursor: "pointer" }}>Cancel</button>
              <button onClick={applySync} style={{ background: COLORS.blue, color: "#0E1420", border: "none", borderRadius: 10, padding: "8px 18px", cursor: "pointer", fontWeight: 700 }}>Apply block</button>
            </div>
          </div>
        </div>
      )}

      {/* ══ COCKPIT ══ */}
      {room === "cockpit" && (
        <div className="room" style={{ padding: "26px 28px 48px", maxWidth: 1080, margin: "0 auto" }}>
          <PageHeader title="Cockpit" sub={`The macro backdrop and this week's signal${data.macroDate ? ` · updated ${data.macroDate}` : ""}`}>
            <Btn icon={Upload} accent={COLORS.gold} onClick={() => { setBriefModal({ ticker: null, mode: "market" }); setCopyMsg(""); }}>Market brief</Btn>
            <Btn icon={ClipboardPaste} accent={COLORS.blue} onClick={() => { setSyncModal(true); setSyncError(""); }}>Paste market</Btn>
          </PageHeader>
          <Eyebrow>Macro — tap a tile for the rule, or set a value by hand</Eyebrow>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {macro.tiles.map(t => (
              <div key={t.key} className="hcard" onClick={() => setDrillTile(drillTile === t.key ? null : t.key)} style={{ flex: "1 1 120px", background: COLORS.panel, border: `1px solid ${drillTile === t.key ? tileColor(t.color) : COLORS.border}`, borderRadius: 14, padding: "10px 12px", cursor: "pointer", position: "relative" }}>
                <a href={MACRO_LINKS[t.key]} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} title="Open source" style={{ position: "absolute", top: 8, right: 8, color: COLORS.dim, textDecoration: "none", fontSize: 12 }}>↗</a>
                <div style={{ fontSize: 11, color: COLORS.dim }}>{t.label}</div>
                <div style={{ fontSize: 19, fontWeight: 700, color: tileColor(t.color) }}>{t.val ?? "—"}</div>
                <div style={{ fontSize: 10, color: COLORS.dim }}>{t.note}</div>
                {drillTile === t.key && (
                  <div onClick={e => e.stopPropagation()} style={{ fontSize: 10, color: COLORS.gold, marginTop: 6, borderTop: `1px solid ${COLORS.border}`, paddingTop: 6 }}>
                    Rule: {t.rule}
                    <input type="number" step="any" defaultValue={t.val ?? ""} placeholder="set value" onKeyDown={e => { if (e.key === "Enter") { updateMacro(t.key, e.target.value); setDrillTile(null); } }} onBlur={e => { if (e.target.value !== String(t.val ?? "")) updateMacro(t.key, e.target.value); }} style={{ ...inp, marginTop: 6, fontSize: 12, padding: 4 }} />
                  </div>
                )}
              </div>
            ))}
            <div style={{ flex: "1.4 1 200px", background: COLORS.panel, border: `2px solid ${macro.temp.color}`, borderRadius: 14, padding: "10px 14px" }}>
              <div style={{ fontSize: 11, color: COLORS.dim }}>MARKET TEMPERATURE</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: macro.temp.color }}>{macro.temp.label}</div>
              <div style={{ fontSize: 11 }}>{macro.temp.advice}</div>
            </div>
          </div>
          {data.marketRead && <div style={{ marginTop: 10, background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: "10px 14px", fontSize: 12, lineHeight: 1.55 }}>🌍 <b>The backdrop:</b> {data.marketRead}</div>}
          <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.dim, letterSpacing: 1 }}>THIS WEEK — GENERAL MARKET</div>
            {data.headlinesDate && <span style={{ fontSize: 10, color: COLORS.dim }}>updated {data.headlinesDate}</span>}
          </div>
          {generalHeadlines.length > 0 ? <HeadlineList items={generalHeadlines} /> : <div style={{ marginTop: 8, fontSize: 12, color: COLORS.dim, fontStyle: "italic" }}>No headlines yet — run a Market brief through the skill and paste the block back.</div>}

          <div style={{ marginTop: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <Eyebrow style={{ marginBottom: 0 }}>Sector pulse</Eyebrow>
              <button onClick={() => setSectorEdit(!sectorEdit)} style={{ background: "transparent", color: sectorEdit ? COLORS.gold : COLORS.dim, border: `1px solid ${sectorEdit ? COLORS.gold : COLORS.border}`, borderRadius: 9, padding: "2px 10px", cursor: "pointer", fontSize: 11 }}>{sectorEdit ? "done" : "✎ edit"}</button>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {data.sectors.map(s => (
                <div key={s.name} style={{ flex: "1 1 150px", background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: "8px 12px", position: "relative" }}>
                  {sectorEdit
                    ? <button onClick={() => removeSector(s.name)} title="Remove sector" style={{ position: "absolute", top: 6, right: 8, background: "transparent", color: COLORS.red, border: "none", cursor: "pointer", fontSize: 13 }}>✕</button>
                    : <a href={etfLink(s.etf)} target="_blank" rel="noopener noreferrer" title="Open ETF chart" style={{ position: "absolute", top: 6, right: 8, color: COLORS.dim, textDecoration: "none", fontSize: 12 }}>↗</a>}
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{s.name} <span style={{ color: COLORS.dim, fontWeight: 400, fontSize: 10 }}>{s.etf}</span></div>
                  <Delta v={s.change} suffix="%" />
                  {s.read && <div style={{ fontSize: 10, color: COLORS.dim, marginTop: 4, lineHeight: 1.4 }}>{s.read}</div>}
                </div>
              ))}
              {sectorEdit && (
                <div style={{ flex: "1 1 200px", background: COLORS.bg, border: `1px dashed ${COLORS.border}`, borderRadius: 14, padding: "8px 12px", display: "grid", gap: 6 }}>
                  <input id="newSectorName" placeholder="Sector name" style={{ ...inp, marginTop: 0, fontSize: 12, padding: 5 }} />
                  <input id="newSectorEtf" placeholder="ETF proxy (e.g. URA)" style={{ ...inp, marginTop: 0, fontSize: 12, padding: 5, textTransform: "uppercase" }} />
                  <button onClick={() => { const n = document.getElementById("newSectorName"), e = document.getElementById("newSectorEtf"); addSector(n.value, e.value); n.value = ""; e.value = ""; }} style={{ background: COLORS.gold, color: "#1B2A4A", border: "none", borderRadius: 9, padding: "5px 0", cursor: "pointer", fontWeight: 700, fontSize: 12 }}>＋ Add sector</button>
                </div>
              )}
            </div>
            <HeadlineList items={sectorHeadlines} />
          </div>

          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: COLORS.dim, letterSpacing: 1, marginBottom: 8 }}>NEEDS ATTENTION</div>
            <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 14, overflow: "hidden" }}>
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
            <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 14, overflow: "auto" }}>
              <div style={{ minWidth: 720 }}>
                <div style={{ display: "grid", gridTemplateColumns: "70px 1fr 65px 75px 60px 85px 85px 95px", gap: 8, padding: "8px 14px", fontSize: 10, color: COLORS.dim, fontWeight: 700, borderBottom: `1px solid ${COLORS.border}` }}>
                  <span>TICKER</span><span>NAME</span><span>SCORE</span><span>Δ WEEK</span><span>SIGNAL</span><span>CATALYST</span><span>PRICE Δ</span><span>DECISION</span>
                </div>
                {sorted.map((s, i) => {
                  const delta = s.prevScore != null ? s.calc.composite - s.prevScore : null;
                  const pxDelta = s.prevPrice != null && s.price != null ? (s.price - s.prevPrice) / s.prevPrice * 100 : null;
                  return (
                    <div key={s.ticker} onClick={() => openDesk(s.ticker)} className="hcard" style={{ display: "grid", gridTemplateColumns: "70px 1fr 65px 75px 60px 85px 85px 95px", gap: 8, padding: "10px 14px", fontSize: 13, alignItems: "center", borderBottom: i < sorted.length - 1 ? `1px solid ${COLORS.border}` : "none", cursor: "pointer" }} onMouseEnter={e => (e.currentTarget.style.background = COLORS.panelLight)} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                      <span style={{ fontWeight: 800 }}>{s.ticker}{s.held && s.entryPrice != null && <span style={{ color: COLORS.gold }} title="Open position"> ●</span>}</span>
                      <span style={{ color: COLORS.dim, fontSize: 12 }}>{s.name}</span>
                      <span style={{ fontWeight: 700, color: decColor(s.calc.decision) }}>{s.calc.composite.toFixed(1)}</span>
                      <Delta v={delta} />
                      <span style={{ width: 12, height: 12, borderRadius: "50%", background: sigColor(s.calc.sigLevel), boxShadow: glow(sigColor(s.calc.sigLevel), 10), display: "inline-block" }} />
                      <span style={{ fontSize: 12, color: s.calc.daysToCatalyst != null && s.calc.daysToCatalyst <= 7 ? COLORS.yellow : COLORS.dim }}>{s.calc.daysToCatalyst != null ? `${s.calc.daysToCatalyst}d` : "—"}</span>
                      <Delta v={pxDelta} suffix="%" />
                      <span style={{ fontSize: 11, fontWeight: 700, color: decColor(s.calc.decision) }}>{s.calc.decision === "DISQUALIFIED" ? "❌ DQ" : s.calc.decision === "GO" ? "✅ GO" : s.calc.decision === "WATCH" ? "👁 WATCH" : "❌ NO-GO"}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

        </div>
      )}

      {/* ══ POSITIONS ══ */}
      {room === "positions" && (() => {
        const pf = data.portfolio || null;
        const pfStocks = (pf?.positions || []).filter(p => (p.kind || "stock") === "stock");
        const totVal = (pf?.positions || []).reduce((a, p) => a + (p.marketValue || 0), 0);
        const totPL = (pf?.positions || []).reduce((a, p) => a + (p.unrealizedPL || 0), 0);
        const boardByTicker = Object.fromEntries(computed.map(s => [s.ticker, s]));
        // Reconciliation flags: broker reality vs board verdicts
        const flags = [];
        computed.forEach(s => {
          const call = s.claudeScan?.verdict?.call, hz = s.claudeScan?.verdict?.horizon;
          const inImport = pfStocks.some(p => (p.ticker || "").toUpperCase() === s.ticker);
          if (s.held && call === "EXIT") flags.push({ lvl: "RED", t: s.ticker, msg: "Verdict says EXIT — you're still holding" });
          else if (s.held && call === "TRIM") flags.push({ lvl: "YELLOW", t: s.ticker, msg: "Verdict says TRIM — position untouched" });
          else if (s.held && call === "RIDE_HYPE") flags.push({ lvl: "GOLD", t: s.ticker, msg: `Riding hype — exit discipline: ${hz || "no horizon set"}` });
          else if (s.held && call === "HOLD_TO_CATALYST") flags.push({ lvl: "INFO", t: s.ticker, msg: `Holding for the catalyst — ${s.calc.daysToCatalyst != null ? `${s.calc.daysToCatalyst}d out` : "no date"}${hz ? ` (${hz})` : ""}` });
          if (!s.held && call === "ADD") flags.push({ lvl: "GREEN", t: s.ticker, msg: "Verdict says ADD — you're not holding" });
          if (s.held && !s.claudeScan) flags.push({ lvl: "YELLOW", t: s.ticker, msg: "Held but never screened — no vetoes, no scores" });
          if (s.held && pf && !inImport) flags.push({ lvl: "YELLOW", t: s.ticker, msg: "Marked held here but absent from the last import — sold, or partial screenshot?" });
        });
        pfStocks.forEach(p => {
          const t = (p.ticker || "").toUpperCase();
          if (!boardByTicker[t]) flags.push({ lvl: "YELLOW", t, msg: `In your portfolio but not on the board — never screened${p.marketValue ? ` ($${Math.round(p.marketValue).toLocaleString()} exposure)` : ""}. Run a FULL SCAN.` });
        });
        const flagColor = { RED: COLORS.red, YELLOW: COLORS.yellow, GOLD: COLORS.gold, GREEN: COLORS.green, INFO: COLORS.blue };
        return (
          <div className="room" style={{ padding: "26px 28px 48px", maxWidth: 1080, margin: "0 auto" }}>
            <PageHeader title="Positions" sub={pf ? `Broker book vs the board · imported ${pf.date}` : "Broker book vs the board"}>
              <Btn icon={Upload} accent={COLORS.gold} onClick={() => { setBriefModal({ ticker: null, mode: "portfolio" }); setCopyMsg(""); }}>Portfolio brief</Btn>
              <Btn icon={ClipboardPaste} accent={COLORS.blue} onClick={() => { setSyncModal(true); setSyncError(""); }}>Paste portfolio</Btn>
            </PageHeader>

            {!pf && <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: 18, color: COLORS.dim, fontSize: 13, marginBottom: 14 }}>No portfolio imported yet. Hit <b>Portfolio brief</b>, paste it into Claude with a screenshot of your broker holdings, and paste the block back. The book reconciles itself and the flags below light up.</div>}

            {pf && (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
                {[["Market value", `$${Math.round(totVal).toLocaleString()}`, COLORS.text], ["Unrealized P&L", `${totPL >= 0 ? "+" : "-"}$${Math.round(Math.abs(totPL)).toLocaleString()}`, totPL >= 0 ? COLORS.green : COLORS.red], ["Holdings", pf.positions.length, COLORS.text], ...(pf.cash != null ? [["Cash", `$${Math.round(pf.cash).toLocaleString()}`, COLORS.text]] : [])].map(([lbl, val, col], i) => (
                  <div key={i} style={{ flex: "1 1 140px", background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: "10px 14px" }}>
                    <div style={{ fontSize: 10, color: COLORS.dim }}>{lbl}</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: col }}>{val}</div>
                  </div>
                ))}
              </div>
            )}

            {flags.length > 0 && (
              <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: 14, marginBottom: 14 }}>
                <Eyebrow style={{ marginBottom: 8 }}>Reconciliation — portfolio vs board</Eyebrow>
                {flags.map((f, i) => (
                  <div key={i} onClick={() => boardByTicker[f.t] && openDesk(f.t)} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "5px 0", fontSize: 12, lineHeight: 1.45, cursor: boardByTicker[f.t] ? "pointer" : "default" }}>
                    <span style={{ width: 10, height: 10, minWidth: 10, borderRadius: "50%", background: flagColor[f.lvl], boxShadow: glow(flagColor[f.lvl], 10), display: "inline-block", position: "relative", top: 1 }} />
                    <b style={{ minWidth: 52 }}>{f.t}</b>
                    <span style={{ color: COLORS.text }}>{f.msg}</span>
                  </div>
                ))}
              </div>
            )}

            {pf?.read && <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: "10px 14px", fontSize: 12, lineHeight: 1.55, marginBottom: 14 }}>🧭 <b>Claude's read:</b> {pf.read}</div>}

            {pf && (
              <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 14, overflow: "auto", marginBottom: 14 }}>
                <div style={{ minWidth: 780 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "80px 1fr 60px 70px 80px 100px 90px 70px 90px", gap: 8, padding: "8px 14px", fontSize: 10, color: COLORS.dim, fontWeight: 700, borderBottom: `1px solid ${COLORS.border}` }}>
                    <span>TICKER</span><span>NAME</span><span>KIND</span><span>QTY</span><span>AVG</span><span>MKT VALUE</span><span>UNRLZD P&L</span><span>SCORE</span><span>VERDICT</span>
                  </div>
                  {pf.positions.map((p, i) => {
                    const t = (p.ticker || "").toUpperCase(); const b = (p.kind || "stock") === "stock" ? boardByTicker[t] : null;
                    const call = b?.claudeScan?.verdict?.call;
                    return (
                      <div key={i} onClick={() => b && openDesk(t)} className="hcard" style={{ display: "grid", gridTemplateColumns: "80px 1fr 60px 70px 80px 100px 90px 70px 90px", gap: 8, padding: "10px 14px", fontSize: 12, alignItems: "center", borderBottom: i < pf.positions.length - 1 ? `1px solid ${COLORS.border}` : "none", cursor: b ? "pointer" : "default" }} onMouseEnter={e => b && (e.currentTarget.style.background = COLORS.panelLight)} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                        <span style={{ fontWeight: 800 }}>{t}</span>
                        <span style={{ color: COLORS.dim, fontSize: 11 }}>{p.label || p.name || ""}</span>
                        <span style={{ color: COLORS.dim, fontSize: 10, textTransform: "uppercase" }}>{p.kind || "stock"}</span>
                        <span>{p.qty ?? "—"}</span>
                        <span>{p.avgPrice != null ? `$${p.avgPrice}` : "—"}</span>
                        <span>{p.marketValue != null ? `$${Math.round(p.marketValue).toLocaleString()}` : "—"}</span>
                        <span style={{ fontWeight: 700, color: (p.unrealizedPL || 0) >= 0 ? COLORS.green : COLORS.red }}>{p.unrealizedPL != null ? `${p.unrealizedPL >= 0 ? "+" : "-"}$${Math.round(Math.abs(p.unrealizedPL)).toLocaleString()}` : "—"}</span>
                        <span style={{ fontWeight: 700, color: b ? decColor(b.calc.decision) : COLORS.dim }}>{b ? b.calc.composite.toFixed(1) : "—"}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, color: b && call ? (call === "ADD" ? COLORS.green : call === "EXIT" ? COLORS.red : call === "TRIM" ? COLORS.yellow : call === "RIDE_HYPE" ? COLORS.gold : COLORS.blue) : COLORS.dim }}>{b ? (call ? call.split("_").join(" ") : "unscanned") : "off-board"}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {(data.closed || []).length > 0 && (
              <div style={{ marginTop: 8 }}>
                <Eyebrow>Closed — booked results</Eyebrow>
                <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 14, overflow: "auto" }}>
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
        );
      })()}

      {/* ══ TRADING DESK ══ */}
      {room === "desk" && (
        <div className="room" style={{ padding: "26px 28px 48px", maxWidth: 1080, margin: "0 auto" }}>
          {!sel ? (
            <>
              <PageHeader title="Trading desk" sub="Positions and watchlist — tap a card to open the analysis">
                <Btn icon={ClipboardPaste} accent={COLORS.blue} title="Paste a full_scan JSON to add or refresh a stock" onClick={() => { setSyncModal(true); setSyncError(""); }}>Paste full scan</Btn>
              </PageHeader>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(310px, 1fr))", gap: 14 }}>
                {sorted.map(s => {
                  const delta = s.prevScore != null ? s.calc.composite - s.prevScore : null;
                  const pxE = s.held && s.entryPrice ? (s.price - s.entryPrice) / s.entryPrice * 100 : null;
                  return (
                    <div key={s.ticker} className="hcard" onClick={() => openDesk(s.ticker)} style={{ background: COLORS.panel, border: `1px solid ${s.calc.sigLevel === "RED" ? COLORS.red : COLORS.border}`, boxShadow: s.calc.sigLevel === "RED" ? glow(COLORS.red, 14) : "none", borderRadius: 18, padding: 16, cursor: "pointer" }}>
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
                <button onClick={() => setSelStock(null)} style={{ background: "transparent", color: COLORS.dim, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "5px 12px", cursor: "pointer", fontSize: 12 }}>← All positions</button>
                <span style={{ fontSize: 12, color: COLORS.dim }}>Tap any cluster bar to go deeper → evidence</span>
                <div style={{ flex: 1 }} />
                <button onClick={() => { setBriefModal({ ticker: sel.ticker, mode: "update" }); setCopyMsg(""); }} style={{ background: COLORS.panelLight, color: COLORS.gold, border: `1px solid ${COLORS.gold}`, borderRadius: 10, padding: "5px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>📤 Update brief</button>
                <button onClick={() => { setBriefModal({ ticker: sel.ticker, mode: "discuss" }); setCopyMsg(""); }} style={{ background: COLORS.panelLight, color: COLORS.green, border: `1px solid ${COLORS.green}`, borderRadius: 10, padding: "5px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>💬 Discuss brief</button>
                <button onClick={() => { setSyncModal(true); setSyncError(""); }} style={{ background: COLORS.panelLight, color: COLORS.blue, border: `1px solid ${COLORS.blue}`, borderRadius: 10, padding: "5px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>📥 Paste result</button>
              </div>

              <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 18, padding: 22, marginBottom: 14 }}>
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
                    {sel.lastFetch && <div style={{ marginTop: 6, fontSize: 11, color: COLORS.dim }}>Data as of {sel.lastFetch.date}{sel.lastFetch.currency ? ` · ${sel.lastFetch.currency}` : ""}{sel.lastFetch.missing?.length ? ` · missing: ${sel.lastFetch.missing.join(", ")}` : " · all fields"}{sel.lastFetch.notes ? ` · ${sel.lastFetch.notes}` : ""}</div>}
                  </div>
                  <div style={{ textAlign: "center", padding: "12px 22px", borderRadius: 16, background: COLORS.bg, border: `2px solid ${sigColor(sel.calc.sigLevel)}` }}>
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
                          {overridden ? <span style={{ marginLeft: "auto", fontSize: 11, color: COLORS.yellow }}>✓ overridden</span> : <button onClick={() => logOverride(sel.ticker, sig.text)} style={{ marginLeft: "auto", background: "transparent", color: COLORS.yellow, border: `1px solid ${COLORS.yellow}`, borderRadius: 9, padding: "2px 10px", cursor: "pointer", fontSize: 11 }}>Override</button>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* CLAUDE'S READ — verdict, bear case, veto detail from the last scan */}
              {sel.claudeScan && (() => {
                const cs = sel.claudeScan;
                const vc = cs.verdict?.call || "";
                const vCol = vc === "ADD" ? COLORS.green : vc === "EXIT" ? COLORS.red : vc === "TRIM" ? COLORS.yellow : vc === "RIDE_HYPE" ? COLORS.gold : COLORS.blue;
                const drift = cs.composite != null && Math.abs(cs.composite - sel.calc.composite) > 0.3;
                return (
                  <div style={{ background: COLORS.panel, border: `1px solid ${vc ? vCol : COLORS.border}`, borderRadius: 18, padding: 18, marginBottom: 14 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 800, fontSize: 14 }}>🧭 Claude's read</div>
                      <span style={{ fontSize: 11, color: COLORS.dim }}>scanned {cs.date}{cs.band ? ` · ${cs.band}` : ""}</span>
                      <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 800, color: vCol, padding: "4px 14px", borderRadius: 999, border: `1px solid ${vCol}`, background: `${vCol}18`, boxShadow: glow(vCol) }}>{vc ? vc.split("_").join(" ") : "no verdict"}</span>
                    </div>
                    {cs.verdict?.horizon && <div style={{ fontSize: 12, color: COLORS.gold, marginTop: 8 }}>⏳ {cs.verdict.horizon}</div>}
                    {cs.verdict?.rationale && <div style={{ fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>{cs.verdict.rationale}</div>}
                    {cs.summary && cs.kind !== "full_scan" && <div style={{ fontSize: 12, color: COLORS.text, marginTop: 8, lineHeight: 1.5, padding: "8px 10px", background: COLORS.bg, borderRadius: 10, border: `1px solid ${COLORS.border}` }}>📌 {cs.summary}</div>}
                    {cs.watchCheck?.length > 0 && (
                      <div style={{ marginTop: 10 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: COLORS.dim, letterSpacing: 1, marginBottom: 4 }}>WATCH ITEMS CHECKED</div>
                        {cs.watchCheck.map((w, wi) => (
                          <div key={wi} style={{ fontSize: 12, padding: "3px 0", lineHeight: 1.45, display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <span style={{ fontWeight: 700, minWidth: 58, color: w.status === "fired" ? COLORS.gold : w.status === "dead" ? COLORS.red : COLORS.dim, textTransform: "uppercase", fontSize: 10, paddingTop: 2 }}>{w.status}</span>
                            <span style={{ flex: 1 }}>{w.item}{w.note ? <span style={{ color: COLORS.dim }}> — {w.note}</span> : null}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {cs.bearCase && <div style={{ fontSize: 12, color: COLORS.red, marginTop: 8, lineHeight: 1.5 }}>🐻 {cs.bearCase}</div>}
                    {cs.vetoes?.tripped?.length > 0 && <div style={{ fontSize: 12, color: COLORS.red, marginTop: 8 }}>⛔ Veto tripped: {cs.vetoes.tripped.join(" · ")}</div>}
                    {cs.vetoes?.detail && <div style={{ fontSize: 11, color: COLORS.dim, marginTop: 6 }}>{cs.vetoes.detail}</div>}
                    {drift && <div style={{ fontSize: 11, color: COLORS.yellow, marginTop: 8 }}>⚠️ Board composite {sel.calc.composite.toFixed(1)} differs from the scan's {cs.composite.toFixed(1)} — that's your overrides, qual edits, or weight changes since the scan, not an error.</div>}
                  </div>
                );
              })()}

              {QUESTIONS.map(q => {
                const ks = Object.keys(CLUSTER_NAMES).filter(k => QUESTION_OF[k] === q);
                return (
                  <div key={q} style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 18, padding: "14px 18px", marginBottom: 10 }}>
                    <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>{q}</div>
                    {ks.map(k => {
                      const v = sel.calc.scores[k], prev = sel.prevScores?.[k];
                      const d = typeof v === "number" && typeof prev === "number" ? v - prev : null;
                      const hasOv = sel.calc.overrideScores[k] && sel.calc.overrideScores[k].value != null;
                      return (
                        <div key={k} onClick={() => setSelCluster(k)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 6px", borderRadius: 10, fontSize: 13, cursor: "pointer" }} onMouseEnter={e => (e.currentTarget.style.background = COLORS.panelLight)} onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
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
              <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 18, padding: 18, marginTop: 4 }}>
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
                        style={{ flex: 1, minWidth: 80, background: disabled ? COLORS.bg : a === "Exit" ? COLORS.red : a === "Add" ? COLORS.green : COLORS.panelLight, color: disabled ? COLORS.dim : a === "Hold" || a === "Trim" ? COLORS.text : "#fff", border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: "10px 0", cursor: disabled ? "not-allowed" : "pointer", fontWeight: 700, fontSize: 14, opacity: disabled ? 0.5 : 1 }}>{a}</button>
                    );
                  })}
                </div>
                <div style={{ fontSize: 11, color: COLORS.dim, marginTop: 8 }}>Add opens/increases a position (you mirror it on IBKR). Exit closes it and books the result to Positions → Closed.</div>
              </div>

              {/* NOTEBOOK */}
              <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 18, padding: 18, marginTop: 14 }}>
                <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 10 }}>📓 Position notebook</div>
                <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                  <input id="newNote" placeholder="Add a note…" style={{ ...inp, marginTop: 0 }} onKeyDown={e => { if (e.key === "Enter") { addNote(sel.ticker, e.target.value); e.target.value = ""; } }} />
                  <button onClick={() => { const el = document.getElementById("newNote"); addNote(sel.ticker, el.value); el.value = ""; }} style={{ background: COLORS.gold, color: "#1B2A4A", border: "none", borderRadius: 10, padding: "0 16px", cursor: "pointer", fontWeight: 700 }}>Add</button>
                </div>
                {(sel.notebook || []).length === 0 ? <div style={{ fontSize: 12, color: COLORS.dim, fontStyle: "italic" }}>No notes yet.</div> : (sel.notebook || []).map((n, i) => (
                  <div key={i} style={{ fontSize: 12, padding: "6px 0", borderBottom: i < sel.notebook.length - 1 ? `1px solid ${COLORS.border}` : "none" }}><span style={{ color: COLORS.dim }}>{n.date}</span> — {n.text}</div>
                ))}
              </div>

              {/* HISTORY TIMELINE */}
              <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 18, padding: 18, marginTop: 14 }}>
                <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ fontWeight: 800, fontSize: 14 }}>🕓 Weekly history</div>
                  <span style={{ fontSize: 11, color: COLORS.dim, marginLeft: 10 }}>frozen each snapshot — tap a week to see its full state</span>
                </div>
                {(data.snapshots?.[sel.ticker] || []).length === 0 ? <div style={{ fontSize: 12, color: COLORS.dim, fontStyle: "italic" }}>No snapshots yet. One gets frozen automatically every time you paste an update scan.</div> : (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {(data.snapshots[sel.ticker] || []).slice().reverse().map((snap, i) => (
                      <button key={i} onClick={() => setHistDate(snap.date)} style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: "8px 12px", cursor: "pointer", textAlign: "left", color: COLORS.text }}>
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
                <button onClick={() => deleteStock(sel.ticker)} style={{ background: "transparent", color: COLORS.red, border: `1px solid ${COLORS.red}`, borderRadius: 10, padding: "6px 14px", cursor: "pointer", fontSize: 12 }}>🗑 Delete {sel.ticker} + all history</button>
                {(data.snapshots?.[sel.ticker] || []).length > 2 && (
                  <button onClick={() => { const d = prompt("Prune snapshots before date (YYYY-MM-DD):"); if (d) pruneSnapshots(sel.ticker, d); }} style={{ background: "transparent", color: COLORS.dim, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "6px 14px", cursor: "pointer", fontSize: 12 }}>Prune old snapshots</button>
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
                    <button onClick={() => setHistDate(null)} style={{ background: "transparent", color: COLORS.dim, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "5px 12px", cursor: "pointer", fontSize: 12 }}>← {sel.ticker} current</button>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>{sel.ticker} — frozen state on {snap.date}</span>
                  </div>
                  <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.blue}`, borderRadius: 18, padding: 20 }}>
                    <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
                      <ScoreRing score={snap.composite} size={72} decision={snap.decision} />
                      <div>
                        <div style={{ fontSize: 18, fontWeight: 800 }}>{snap.composite?.toFixed?.(1)} · {snap.decision}</div>
                        <div style={{ fontSize: 12, color: COLORS.dim }}>price ${snap.price} · signal {snap.sigLevel}{snap.held ? ` · held @ $${snap.entryPrice}` : ""}</div>
                        {snap.catalystDate && <div style={{ fontSize: 12, color: COLORS.dim }}>catalyst: {snap.catalystType} on {snap.catalystDate} ({snap.daysToCatalyst}d out then)</div>}
                        {snap.knockouts?.length > 0 && <div style={{ fontSize: 12, color: COLORS.red }}>⛔ {snap.knockouts.join(", ")}</div>}
                      </div>
                    </div>
                    {snap.summary && <div style={{ fontSize: 12, marginBottom: 12, padding: "8px 10px", background: COLORS.bg, borderRadius: 10, border: `1px solid ${COLORS.border}`, lineHeight: 1.5 }}>📌 {snap.summary}</div>}
                    {snap.fields && (
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                        {[["Price", snap.fields.price, "$"], ["Mkt Cap", snap.fields.mktCap, "$", "M"], ["Debt", snap.fields.debt, "$", "M"], ["Cash", snap.fields.cash, "$", "M"], ["Burn/qtr", snap.fields.burnQ, "$", "M"], ["Volume", snap.fields.volume, "", ""], ["Insider net", snap.fields.insiderNet, "", " sh"]].map(([lbl, val, pre, suf], fi) => (
                          <div key={fi} style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "6px 10px" }}>
                            <div style={{ fontSize: 9, color: COLORS.dim }}>{lbl}</div>
                            <div style={{ fontSize: 13, fontWeight: 700 }}>{val != null ? `${pre}${typeof val === "number" ? val.toLocaleString() : val}${suf || ""}` : "—"}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
                      {Object.keys(CLUSTER_NAMES).map(k => {
                        const v = snap.scores?.[k], cur = sel.calc.scores[k];
                        const d = typeof v === "number" && typeof cur === "number" ? cur - v : null;
                        return (
                          <div key={k} style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 10 }}>
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
              const k = selCluster, t = sel.calc.trace[k] || {}, v = sel.calc.scores[k];
              return (
                <>
                  <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
                    <button onClick={() => setSelCluster(null)} style={{ background: "transparent", color: COLORS.dim, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "5px 12px", cursor: "pointer", fontSize: 12 }}>← {sel.ticker} analysis</button>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>{sel.ticker} · {k} — {CLUSTER_NAMES[k]} · Evidence Room</span>
                  </div>
                  <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.gold}`, borderRadius: 18, padding: 20 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4, flexWrap: "wrap" }}>
                      <div style={{ fontSize: 28, fontWeight: 800, color: scoreColor(v) }}>{typeof v === "number" ? v.toFixed(1) : v == null ? "unscored" : "KNOCKOUT"}</div>
                      <div style={{ fontSize: 12, color: COLORS.dim }}>weight ×{(rules.weights[k] * 100).toFixed(0)}% → contributes <b style={{ color: COLORS.text }}>{typeof v === "number" ? (v * rules.weights[k]).toFixed(2) : "0"}</b> to composite {sel.calc.composite.toFixed(1)}</div>
                      <div style={{ marginLeft: "auto", fontSize: 11, color: COLORS.dim }}>Source: {CLUSTER_SOURCES[k]}</div>
                    </div>
                    {sel.calc.overrideScores[k] && sel.calc.overrideScores[k].value != null && (
                      <div style={{ fontSize: 12, color: COLORS.yellow, marginBottom: 8, padding: "6px 10px", background: "rgba(224,181,84,0.1)", borderRadius: 10 }}>
                        ✏️ Your override: system computed <b>{typeof sel.calc.computedScores[k] === "number" ? sel.calc.computedScores[k].toFixed(1) : sel.calc.computedScores[k]}</b>, you set <b>{sel.calc.overrideScores[k].value}</b> — {sel.calc.overrideScores[k].reason}
                        <button onClick={() => setClusterOverride(sel.ticker, k, null)} style={{ marginLeft: 10, background: "transparent", color: COLORS.dim, border: `1px solid ${COLORS.border}`, borderRadius: 5, padding: "1px 8px", cursor: "pointer", fontSize: 11 }}>clear</button>
                      </div>
                    )}
                    {sel.prevScores?.[k] != null && typeof v === "number" && <div style={{ fontSize: 12, color: COLORS.dim, marginBottom: 12 }}>Last week: {sel.prevScores[k].toFixed(1)} → this week: {v.toFixed(1)} <Delta v={v - sel.prevScores[k]} /></div>}

                    {/* CLAUDE'S DOSSIER — facts, reasoning, watch items from the last scan */}
                    {sel.claudeScan?.clusters?.[k] && (() => {
                      const cd = sel.claudeScan.clusters[k];
                      if (!cd.facts.length && !cd.reasoning && !cd.watch.length) return null;
                      return (
                        <div style={{ marginBottom: 14, background: COLORS.bg, border: `1px solid ${COLORS.blue}`, borderRadius: 14, padding: 14 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
                            <span style={{ fontWeight: 800, fontSize: 12, color: COLORS.blue }}>🧭 CLAUDE'S DOSSIER</span>
                            <span style={{ fontSize: 11, color: COLORS.dim }}>scanned {sel.claudeScan.date}</span>
                            {cd.score != null && <span style={{ marginLeft: "auto", fontSize: 12, color: COLORS.dim }}>Claude scored <b style={{ color: scoreColor(cd.score) }}>{cd.score.toFixed(1)}</b></span>}
                          </div>
                          {cd.changed && <div style={{ fontSize: 12, color: COLORS.yellow, marginBottom: 8, padding: "6px 10px", background: "rgba(224,181,84,0.08)", borderRadius: 10 }}>Δ Moved in the last update{cd.changeNote ? `: ${cd.changeNote}` : ""}</div>}
                          {cd.facts.length > 0 && (
                            <div style={{ marginBottom: cd.reasoning || cd.watch.length ? 10 : 0 }}>
                              <div style={{ fontSize: 10, fontWeight: 700, color: COLORS.dim, letterSpacing: 1, marginBottom: 4 }}>FACTS</div>
                              {cd.facts.map((f, fi) => <div key={fi} style={{ fontSize: 12, padding: "3px 0", lineHeight: 1.45 }}>• {f}</div>)}
                            </div>
                          )}
                          {cd.reasoning && (
                            <div style={{ marginBottom: cd.watch.length ? 10 : 0 }}>
                              <div style={{ fontSize: 10, fontWeight: 700, color: COLORS.dim, letterSpacing: 1, marginBottom: 4 }}>REASONING</div>
                              <div style={{ fontSize: 12, lineHeight: 1.5 }}>{cd.reasoning}</div>
                            </div>
                          )}
                          {cd.watch.length > 0 && (
                            <div>
                              <div style={{ fontSize: 10, fontWeight: 700, color: COLORS.dim, letterSpacing: 1, marginBottom: 4 }}>WATCH ITEMS</div>
                              {cd.watch.map((w, wi) => <div key={wi} style={{ fontSize: 12, color: COLORS.gold, padding: "3px 0", lineHeight: 1.45 }}>👁 {w}</div>)}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {["G", "H", "I"].includes(k) ? (
                      <div style={{ display: "grid", gap: 10 }}>
                        {t.components.map((c, i) => {
                          const isEd = editComp && editComp.cluster === k && editComp.idx === i;
                          return (
                            <div key={i} style={{ background: COLORS.bg, border: `1px solid ${isEd ? COLORS.gold : COLORS.border}`, borderRadius: 14, padding: 12 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                <span style={{ fontWeight: 700, fontSize: 13, minWidth: 120 }}>{c.name}</span>
                                <span style={{ fontSize: 12, fontWeight: 700, padding: "2px 10px", borderRadius: 20, background: c.input === "High" ? "rgba(61,204,126,0.15)" : c.input === "Medium" ? "rgba(224,181,84,0.15)" : c.input === "Low" ? "rgba(232,92,92,0.15)" : COLORS.panel, color: c.input === "High" ? COLORS.green : c.input === "Medium" ? COLORS.yellow : c.input === "Low" ? COLORS.red : COLORS.dim }}>{c.input}</span>
                                <span style={{ fontSize: 11, color: COLORS.dim }}>{c.score !== "—" ? `→ ${c.score}` : "unscored"}</span>
                                <button onClick={() => setEditComp(isEd ? null : { cluster: k, idx: i })} style={{ marginLeft: "auto", background: "transparent", color: COLORS.gold, border: `1px solid ${COLORS.gold}`, borderRadius: 9, padding: "2px 10px", cursor: "pointer", fontSize: 11 }}>{isEd ? "close" : "edit"}</button>
                              </div>
                              {c.rationale ? <div style={{ fontSize: 12, color: COLORS.text, marginTop: 8, lineHeight: 1.5 }}>{c.rationale}</div> : <div style={{ fontSize: 12, color: COLORS.dim, marginTop: 8, fontStyle: "italic" }}>No reasoning yet — use "Discuss with Claude" to draft one, or edit directly.</div>}
                              {c.sources?.length > 0 && <div style={{ fontSize: 11, color: COLORS.blue, marginTop: 6 }}>📎 {c.sources.join(" · ")}</div>}
                              {isEd && (
                                <div style={{ marginTop: 10, borderTop: `1px solid ${COLORS.border}`, paddingTop: 10, display: "grid", gap: 8 }}>
                                  <div style={{ display: "flex", gap: 6 }}>
                                    {[1, 2, 3].map(sv => (
                                      <button key={sv} onClick={() => setQualComponent(sel.ticker, k, i, sv, undefined, undefined)} style={{ flex: 1, background: c.input === ["", "Low", "Medium", "High"][sv] ? COLORS.gold : COLORS.panel, color: c.input === ["", "Low", "Medium", "High"][sv] ? "#1B2A4A" : COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 9, padding: "6px 0", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{["", "Low", "Medium", "High"][sv]}</button>
                                    ))}
                                  </div>
                                  <textarea defaultValue={c.rationale} placeholder="Your reasoning…" id={`rat-${k}-${i}`} style={{ ...inp, height: 60, fontSize: 12 }} />
                                  <input defaultValue={(c.sources || []).join(", ")} placeholder="Sources (comma-separated)" id={`src-${k}-${i}`} style={{ ...inp, color: COLORS.blue, fontSize: 12 }} />
                                  <button onClick={() => setQualComponent(sel.ticker, k, i, null, document.getElementById(`rat-${k}-${i}`).value, document.getElementById(`src-${k}-${i}`).value)} style={{ background: COLORS.gold, color: "#1B2A4A", border: "none", borderRadius: 9, padding: "7px 0", cursor: "pointer", fontWeight: 700, fontSize: 12 }}>Save reasoning & sources</button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      !sel.claudeScan?.clusters?.[k] && (
                        <div style={{ fontSize: 12, color: COLORS.dim, fontStyle: "italic", padding: "10px 0" }}>
                          No dossier for this cluster yet. Scores come from the skill — run a FULL SCAN on {sel.ticker} and paste the block, or set your own override below.
                        </div>
                      )
                    )}

                    {t.note && <div style={{ marginTop: 10, fontSize: 12, color: COLORS.dim, fontStyle: "italic" }}>📝 Summary note: {t.note}</div>}
                    {t.lastEarnings && <div style={{ marginTop: 4, fontSize: 11, color: COLORS.dim }}>Last earnings call analyzed: {t.lastEarnings}</div>}
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
                      <div style={{ marginTop: 12, padding: 12, background: "rgba(232,92,92,0.1)", border: `1px solid ${COLORS.red}`, borderRadius: 14 }}>
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
                          <button onClick={() => setClusterOverride(sel.ticker, k, document.getElementById(`ov-${k}`).value, document.getElementById(`ovr-${k}`).value)} style={{ background: COLORS.gold, color: "#1B2A4A", border: "none", borderRadius: 9, padding: "6px 14px", cursor: "pointer", fontWeight: 700, fontSize: 12 }}>Save</button>
                          <button onClick={() => setClusterOvEdit(null)} style={{ background: "transparent", color: COLORS.dim, border: `1px solid ${COLORS.border}`, borderRadius: 9, padding: "6px 12px", cursor: "pointer", fontSize: 12 }}>Cancel</button>
                        </div>
                      ) : <button onClick={() => setClusterOvEdit(k)} style={{ background: "transparent", color: COLORS.yellow, border: `1px solid ${COLORS.yellow}`, borderRadius: 9, padding: "5px 14px", cursor: "pointer", fontSize: 12 }}>✏️ Override {k} cluster score</button>}
                    </div>
                  </div>

                  <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 18, padding: 18, marginTop: 14 }}>
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

      {/* ══ CONFIG ══ */}
      {room === "config" && (
        <div className="room" style={{ padding: "26px 28px 48px", maxWidth: 720, margin: "0 auto" }}>
          <PageHeader title="Config" sub="Rules, calibration, and data safety" />

          <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 18, padding: 18, marginBottom: 14 }}>
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 6 }}>☁️ Cloud sync</div>
            <div style={{ fontSize: 12, color: COLORS.dim, marginBottom: 12, lineHeight: 1.55 }}>One sync key, same data on every device — no more export/import between browsers. Set the same key you configured as SYNC_KEY in Vercel. Clear the field to go local-only. Status: <b style={{ color: syncStatus === "synced" ? COLORS.green : syncStatus === "error" || syncStatus === "badkey" ? COLORS.red : COLORS.text }}>{syncStatus === "off" ? "sync off" : syncStatus === "badkey" ? "wrong key (server rejected it)" : syncStatus}</b></div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input type="password" placeholder="Sync key" defaultValue={syncKey} id="syncKeyInput" style={{ ...inp, marginTop: 0, maxWidth: 280, padding: 9 }} />
              <button onClick={() => { setSyncKey(document.getElementById("syncKeyInput").value); setTimeout(() => window.location.reload(), 150); }} style={{ background: COLORS.blue, color: "#0F1424", border: "none", borderRadius: 10, padding: "9px 18px", cursor: "pointer", fontWeight: 700, fontSize: 13 }}>Save & reconnect</button>
            </div>
            <div style={{ fontSize: 11, color: COLORS.dim, marginTop: 10 }}>The key is stored only in this browser. Data syncs to your project's Vercel Blob store; the newest save wins across devices.</div>
          </div>

          <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 18, padding: 18, marginBottom: 14 }}>
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 6 }}>💾 Backup & restore</div>
            <div style={{ fontSize: 12, color: COLORS.dim, marginBottom: 12, lineHeight: 1.55 }}>Everything lives in this browser's local storage, and Safari purges local storage without asking. Export a backup after every scan session and keep it in Files or iCloud. Import replaces everything, so it asks first.</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={exportAll} style={{ background: COLORS.gold, color: "#1B2A4A", border: "none", borderRadius: 10, padding: "9px 18px", cursor: "pointer", fontWeight: 700, fontSize: 13 }}>⬇ Export backup</button>
              <button onClick={() => document.getElementById("importFileInput")?.click()} style={{ background: "transparent", color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "9px 18px", cursor: "pointer", fontWeight: 600, fontSize: 13 }}>⬆ Import backup</button>
              <input id="importFileInput" type="file" accept=".json,application/json" style={{ display: "none" }} onChange={e => { importAll(e.target.files && e.target.files[0]); e.target.value = ""; }} />
            </div>
            <div style={{ fontSize: 11, color: COLORS.dim, marginTop: 10 }}>{data.stocks.length} stocks · {Object.values(data.snapshots || {}).reduce((a, v) => a + v.length, 0)} snapshots on board right now</div>
          </div>

          <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 18, padding: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
              <div style={{ fontWeight: 800, fontSize: 14 }}>⚖️ Rules — weights, bands, vetoes</div>
              <button onClick={resetRules} style={{ marginLeft: "auto", background: "transparent", color: COLORS.dim, border: `1px solid ${COLORS.border}`, borderRadius: 9, padding: "3px 12px", cursor: "pointer", fontSize: 11 }}>↩ Reset to defaults</button>
            </div>
            <div style={{ fontSize: 12, color: COLORS.dim, marginBottom: 12, lineHeight: 1.55 }}>Edits apply to the board instantly and ride into every brief as CONFIG, which beats the skill's own defaults — no skill re-upload needed. The deep rubric (tier tables, PICPOT anchors) lives in the skill itself; changing that is a deliberate SKILL.md edit, not a dial here.</div>

            {(() => { const wSum = Object.values(rules.weights).reduce((a, w) => a + w, 0) * 100; return (
              <div style={{ fontSize: 11, color: Math.abs(wSum - 100) > 0.5 ? COLORS.yellow : COLORS.dim, marginBottom: 8 }}>CLUSTER WEIGHTS — sum {wSum.toFixed(0)}%{Math.abs(wSum - 100) > 0.5 ? " (≠100% — composite still normalizes, but check your intent)" : ""}</div>
            ); })()}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
              {Object.entries(rules.weights).map(([k, w]) => (
                <div key={k} style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "6px 10px", width: 118 }}>
                  <div style={{ fontSize: 9, color: COLORS.dim }}>{k} — {CLUSTER_NAMES[k]}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <input type="number" min="0" max="100" step="1" defaultValue={(w * 100).toFixed(0)} key={`w-${k}-${(w * 100).toFixed(0)}`} onBlur={e => { if (e.target.value !== (w * 100).toFixed(0)) setWeight(k, e.target.value); }} onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }} style={{ ...inp, marginTop: 0, padding: "3px 6px", fontSize: 13, fontWeight: 700, width: 58 }} />
                    <span style={{ fontSize: 12, color: COLORS.dim }}>%</span>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ fontSize: 11, color: COLORS.dim, marginBottom: 8 }}>DECISION BANDS & VETO THRESHOLDS</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[["goThreshold", "GO ≥ (composite)", 0.1], ["watchThreshold", "WATCH ≥ (composite)", 0.1], ["mktCapFloor", "Mkt cap floor ($M)", 10], ["volHardVeto", "Min daily volume (sh)", 10000], ["runwayVeto", "Runway veto (< years)", 0.1], ["runwayMin", "Runway warning (< years)", 0.5], ["minAnalysts", "Min analysts", 1], ["catalystWindow", "Catalyst window (days)", 1]].map(([key, label, step]) => (
                <div key={key} style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: "6px 10px", width: 150 }}>
                  <div style={{ fontSize: 9, color: COLORS.dim }}>{label}</div>
                  <input type="number" step={step} defaultValue={rules[key]} key={`r-${key}-${rules[key]}`} onBlur={e => { if (e.target.value !== String(rules[key])) setRule(key, e.target.value); }} onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }} style={{ ...inp, marginTop: 2, padding: "3px 6px", fontSize: 13, fontWeight: 700 }} />
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, color: COLORS.dim, marginTop: 10 }}>Bands live: GO ≥ {rules.goThreshold} · WATCH ≥ {rules.watchThreshold} · below = NO-GO · any veto = DISQUALIFIED. Veto checks themselves run in the skill — these thresholds ship in the brief so the skill applies your numbers, not its defaults.</div>
          </div>
        </div>
      )}
      </div>
      </div>
    </div>
  );
}
