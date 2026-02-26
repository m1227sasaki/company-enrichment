import { useState, useRef, useCallback } from "react";

const CONCURRENCY = 2;

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
    return {
      name: cols[0] || "",
      employees: cols[1] || "",
      id: cols[2] || "",
      website: "",
      status: "pending",
      searchStep: "",
    };
  });
}

function toCSV(companies) {
  const header = "company.id,company.name,company.noOfEmployees,company.website\n";
  const rows = companies.map((c) => {
    const name = c.name.includes(",") ? `"${c.name}"` : c.name;
    return `${c.id},${name},${c.employees},${c.website}`;
  });
  return header + rows.join("\n");
}

function isValidURL(str) {
  if (!str) return false;
  const s = str.trim();
  return (s.startsWith("http://") || s.startsWith("https://")) && s.includes(".") && s.length > 10;
}

function cleanURL(str) {
  if (!str) return null;
  let s = str.trim();
  // Strip markdown links
  const mdMatch = s.match(/\[.*?\]\((https?:\/\/[^\)]+)\)/);
  if (mdMatch) s = mdMatch[1];
  // If it looks like a bare domain, add https
  if (!s.startsWith("http") && s.match(/^[a-zA-Z0-9][a-zA-Z0-9\-\.]+\.[a-zA-Z]{2,}$/)) {
    s = "https://" + s;
  }
  if (isValidURL(s)) return s;
  return null;
}

async function singleSearch(query, instruction) {
  const response = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role: "user",
        content: `Search the web for: "${query}"

${instruction}

Reply with ONLY the URL (e.g. https://www.example.com) or the word "notfound" if you could not find a valid website. No explanation, no markdown, just the URL or "notfound".`
      }],
    }),
  });
  if (!response.ok) throw new Error(`API error ${response.status}`);
  const data = await response.json();
  const textBlock = data.content?.find((b) => b.type === "text");
  const raw = textBlock?.text?.trim() || "";
  if (!raw || raw.toLowerCase().includes("notfound") || raw.toLowerCase().includes("not found")) return null;
  return cleanURL(raw);
}

