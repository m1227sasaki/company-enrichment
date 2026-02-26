import { useState, useRef, useCallback } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const CONCURRENCY = 1;
const STEP_DELAY = 1000;       // 1s between steps
const ROUND_DELAY = 1500;      // 1.5s between Round 1 and Round 2
const COMPANY_DELAY = 2000;    // 2s between companies

const VALID_TLDS = new Set([
  "com","net","org","edu","gov","mil","int","biz","info","pro","mobi",
  "io","co","ai","app","dev","tech","digital","media","agency","studio","online","site",
  "web","blog","shop","store","cloud","solutions","services","group","global","world",
  "bio","health","care","life","live","news","press","today","now","new","one","plus",
  "hub","lab","labs","works","network","systems","consulting","ventures","capital",
  "finance","bank","insurance","legal","law","tax","energy","solar","green",
  "design","build","construction","real","estate","property","homes","travel",
  "events","music","film","tv","radio","games","play","fun","social",
  "foundation","charity","ngo","museum","church","school","university","academy",
  "uk","us","eu","au","ca","de","fr","es","it","nl","be","ch","at","se","no","dk","fi",
  "pl","cz","sk","hu","ro","bg","hr","si","rs","gr","cy","mt","lu","is","ie","pt",
  "ru","ua","tr","il","sa","ae","qa","kw","bh","eg","ma","tn","ke","ng","za",
  "in","pk","lk","cn","jp","kr","tw","hk","sg","my","th","vn","ph","id",
  "nz","br","ar","cl","pe","ve","ec","mx","gt","cr","pa","cu","do","pr","uy","py","bo",
]);

const BLOCKED_DOMAINS = [
  "linkedin.com","facebook.com","twitter.com","x.com","instagram.com","youtube.com",
  "wikipedia.org","bloomberg.com","crunchbase.com","google.com","bing.com","yahoo.com",
  "glassdoor.com","indeed.com","zoominfo.com","dnb.com","hoovers.com","manta.com",
  "yelp.com","apple.com","amazon.com","reuters.com","forbes.com","ft.com","wsj.com",
  "techcrunch.com","pitchbook.com","owler.com","craft.co","similarsites.com",
  "angel.co","angellist.com","producthunt.com","g2.com","capterra.com","trustpilot.com",
  "bbb.org","yellowpages.com","whitepages.com","businesswire.com","prnewswire.com",
  "sec.gov","companieshouse.gov.uk","opencorporates.com","bizapedia.com",
  "rocketreach.com","apollo.io","signalhire.com","corporationwiki.com",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function isBlocked(url) {
  return BLOCKED_DOMAINS.some(d => url.toLowerCase().includes(d));
}

function isValidTLD(hostname) {
  const parts = hostname.toLowerCase().split(".");
  if (parts.length < 2) return false;
  const tld1 = parts[parts.length - 1];
  const tld2 = parts.slice(-2).join(".");
  return VALID_TLDS.has(tld1) || VALID_TLDS.has(tld2);
}

function extractURL(text) {
  if (!text) return null;
  const urlRegex = /https?:\/\/[^\s\)\]\,\"\'<>\n]+/g;
  for (let raw of (text.match(urlRegex) || [])) {
    raw = raw.replace(/[.,;!?:)\]>]+$/, "");
    if (isBlocked(raw)) continue;
    try {
      const u = new URL(raw);
      if (isValidTLD(u.hostname)) return u.origin;
    } catch { continue; }
  }
  // Bare domain fallback
  const bareRegex = /\b(?:www\.)?([a-zA-Z0-9][a-zA-Z0-9\-]{0,61}(?:\.[a-zA-Z0-9\-]+)+)\b/g;
  for (let raw of (text.match(bareRegex) || [])) {
    if (isBlocked(raw)) continue;
    const full = `https://${raw}`;
    try {
      const u = new URL(full);
      if (isValidTLD(u.hostname)) return u.origin;
    } catch { continue; }
  }
  return null;
}

