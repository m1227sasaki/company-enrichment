import { useState, useRef, useCallback } from "react";

const CONCURRENCY = 2;

// ─── CSV Parsing ───────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
  return lines.slice(1).map((line) => {
    const cols = [];
    let cur = "";
    let inQuote = false;
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
  return header + companies.map((c) => {
    const name = c.name.includes(",") ? `"${c.name}"` : c.name;
    return `${c.id},${name},${c.employees},${c.website}`;
  }).join("\n");
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── URL Extraction ─────────────────────────────────────────────────────────────
// Domains we never want to return as the "company website"
const BLOCKED_DOMAINS = [
  "linkedin.com", "facebook.com", "twitter.com", "x.com", "instagram.com",
  "youtube.com", "wikipedia.org", "bloomberg.com", "crunchbase.com",
  "google.com", "bing.com", "yahoo.com", "glassdoor.com", "indeed.com",
  "zoominfo.com", "dnb.com", "hoovers.com", "manta.com", "yelp.com",
  "apple.com", "apps.apple.com", "play.google.com", "amazon.com",
  "reuters.com", "forbes.com", "ft.com", "wsj.com", "techcrunch.com",
  "pitchbook.com", "owler.com", "craft.co", "similarsites.com"
];

function isBlocked(url) {
  return BLOCKED_DOMAINS.some(d => url.includes(d));
}

function extractURL(text) {
  if (!text) return null;

  // Find all http/https URLs in text
  const urlRegex = /https?:\/\/[^\s\)\]\,\"\'<>]+/g;
  const matches = text.match(urlRegex) || [];

  for (let raw of matches) {
    // Clean trailing punctuation
    raw = raw.replace(/[.,;!?]+$/, "");
    if (isBlocked(raw)) continue;
    try {
      const url = new URL(raw);
      return url.origin; // return just the homepage e.g. https://www.example.com
    } catch { continue; }
  }

  // Fallback: bare domain pattern like "example.com" or "www.example.com"
  const bareRegex = /\b(?:www\.)?([a-zA-Z0-9][a-zA-Z0-9\-]{1,61}\.(?:com|net|org|co|io|biz|au|uk|de|fr|es|br|mx|ca|nz|sg|jp|in|eu)(?:\.[a-z]{2})?)\b/g;
  const bareMatches = text.match(bareRegex) || [];
  for (let raw of bareMatches) {
    if (isBlocked(raw)) continue;
    const full = raw.startsWith("http") ? raw : `https://${raw}`;
    try { new URL(full); return full; } catch { continue; }
  }

  return null;
}

// ─── Core API Call (handles multi-turn tool use properly) ──────────────────────
async function callWithSearch(userPrompt) {
  const tools = [{ type: "web_search_20250305", name: "web_search" }];
  let messages = [{ role: "user", content: userPrompt }];

  // Round 1: Claude decides to search
  const res1 = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, tools, messages }),
  });
  if (!res1.ok) throw new Error(`API error ${res1.status}`);
  const data1 = await res1.json();

  // Collect text from round 1 (might already have an answer)
  const textFromRound1 = data1.content.filter(b => b.type === "text").map(b => b.text).join("\n");

  // If Claude used the search tool, do round 2 to get the answer
  const toolUseBlocks = data1.content.filter(b => b.type === "tool_use");
  if (toolUseBlocks.length > 0) {
    // Build tool results from the search
    const toolResults = data1.content
      .filter(b => b.type === "tool_result" || b.type === "tool_use")
      .map(b => {
        if (b.type === "tool_result") return b;
        return null;
      }).filter(Boolean);

    // Append Claude's response and tool results to messages
    messages = [
      ...messages,
      { role: "assistant", content: data1.content },
    ];

    // Round 2: Claude reads search results and gives final answer
    const res2 = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 500, tools, messages }),
    });
    if (!res2.ok) throw new Error(`API error ${res2.status}`);
    const data2 = await res2.json();
    const textFromRound2 = data2.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    return textFromRound1 + "\n" + textFromRound2;
  }

  return textFromRound1;
}