async function enrichCompany(company, onStepUpdate) {
  const name = company.name;
  const emp = company.employees ? ` (${company.employees} employees)` : "";
  let result = null;

  // STEP 1: Direct Google search for official website
  onStepUpdate("Step 1: Searching Google...");
  result = await singleSearch(
    `${name} official website`,
    `Find the official company website for "${name}"${emp}. Look at the search results and return the homepage URL of the company. Do NOT return LinkedIn, Facebook, or directory sites.`
  );
  if (result) return { url: result, step: "Step 1" };
  await delay(300);

  // STEP 2: Search with "company" keyword
  onStepUpdate("Step 2: Broader search...");
  result = await singleSearch(
    `${name} company homepage`,
    `Find the official company website for "${name}"${emp}. Return the company's own domain URL only. Ignore social media and directories.`
  );
  if (result) return { url: result, step: "Step 2" };
  await delay(300);

  // STEP 3: LinkedIn search — extract website from profile
  onStepUpdate("Step 3: Checking LinkedIn...");
  result = await singleSearch(
    `${name} LinkedIn company page`,
    `Find the LinkedIn company page for "${name}"${emp}. Once you find the LinkedIn page, look for the "Website" field listed on their profile and return that URL. Do NOT return the LinkedIn URL itself — return the company's own website listed on their LinkedIn page.`
  );
  if (result) return { url: result, step: "Step 3 (LinkedIn)" };
  await delay(300);

  // STEP 4: If company name looks like a domain, try it directly
  const domainGuess = name.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9\.\-]/g, "");
  if (name.includes(".com") || name.includes(".net") || name.includes(".org")) {
    onStepUpdate("Step 4: Trying domain from name...");
    const match = name.match(/([a-zA-Z0-9\-]+\.(com|net|org|co|io|biz))/i);
    if (match) {
      const guessed = `https://www.${match[1].toLowerCase()}`;
      return { url: guessed, step: "Step 4 (domain guess)" };
    }
  }

  // STEP 5: Crunchbase / business directory search
  onStepUpdate("Step 5: Checking business directories...");
  result = await singleSearch(
    `${name} crunchbase OR "company website"`,
    `Find the official website for company "${name}"${emp} by checking Crunchbase, Bloomberg, or other business directories. Return only the company's own website URL, not the directory URL.`
  );
  if (result) return { url: result, step: "Step 5 (directory)" };
  await delay(300);

  // STEP 6: Last resort — plain name search
  onStepUpdate("Step 6: Last resort search...");
  result = await singleSearch(
    name,
    `This is a company called "${name}"${emp}. Based on the search results, what is their official website URL? Return only the URL of their homepage.`
  );
  if (result) return { url: result, step: "Step 6" };

  return { url: "Not Available", step: "All steps failed" };
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
    setCompanies((prev) =>
      prev.map((c) => (c.id === id ? { ...c, website, status, searchStep } : c))
    );
    setStats((prev) => ({
      ...prev,
      found: status === "found" ? prev.found + 1 : prev.found,
      notAvailable: status === "notAvailable" ? prev.notAvailable + 1 : prev.notAvailable,
    }));
  }, []);

  const setCompanyStep = useCallback((id, searchStep) => {
    setCompanies((prev) =>
      prev.map((c) => (c.id === id ? { ...c, searchStep } : c))
    );
  }, []);

  const runBatch = async (targets) => {
    setRunning(true);
    stopRef.current = false;
    let idx = 0;

    const processNext = async () => {
      while (idx < targets.length && !stopRef.current) {
        const company = targets[idx++];
        setCompanies((prev) =>
          prev.map((c) => (c.id === company.id ? { ...c, status: "searching", searchStep: "Starting..." } : c))
        );
        try {
          const { url, step } = await enrichCompany(company, (stepLabel) => {
            setCompanyStep(company.id, stepLabel);
          });
          const status = url === "Not Available" ? "notAvailable" : "found";
          updateCompany(company.id, url, status, step);
        } catch (err) {
          updateCompany(company.id, "Not Available", "notAvailable", "Error");
        }
        await delay(300);
      }
    };

    const workers = Array.from({ length: CONCURRENCY }, () => processNext());
    await Promise.all(workers);
    setRunning(false);
    setDone(true);
  };

  const runAll = () => {
    setStats({ found: 0, notAvailable: 0, total: companies.length });
    runBatch(companies.filter((c) => c.status === "pending"));
  };

  const rerunNotAvailable = () => {
    const targets = companies.filter((c) => c.status === "notAvailable");
    setCompanies((prev) =>
      prev.map((c) => c.status === "notAvailable" ? { ...c, status: "pending", website: "", searchStep: "" } : c)
    );
    setStats((prev) => ({ ...prev, notAvailable: 0 }));
    setTimeout(() => runBatch(targets), 100);
  };

  const stopEnrichment = () => { stopRef.current = true; };

  const downloadCSV = () => {
    const csv = toCSV(companies);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "companies_enriched.csv";
    a.click();
  };

  const processed = companies.filter((c) => !["pending", "searching"].includes(c.status)).length;
  const searching = companies.filter((c) => c.status === "searching").length;
  const notAvailableCount = companies.filter((c) => c.status === "notAvailable").length;
  const progress = companies.length ? Math.round((processed / companies.length) * 100) : 0;

  const statusColor = { found: "#22c55e", notAvailable: "#f97316", searching: "#38bdf8", pending: "#475569" };
  const statusLabel = { found: "✓", notAvailable: "–", searching: "⟳", pending: "·" };

  return (
    <div style={{ fontFamily: "'IBM Plex Mono', 'Courier New', monospace", background: "#0a0f1e", minHeight: "100vh", color: "#e2e8f0", padding: "32px" }}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />

      <div style={{ marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 8px #22c55e" }} />
          <span style={{ fontSize: 11, color: "#64748b", letterSpacing: 3, textTransform: "uppercase" }}>Website Enrichment Engine v4</span>
        </div>
        <h1 style={{ fontSize: 28, fontWeight: 600, margin: 0, color: "#f1f5f9", letterSpacing: -0.5 }}>Company URL Finder</h1>
        <p style={{ color: "#64748b", fontSize: 13, margin: "6px 0 0" }}>6-step chained search per company — Google → LinkedIn → Directories → Last resort</p>
      </div>

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
          <button onClick={stopEnrichment} style={{ background: "#7f1d1d", border: "1px solid #991b1b", borderRadius: 6, padding: "10px 24px", color: "#fca5a5", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>
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

      {(running || done) && companies.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12, color: "#64748b" }}>
            <span>{running ? `Processing... ${searching} active` : "✅ Complete"}</span>
            <span>{progress}% ({processed}/{companies.length})</span>
          </div>
          <div style={{ height: 4, background: "#1e293b", borderRadius: 2 }}>
            <div style={{ height: "100%", width: `${progress}%`, background: done ? "#22c55e" : "#3b82f6", borderRadius: 2, transition: "width 0.3s ease", boxShadow: done ? "0 0 8px #22c55e" : "0 0 8px #3b82f6" }} />
          </div>
        </div>
      )}

      {companies.length > 0 && (
        <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "36px 1fr 80px 180px 140px 50px", padding: "10px 16px", borderBottom: "1px solid #1e293b", fontSize: 10, color: "#475569", letterSpacing: 2, textTransform: "uppercase" }}>
            <span>#</span><span>Company</span><span>Emp.</span><span>Website</span><span>Step Found</span><span>OK?</span>
          </div>
          <div style={{ maxHeight: 520, overflowY: "auto" }}>
            {companies.map((c, i) => (
              <div key={c.id} style={{ display: "grid", gridTemplateColumns: "36px 1fr 80px 180px 140px 50px", padding: "8px 16px", borderBottom: "1px solid #0d1424", fontSize: 12, alignItems: "center", background: c.status === "searching" ? "#0f2027" : "transparent", transition: "background 0.2s" }}>
                <span style={{ color: "#334155" }}>{i + 1}</span>
                <span style={{ color: "#cbd5e1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                <span style={{ color: "#475569", fontSize: 11 }}>{c.employees || "—"}</span>
                <span style={{ color: c.status === "found" ? "#22c55e" : c.status === "searching" ? "#38bdf8" : "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>
                  {c.status === "searching" ? c.searchStep || "searching..." : c.website || "—"}
                </span>
                <span style={{ color: "#475569", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.status === "found" ? c.searchStep : ""}
                </span>
                <span style={{ color: statusColor[c.status] || "#475569", textAlign: "center" }}>{statusLabel[c.status] || "·"}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {companies.length === 0 && (
        <div style={{ border: "1px dashed #1e293b", borderRadius: 12, padding: "60px 32px", textAlign: "center", color: "#334155" }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>📋</div>
          <div style={{ fontSize: 14 }}>Upload your company CSV to get started</div>
          <div style={{ fontSize: 12, marginTop: 8, color: "#1e293b" }}>Expected columns: company.name, company.noOfEmployees, company.id</div>
        </div>
      )}
    </div>
  );
}