function nameSimilarity(companyName, domainFull) {
  const stopWords = new Set(["inc","llc","ltd","co","corp","group","media","solutions",
    "services","digital","global","international","the","and","of","for","a","an",
    "company","technologies","technology","consulting","partners","associates","worldwide"]);
  const domainName = domainFull
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/\/.*$/, "")
    .replace(/\.[a-z]{2,10}(\.[a-z]{2})?$/, "")
    .replace(/[^a-z0-9]/g, "");
  const tldMatch = domainFull.match(/\.([a-z]{2,10})(?:\.[a-z]{2})?(?:\/|$)/i);
  const tldWord = tldMatch ? tldMatch[1].toLowerCase() : "";
  const fullDomain = domainName + tldWord;
  const nameWords = companyName.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ").trim()
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
  if (nameWords.length === 0) return 0.5;
  let score = 0;
  for (const word of nameWords) {
    if (fullDomain.includes(word)) { score += 1; continue; }
    if (word.startsWith(domainName.slice(0, 5)) && domainName.length >= 4) { score += 0.8; continue; }
    if (tldWord && (word.startsWith(tldWord) || tldWord.startsWith(word.slice(0, 3)))) { score += 0.7; continue; }
    if (word.length >= 4 && fullDomain.includes(word.slice(0, 4))) { score += 0.4; }
  }
  return Math.min(score / nameWords.length, 1.0);
}

function extractLocationHint(name) {
  const patterns = [
    { re: /\b(s\.a\.p\.a\.|s\.r\.l\.|s\.p\.a\.|snc|sas)\b/i, country: "Italy" },
    { re: /\b(gmbh|ag\b|kg\b|ohg)\b/i, country: "Germany" },
    { re: /\b(sarl|sas\b|s\.a\.s\.)\b/i, country: "France" },
    { re: /\b(bv\b|nv\b)\b/i, country: "Netherlands" },
    { re: /\b(pty ltd|pty\. ltd)\b/i, country: "Australia" },
    { re: /\b(plc\b|llp\b)\b/i, country: "United Kingdom" },
    { re: /\b(a\/s|aps\b)\b/i, country: "Denmark" },
    { re: /\b(ab\b|aktiebolag)\b/i, country: "Sweden" },
    { re: /\b(sp\. z o\.o\.)\b/i, country: "Poland" },
    { re: /\b(ltda|s\.a\.)\b/i, country: "Latin America" },
  ];
  for (const { re, country } of patterns) {
    if (re.test(name)) return country;
  }
  return null;
}

function getDomainFromURL(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return null; }
}

// Check if company name itself IS a domain (e.g. "BidForMaterials.com", "Pawtas.com")
function extractDomainFromName(name) {
  // Match pattern like "Something.com" or "something.io" etc
  const match = name.match(/^([a-zA-Z0-9][a-zA-Z0-9\-\.]+\.(com|net|org|io|co|biz|app|ai|tech|media|digital|studio|agency))$/i);
  if (match) return `https://www.${name.toLowerCase()}`;
  // Match if name ENDS with a domain extension
  const endMatch = name.match(/([a-zA-Z0-9\-]+\.(com|net|org|io|co\.uk|co|biz|app|ai|cr|br|mx|de|fr|es|it|au))$/i);
  if (endMatch) return `https://www.${endMatch[1].toLowerCase()}`;
  return null;
}

// ─── API call with 429 handling: skip step on rate limit, don't retry ─────────
async function callWithSearch(prompt) {
  const tools = [{ type: "web_search_20250305", name: "web_search" }];

  // Round 1
  const res1 = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      tools,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  // On 429, throw a specific error so the step skips cleanly
  if (!res1.ok) throw new Error(`API_${res1.status}`);
  const data1 = await res1.json();

  const text1 = data1.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  const usedSearch = data1.content.some(b => b.type === "tool_use" && b.name === "web_search");
  if (!usedSearch) return text1;

  await delay(ROUND_DELAY);

  // Round 2
  const res2 = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      tools,
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: data1.content },
      ],
    }),
  });
  if (!res2.ok) throw new Error(`API_${res2.status}`);
  const data2 = await res2.json();

  const text2 = data2.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  return text1 + "\n" + text2;
}