// ─── 6-Step Enrichment Per Company ─────────────────────────────────────────────
async function enrichCompany(company, onStepUpdate) {
  const name = company.name;
  const emp = company.employees ? ` The company has about ${company.employees} employees.` : "";

  // STEP 1 — Google: official website
  onStepUpdate("🔍 Step 1: Google official website...");
  try {
    const text = await callWithSearch(
      `Search for the official website of a company called "${name}".${emp}
Use the web search tool to search for: ${name} official website
Look at the results. Find their homepage URL (not LinkedIn, not Facebook, not a directory).
Reply with just the URL, nothing else. Example: https://www.companyname.com`
    );
    const url = extractURL(text);
    if (url) return { url, step: "Step 1 (Google)" };
  } catch (e) { console.error("Step 1 failed", e); }
  await delay(500);

  // STEP 2 — Google: company name only
  onStepUpdate("🔍 Step 2: Google company name...");
  try {
    const text = await callWithSearch(
      `Use the web search tool to search for: "${name}"
I need to find the official website for a company called "${name}".${emp}
Look through the search results for their own website domain (not social media, not directories).
Reply with just the URL. Example: https://www.example.com`
    );
    const url = extractURL(text);
    if (url) return { url, step: "Step 2 (Google name)" };
  } catch (e) { console.error("Step 2 failed", e); }
  await delay(500);

  // STEP 3 — LinkedIn: find company page and extract website field
  onStepUpdate("🔗 Step 3: LinkedIn company page...");
  try {
    const text = await callWithSearch(
      `Use the web search tool to search for: "${name}" site:linkedin.com/company
Find the LinkedIn company page for "${name}".${emp}
On the LinkedIn page, there is a "Website" field that shows their official website.
What is the website URL listed on their LinkedIn profile? Reply with just that URL.`
    );
    const url = extractURL(text);
    if (url) return { url, step: "Step 3 (LinkedIn)" };
  } catch (e) { console.error("Step 3 failed", e); }
  await delay(500);

  // STEP 4 — If company name contains a domain hint, use it directly
  onStepUpdate("🌐 Step 4: Domain name hint...");
  const domainMatch = name.match(/([a-zA-Z0-9\-]+\.(com|net|org|co\.uk|io|biz|au|co))\b/i);
  if (domainMatch) {
    const guessed = `https://www.${domainMatch[1].toLowerCase()}`;
    return { url: guessed, step: "Step 4 (name contains domain)" };
  }
  await delay(200);

  // STEP 5 — Business directories (Crunchbase, Owler, Bloomberg)
  onStepUpdate("📋 Step 5: Business directories...");
  try {
    const text = await callWithSearch(
      `Use the web search tool to search for: "${name}" crunchbase OR owler OR bloomberg
Look up the company "${name}"${emp} on business directories like Crunchbase, Owler, or Bloomberg.
These pages show the company's official website URL. Find it and reply with just the URL.`
    );
    const url = extractURL(text);
    if (url) return { url, step: "Step 5 (directory)" };
  } catch (e) { console.error("Step 5 failed", e); }
  await delay(500);

  // STEP 6 — Last resort: try guessing domain variations
  onStepUpdate("🎯 Step 6: Last resort search...");
  try {
    const cleanName = name.toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+(inc|llc|ltd|co|corp|group|media|solutions|services|digital|global|international)$/i, "")
      .trim()
      .replace(/\s+/g, "");

    const text = await callWithSearch(
      `Use the web search tool to search for: ${name} website OR homepage OR "${cleanName}.com"
This is my last attempt to find the website for "${name}".${emp}
Try any variation of their name as a domain. Search broadly.
If you find any website that belongs to this company, reply with just that URL.
If truly nothing exists online, reply with exactly: NOTFOUND`
    );
    if (text.includes("NOTFOUND")) return { url: "Not Available", step: "All steps exhausted" };
    const url = extractURL(text);
    if (url) return { url, step: "Step 6 (last resort)" };
  } catch (e) { console.error("Step 6 failed", e); }

  return { url: "Not Available", step: "All steps exhausted" };
}