// ─── Single search step ───────────────────────────────────────────────────────
async function searchStep(searchQuery, companyName, empHint, locationHint, extraInstruction = "") {
  const locationLine = locationHint ? `\nThis company appears to be based in ${locationHint}.` : "";
  const prompt = `You are a research expert finding official company websites.

Company: "${companyName}"${empHint}${locationLine}

Search for: ${searchQuery}

After searching, examine each result and check:
1. Does the page TITLE or HEADING match the company name?
2. Does the DOMAIN NAME relate to the company name (even if abbreviated)?
3. Does the DESCRIPTION match this company?
4. Is this an official homepage (not a directory, news article, or social media)?

Pick the BEST MATCH using judgment — not just exact name matches. Examples:
- "Digital Biology Inc" → digit.bio ✓ (domain abbreviates name, .bio = biology)
- "EZ Media Group" → ezmediagroup.com ✓
- "Publimark Mullenlowe" → publimark.cr ✓ (.cr = Costa Rica)

${extraInstruction}

Return ONLY the URL (e.g. https://www.example.com) or NOTFOUND if nothing matches.`;

  const text = await callWithSearch(prompt);
  if (!text || text.includes("NOTFOUND")) return null;
  return extractURL(text);
}

// ─── Main enrichment — 30s budget per company ────────────────────────────────
async function enrichCompany(company, onStepUpdate) {
  const name = company.name;
  const empHint = company.employees ? ` (${company.employees} employees)` : "";
  const locationHint = extractLocationHint(name);
  const results = [];

  // ── INSTANT: If company name IS a domain, return immediately ──
  const nameDomain = extractDomainFromName(name);
  if (nameDomain) {
    return { url: nameDomain, step: "Instant (name is domain)" };
  }

  // ── STEP 1: Google official website ──
  onStepUpdate("🔍 Step 1/6: Google official website...");
  try {
    const url = await searchStep(`${name} official website`, name, empHint, locationHint);
    if (url) {
      results.push({ url, step: "Step 1" });
      // High similarity = early exit
      if (nameSimilarity(name, url) >= 0.8) {
        return { url, step: "Step 1 ✓ (high confidence)" };
      }
    }
  } catch (e) {
    console.error("Step 1:", e.message);
  }
  await delay(STEP_DELAY);

  // ── STEP 2: Google company name ──
  onStepUpdate("🔍 Step 2/6: Google company name...");
  try {
    const url = await searchStep(`"${name}" company`, name, empHint, locationHint);
    if (url) results.push({ url, step: "Step 2" });
  } catch (e) {
    console.error("Step 2:", e.message);
  }
  await delay(STEP_DELAY);

  // ── STEP 3: LinkedIn ──
  onStepUpdate("🔗 Step 3/6: LinkedIn company page...");
  try {
    const url = await searchStep(
      `${name} site:linkedin.com/company`,
      name, empHint, locationHint,
      `If you find a LinkedIn page, look for the "Website" field and return that URL — NOT the LinkedIn URL.`
    );
    if (url) results.push({ url, step: "Step 3 (LinkedIn)" });
  } catch (e) {
    console.error("Step 3:", e.message);
  }

  // ── Cross-validate after Step 3 ──
  const earlyDomains = results.map(r => getDomainFromURL(r.url)).filter(Boolean);
  const earlyCounts = earlyDomains.reduce((a, d) => { a[d] = (a[d] || 0) + 1; return a; }, {});
  const earlyBest = Object.entries(earlyCounts).sort((a, b) => b[1] - a[1])[0];
  if (earlyBest && earlyBest[1] >= 2) {
    const match = results.find(r => getDomainFromURL(r.url) === earlyBest[0]);
    return { url: match.url, step: `${match.step} ✓✓ (cross-validated)` };
  }
  await delay(STEP_DELAY);

  // ── STEP 4: Domain hint in name ──
  onStepUpdate("🌐 Step 4/6: Domain name hint...");
  const domainMatch = name.match(/([a-zA-Z0-9\-]+\.(com|net|org|co\.uk|io|biz|au|co|cr|br|mx|de|fr|es|it|nl))\b/i);
  if (domainMatch) {
    return { url: `https://www.${domainMatch[1].toLowerCase()}`, step: "Step 4 (domain in name)" };
  }
  await delay(500);

  // ── STEP 5: Business directories ──
  onStepUpdate("📋 Step 5/6: Business directories...");
  try {
    const url = await searchStep(
      `"${name}" crunchbase OR owler OR bloomberg`,
      name, empHint, locationHint,
      `Look up this company on Crunchbase, Owler, or Bloomberg. Return the company's own website listed there — NOT the directory URL.`
    );
    if (url) results.push({ url, step: "Step 5 (directory)" });
  } catch (e) {
    console.error("Step 5:", e.message);
  }
  await delay(STEP_DELAY);

  // ── STEP 6: Last resort ──
  onStepUpdate("🎯 Step 6/6: Last resort search...");
  try {
    const locationExtra = locationHint ? ` ${locationHint}` : "";
    const url = await searchStep(
      `${name}${locationExtra} website`,
      name, empHint, locationHint,
      `Last attempt — search broadly, try name variations or abbreviations. Return any plausible match.`
    );
    if (url) results.push({ url, step: "Step 6 (last resort)" });
  } catch (e) {
    console.error("Step 6:", e.message);
  }

  // ── Final decision ──
  if (results.length === 0) return { url: "Not Available", step: "All steps exhausted" };

  // Final cross-validation
  const allDomains = results.map(r => getDomainFromURL(r.url)).filter(Boolean);
  const allCounts = allDomains.reduce((a, d) => { a[d] = (a[d] || 0) + 1; return a; }, {});
  const bestEntry = Object.entries(allCounts).sort((a, b) => b[1] - a[1])[0];
  if (bestEntry && bestEntry[1] >= 2) {
    const match = results.find(r => getDomainFromURL(r.url) === bestEntry[0]);
    return { url: match.url, step: `${match.step} ✓✓ (cross-validated)` };
  }

  // Pick highest similarity
  const scored = results
    .map(r => ({ ...r, score: nameSimilarity(name, r.url) }))
    .sort((a, b) => b.score - a.score);
  return { url: scored[0].url, step: scored[0].step };
}

// ─── CSV ──────────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
  return lines.slice(1).map((line) => {
    const cols = [];
    let cur = "", inQuote = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQuote = !inQuote; }
      else if (line[i] === "," && !inQuote) { cols.push(cur); cur = ""; }
      else { cur += line[i]; }
    }
    cols.push(cur);
    return { name: cols[0] || "", employees: cols[1] || "", id: cols[2] || "", website: "", status: "pending", searchStep: "" };
  });
}

function toCSV(companies) {
  const header = "company.id,company.name,company.noOfEmployees,company.website\n";
  return header + companies.map(c => {
    const name = c.name.includes(",") ? `"${c.name}"` : c.name;
    return `${c.id},${name},${c.employees},${c.website}`;
  }).join("\n");
}

// ─── React App ────────────────────────────────────────────────────────────────
export default function App() {
  const [companies, setCompanies] = useState([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [stats, setStats] = useState({ found: 0, notAvailable: 0, total: 0 });
  const stopRef = useRef(false);

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const parsed = parseCSV(ev.target.result);
      setCompanies(parsed);
      setStats({ found: 0, notAvailable: 0, total: parsed.length });
      setDone(false);
    };
    reader.readAsText(file);
  };

  const updateCompany = useCallback((id, website, status, searchStep) => {
    setCompanies(prev => prev.map(c => c.id === id ? { ...c, website, status, searchStep } : c));
    setStats(prev => ({
      ...prev,
      found: status === "found" ? prev.found + 1 : prev.found,
      notAvailable: status === "notAvailable" ? prev.notAvailable + 1 : prev.notAvailable,
    }));
  }, []);

  const setCompanyStep = useCallback((id, searchStep) => {
    setCompanies(prev => prev.map(c => c.id === id ? { ...c, searchStep } : c));
  }, []);

  const runBatch = async (targets) => {
    setRunning(true);
    setDone(false);
    stopRef.current = false;
    let idx = 0;
    const processNext = async () => {
      while (idx < targets.length && !stopRef.current) {
        const company = targets[idx++];
        setCompanies(prev => prev.map(c => c.id === company.id ? { ...c, status: "searching", searchStep: "Starting..." } : c));
        try {
          const { url, step } = await enrichCompany(company, s => setCompanyStep(company.id, s));
          updateCompany(company.id, url, url === "Not Available" ? "notAvailable" : "found", step);
        } catch (err) {
          console.error("Enrichment failed:", err);
          updateCompany(company.id, "Not Available", "notAvailable", "Error");
        }
        await delay(COMPANY_DELAY);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => processNext()));
    setRunning(false);
    setDone(true);
  };

  const runAll = () => {
    setStats({ found: 0, notAvailable: 0, total: companies.length });
    runBatch(companies.filter(c => c.status === "pending"));
  };

  const rerunNotAvailable = () => {
    const targets = companies.filter(c => c.status === "notAvailable");
    setCompanies(prev => prev.map(c => c.status === "notAvailable" ? { ...c, status: "pending", website: "", searchStep: "" } : c));
    setStats(prev => ({ ...prev, notAvailable: 0 }));
    setTimeout(() => runBatch(targets), 100);
  };

  const downloadCSV = () => {
    const blob = new Blob([toCSV(companies)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "companies_enriched.csv";
    a.click();
  };

  const processed = companies.filter(c => !["pending", "searching"].includes(c.status)).length;
  const searching = companies.filter(c => c.status === "searching").length;
  const notAvailableCount = companies.filter(c => c.status === "notAvailable").length;
  const progress = companies.length ? Math.round((processed / companies.length) * 100) : 0;
  const successRate = processed > 0 ? Math.round((stats.found / processed) * 100) : 0;

  const statusColor = { found: "#22c55e", notAvailable: "#f97316", searching: "#38bdf8", pending: "#334155" };
  const statusLabel = { found: "✓", notAvailable: "–", searching: "⟳", pending: "·" };

  return (
    <div style={{ fontFamily: "'IBM Plex Mono','Courier New',monospace", background: "#0a0f1e", minHeight: "100vh", color: "#e2e8f0", padding: "32px" }}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />

      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 8px #22c55e" }} />
          <span style={{ fontSize: 11, color: "#64748b", letterSpacing: 3, textTransform: "uppercase" }}>Website Enrichment Engine v8</span>
        </div>
        <h1 style={{ fontSize: 26, fontWeight: 600, margin: 0, color: "#f1f5f9" }}>Company URL Finder</h1>
        <p style={{ color: "#64748b", fontSize: 12, margin: "6px 0 0" }}>
          ≤30s per company · 6-step search · AI judges matches · Cross-validates · 429 handled gracefully
        </p>
      </div>

      <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8, padding: "12px 18px", marginBottom: 24 }}>
        <div style={{ fontSize: 10, color: "#475569", letterSpacing: 2, textTransform: "uppercase", marginBottom: 8 }}>Search Pipeline</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "4px 24px" }}>
          {[
            "⚡ Instant · Name contains domain",
            "🔍 Step 1 · Google official website",
            "🔍 Step 2 · Google company name",
            "🔗 Step 3 · LinkedIn → website field",
            "🌐 Step 4 · Domain hint in name",
            "📋 Step 5 · Business directories",
            "🎯 Step 6 · Last resort search",
          ].map((s, i) => <div key={i} style={{ fontSize: 11, color: "#64748b" }}>{s}</div>)}
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 6, padding: "10px 18px", cursor: "pointer", fontSize: 13, color: "#94a3b8" }}>
          <input type="file" accept=".csv" onChange={handleFile} style={{ display: "none" }} />
          {companies.length ? `✓ ${companies.length} companies loaded` : "📂 Upload CSV"}
        </label>

        {companies.length > 0 && !running && companies.some(c => c.status === "pending") && (
          <button onClick={runAll} style={{ background: "#3b82f6", border: "none", borderRadius: 6, padding: "10px 24px", color: "#fff", cursor: "pointer", fontSize: 13, fontFamily: "inherit", fontWeight: 600 }}>
            ▶ Start Enrichment
          </button>
        )}

        {!running && notAvailableCount > 0 && (
          <button onClick={rerunNotAvailable} style={{ background: "#78350f", border: "1px solid #92400e", borderRadius: 6, padding: "10px 24px", color: "#fcd34d", cursor: "pointer", fontSize: 13, fontFamily: "inherit", fontWeight: 600 }}>
            🔄 Retry {notAvailableCount} Not Available
          </button>
        )}

        {running && (
          <button onClick={() => { stopRef.current = true; }} style={{ background: "#7f1d1d", border: "1px solid #991b1b", borderRadius: 6, padding: "10px 24px", color: "#fca5a5", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>
            ■ Stop
          </button>
        )}

        {companies.length > 0 && (
          <button onClick={downloadCSV} style={{ background: "#064e3b", border: "1px solid #065f46", borderRadius: 6, padding: "10px 24px", color: "#6ee7b7", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>
            ↓ Download CSV
          </button>
        )}
      </div>

      {companies.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 12, marginBottom: 24 }}>
          {[
            { label: "Total", value: companies.length, color: "#94a3b8" },
            { label: "Processed", value: processed, color: "#38bdf8" },
            { label: "Found", value: stats.found, color: "#22c55e" },
            { label: "Not Available", value: notAvailableCount, color: "#f97316" },
            { label: "Success Rate", value: `${successRate}%`, color: successRate > 70 ? "#22c55e" : successRate > 40 ? "#fcd34d" : "#f97316" },
            { label: "In Progress", value: searching, color: "#a78bfa" },
          ].map(s => (
            <div key={s.label} style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 8, padding: "12px 14px" }}>
              <div style={{ fontSize: 20, fontWeight: 600, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 10, color: "#475569", marginTop: 2, letterSpacing: 1 }}>{s.label.toUpperCase()}</div>
            </div>
          ))}
        </div>
      )}

      {(running || done) && companies.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12, color: "#64748b" }}>
            <span>{running ? `Processing... ${searching} active` : "✅ Complete"}</span>
            <span>{progress}% ({processed}/{companies.length})</span>
          </div>
          <div style={{ height: 4, background: "#1e293b", borderRadius: 2 }}>
            <div style={{ height: "100%", width: `${progress}%`, background: done ? "#22c55e" : "#3b82f6", borderRadius: 2, transition: "width 0.4s ease", boxShadow: done ? "0 0 8px #22c55e" : "0 0 8px #3b82f6" }} />
          </div>
        </div>
      )}

      {companies.length > 0 && (
        <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "36px 1fr 70px 210px 160px 42px", padding: "10px 16px", borderBottom: "1px solid #1e293b", fontSize: 10, color: "#475569", letterSpacing: 2, textTransform: "uppercase" }}>
            <span>#</span><span>Company</span><span>Emp.</span><span>Website / Current Step</span><span>How Found</span><span></span>
          </div>
          <div style={{ maxHeight: 520, overflowY: "auto" }}>
            {companies.map((c, i) => (
              <div key={c.id} style={{ display: "grid", gridTemplateColumns: "36px 1fr 70px 210px 160px 42px", padding: "8px 16px", borderBottom: "1px solid #0d1424", fontSize: 12, alignItems: "center", background: c.status === "searching" ? "#0b1a24" : "transparent", transition: "background 0.2s" }}>
                <span style={{ color: "#334155" }}>{i + 1}</span>
                <span style={{ color: "#cbd5e1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.name}>{c.name}</span>
                <span style={{ color: "#475569", fontSize: 11 }}>{c.employees || "—"}</span>
                <span style={{ color: c.status === "found" ? "#22c55e" : c.status === "searching" ? "#38bdf8" : "#f97316", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }} title={c.website}>
                  {c.status === "searching" ? (c.searchStep || "Starting...") : (c.website || "—")}
                </span>
                <span style={{ color: "#475569", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.status === "found" ? c.searchStep : ""}
                </span>
                <span style={{ color: statusColor[c.status] || "#334155", textAlign: "center", fontSize: 14 }}>
                  {statusLabel[c.status] || "·"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {companies.length === 0 && (
        <div style={{ border: "1px dashed #1e293b", borderRadius: 12, padding: "60px 32px", textAlign: "center", color: "#334155" }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>📋</div>
          <div style={{ fontSize: 14, color: "#475569" }}>Upload your company CSV to get started</div>
          <div style={{ fontSize: 12, marginTop: 8 }}>Expected: company.name, company.noOfEmployees, company.id</div>
        </div>
      )}
    </div>
  );
}