// ─── React App ─────────────────────────────────────────────────────────────────
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
    setCompanies((prev) => prev.map((c) => c.id === id ? { ...c, website, status, searchStep } : c));
    setStats((prev) => ({
      ...prev,
      found: status === "found" ? prev.found + 1 : prev.found,
      notAvailable: status === "notAvailable" ? prev.notAvailable + 1 : prev.notAvailable,
    }));
  }, []);

  const setCompanyStep = useCallback((id, searchStep) => {
    setCompanies((prev) => prev.map((c) => c.id === id ? { ...c, searchStep } : c));
  }, []);

  const runBatch = async (targets) => {
    setRunning(true);
    setDone(false);
    stopRef.current = false;
    let idx = 0;

    const processNext = async () => {
      while (idx < targets.length && !stopRef.current) {
        const company = targets[idx++];
        setCompanies((prev) => prev.map((c) => c.id === company.id ? { ...c, status: "searching", searchStep: "Starting..." } : c));
        try {
          const { url, step } = await enrichCompany(company, (s) => setCompanyStep(company.id, s));
          updateCompany(company.id, url, url === "Not Available" ? "notAvailable" : "found", step);
        } catch (err) {
          console.error("Enrichment error", err);
          updateCompany(company.id, "Not Available", "notAvailable", "Error");
        }
        await delay(300);
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, () => processNext()));
    setRunning(false);
    setDone(true);
  };

  const runAll = () => {
    setStats({ found: 0, notAvailable: 0, total: companies.length });
    runBatch(companies.filter((c) => c.status === "pending"));
  };

  const rerunNotAvailable = () => {
    const targets = companies.filter((c) => c.status === "notAvailable");
    setCompanies((prev) => prev.map((c) => c.status === "notAvailable" ? { ...c, status: "pending", website: "", searchStep: "" } : c));
    setStats((prev) => ({ ...prev, notAvailable: 0 }));
    setTimeout(() => runBatch(targets), 100);
  };

  const downloadCSV = () => {
    const blob = new Blob([toCSV(companies)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "companies_enriched.csv";
    a.click();
  };

  const processed = companies.filter((c) => !["pending", "searching"].includes(c.status)).length;
  const searching = companies.filter((c) => c.status === "searching").length;
  const notAvailableCount = companies.filter((c) => c.status === "notAvailable").length;
  const progress = companies.length ? Math.round((processed / companies.length) * 100) : 0;

  const statusColor = { found: "#22c55e", notAvailable: "#f97316", searching: "#38bdf8", pending: "#334155" };
  const statusLabel = { found: "✓", notAvailable: "–", searching: "⟳", pending: "·" };

  return (
    <div style={{ fontFamily: "'IBM Plex Mono','Courier New',monospace", background: "#0a0f1e", minHeight: "100vh", color: "#e2e8f0", padding: "32px" }}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 8px #22c55e" }} />
          <span style={{ fontSize: 11, color: "#64748b", letterSpacing: 3, textTransform: "uppercase" }}>Website Enrichment Engine v6</span>
        </div>
        <h1 style={{ fontSize: 28, fontWeight: 600, margin: 0, color: "#f1f5f9" }}>Company URL Finder</h1>
        <p style={{ color: "#64748b", fontSize: 13, margin: "6px 0 0" }}>
          Each company goes through 6 independent search steps. Only marks "Not Available" after all 6 fail.
        </p>
      </div>

      {/* Search Steps Legend */}
      <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8, padding: "16px 20px", marginBottom: 24, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
        {[
          "🔍 Step 1: Google official website",
          "🔍 Step 2: Google company name",
          "🔗 Step 3: LinkedIn company page",
          "🌐 Step 4: Domain name hint",
          "📋 Step 5: Business directories",
          "🎯 Step 6: Last resort search",
        ].map((s, i) => (
          <div key={i} style={{ fontSize: 11, color: "#475569" }}>{s}</div>
        ))}
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 6, padding: "10px 18px", cursor: "pointer", fontSize: 13, color: "#94a3b8" }}>
          <input type="file" accept=".csv" onChange={handleFile} style={{ display: "none" }} />
          {companies.length ? `✓ ${companies.length} companies loaded` : "📂 Upload CSV"}
        </label>

        {companies.length > 0 && !running && (
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

      {/* Stats */}
      {companies.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12, marginBottom: 24 }}>
          {[
            { label: "Total", value: companies.length, color: "#94a3b8" },
            { label: "Processed", value: processed, color: "#38bdf8" },
            { label: "Found", value: stats.found, color: "#22c55e" },
            { label: "Not Available", value: notAvailableCount, color: "#f97316" },
            { label: "In Progress", value: searching, color: "#a78bfa" },
          ].map((s) => (
            <div key={s.label} style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 8, padding: "12px 16px" }}>
              <div style={{ fontSize: 22, fontWeight: 600, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 11, color: "#475569", marginTop: 2, letterSpacing: 1 }}>{s.label.toUpperCase()}</div>
            </div>
          ))}
        </div>
      )}

      {/* Progress */}
      {(running || done) && companies.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12, color: "#64748b" }}>
            <span>{running ? `Processing... ${searching} companies active` : "✅ Complete"}</span>
            <span>{progress}% ({processed}/{companies.length})</span>
          </div>
          <div style={{ height: 4, background: "#1e293b", borderRadius: 2 }}>
            <div style={{ height: "100%", width: `${progress}%`, background: done ? "#22c55e" : "#3b82f6", borderRadius: 2, transition: "width 0.3s ease", boxShadow: done ? "0 0 8px #22c55e" : "0 0 8px #3b82f6" }} />
          </div>
        </div>
      )}

      {/* Table */}
      {companies.length > 0 && (
        <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "36px 1fr 70px 210px 160px 46px", padding: "10px 16px", borderBottom: "1px solid #1e293b", fontSize: 10, color: "#475569", letterSpacing: 2, textTransform: "uppercase" }}>
            <span>#</span><span>Company</span><span>Emp.</span><span>Website / Current Step</span><span>How Found</span><span></span>
          </div>
          <div style={{ maxHeight: 540, overflowY: "auto" }}>
            {companies.map((c, i) => (
              <div key={c.id} style={{ display: "grid", gridTemplateColumns: "36px 1fr 70px 210px 160px 46px", padding: "8px 16px", borderBottom: "1px solid #0d1424", fontSize: 12, alignItems: "center", background: c.status === "searching" ? "#0b1a24" : "transparent", transition: "background 0.2s" }}>
                <span style={{ color: "#334155" }}>{i + 1}</span>
                <span style={{ color: "#cbd5e1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.name}>{c.name}</span>
                <span style={{ color: "#475569", fontSize: 11 }}>{c.employees || "—"}</span>
                <span style={{ color: c.status === "found" ? "#22c55e" : c.status === "searching" ? "#38bdf8" : "#f97316", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }} title={c.website}>
                  {c.status === "searching" ? (c.searchStep || "Starting...") : (c.website || "—")}
                </span>
                <span style={{ color: "#475569", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.status === "found" ? c.searchStep : ""}
                </span>
                <span style={{ color: statusColor[c.status] || "#334155", textAlign: "center", fontSize: 14 }}>{statusLabel[c.status] || "·"}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {companies.length === 0 && (
        <div style={{ border: "1px dashed #1e293b", borderRadius: 12, padding: "60px 32px", textAlign: "center", color: "#334155" }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>📋</div>
          <div style={{ fontSize: 14, color: "#475569" }}>Upload your company CSV to get started</div>
          <div style={{ fontSize: 12, marginTop: 8 }}>Expected columns: company.name, company.noOfEmployees, company.id</div>
        </div>
      )}
    </div>
  );
}
