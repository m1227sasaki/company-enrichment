import { useState, useRef, useCallback } from "react";

const CONCURRENCY = 3;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function findWebsite(company) {
  const res = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ companyName: company.name, employees: company.employees }),
  });
  if (res.status === 429) throw new Error("RATE_LIMIT");
  if (!res.ok) throw new Error(`API_${res.status}`);
  const data = await res.json();
  return { url: data.url || "Not Available", method: data.method || "" };
}

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
    return { name: cols[0] || "", employees: cols[1] || "", id: cols[2] || "", website: "", status: "pending", method: "" };
  });
}

function toCSV(companies) {
  const header = "company.id,company.name,company.noOfEmployees,company.website\n";
  return header + companies.map(c => {
    const name = c.name.includes(",") ? `"${c.name}"` : c.name;
    return `${c.id},${name},${c.employees},${c.website}`;
  }).join("\n");
}

const METHOD_LABELS = {
  domain_variation: "🎯 Domain match",
  google_search: "🔍 Google",
  claude_judgment: "🤖 Claude pick",
  claude_websearch: "🌐 Claude search",
  exhausted: "",
};

export default function App() {
  const [companies, setCompanies] = useState([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [stats, setStats] = useState({ found: 0, notAvailable: 0, total: 0 });
  const stopRef = useRef(false);
  const startTimeRef = useRef(null);

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

  const updateCompany = useCallback((id, website, status, method) => {
    setCompanies(prev => prev.map(c => c.id === id ? { ...c, website, status, method } : c));
    setStats(prev => ({
      ...prev,
      found: status === "found" ? prev.found + 1 : prev.found,
      notAvailable: status === "notAvailable" ? prev.notAvailable + 1 : prev.notAvailable,
    }));
  }, []);

  const runBatch = async (targets) => {
    setRunning(true);
    setDone(false);
    stopRef.current = false;
    startTimeRef.current = Date.now();
    let idx = 0;

    const processNext = async () => {
      while (idx < targets.length && !stopRef.current) {
        const company = targets[idx++];
        setCompanies(prev => prev.map(c => c.id === company.id ? { ...c, status: "searching" } : c));
        try {
          const { url, method } = await findWebsite(company);
          updateCompany(company.id, url, url === "Not Available" ? "notAvailable" : "found", method);
        } catch (e) {
          if (e.message === "RATE_LIMIT") {
            idx--;
            setCompanies(prev => prev.map(c => c.id === company.id ? { ...c, status: "pending" } : c));
            await delay(10000);
          } else {
            updateCompany(company.id, "Not Available", "notAvailable", "error");
          }
        }
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
    setCompanies(prev => prev.map(c => c.status === "notAvailable" ? { ...c, status: "pending", website: "", method: "" } : c));
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

  // ETA calc
  let eta = "";
  if (running && processed > 0 && startTimeRef.current) {
    const elapsed = (Date.now() - startTimeRef.current) / 1000;
    const rate = processed / elapsed; // companies per second
    const remaining = companies.length - processed;
    const secs = Math.round(remaining / rate);
    eta = secs > 60 ? `~${Math.round(secs/60)}m left` : `~${secs}s left`;
  }

  const statusColor = { found: "#22c55e", notAvailable: "#f97316", searching: "#38bdf8", pending: "#334155" };
  const statusLabel = { found: "✓", notAvailable: "–", searching: "⟳", pending: "·" };

  return (
    <div style={{ fontFamily: "'IBM Plex Mono','Courier New',monospace", background: "#0a0f1e", minHeight: "100vh", color: "#e2e8f0", padding: "32px" }}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />

      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 8px #22c55e" }} />
          <span style={{ fontSize: 11, color: "#64748b", letterSpacing: 3, textTransform: "uppercase" }}>Website Enrichment Engine v11</span>
        </div>
        <h1 style={{ fontSize: 26, fontWeight: 600, margin: 0, color: "#f1f5f9" }}>Company URL Finder</h1>
        <p style={{ color: "#64748b", fontSize: 12, margin: "6px 0 0" }}>
          Domain guessing → title validation → Google fallback → Claude fallback
        </p>
      </div>

      {/* Pipeline legend */}
      <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8, padding: "12px 18px", marginBottom: 24 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "4px 24px", fontSize: 11, color: "#64748b" }}>
          <span>🎯 Phase 1 · Generate 15 domain variations</span>
          <span>🔎 Phase 2 · Fetch each → validate page title (50%+ match)</span>
          <span>🔍 Phase 3 · Google search → validate top results</span>
          <span>🤖 Phase 4 · Claude picks from candidates</span>
          <span>🌐 Phase 5 · Claude web search (last resort)</span>
        </div>
      </div>

      {/* Controls */}
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

      {/* Stats */}
      {companies.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 12, marginBottom: 24 }}>
          {[
            { label: "Total", value: companies.length, color: "#94a3b8" },
            { label: "Processed", value: processed, color: "#38bdf8" },
            { label: "Found", value: stats.found, color: "#22c55e" },
            { label: "Not Available", value: notAvailableCount, color: "#f97316" },
            { label: "Success Rate", value: `${successRate}%`, color: successRate > 70 ? "#22c55e" : successRate > 40 ? "#fcd34d" : "#f97316" },
            { label: "Active", value: searching, color: "#a78bfa" },
          ].map(s => (
            <div key={s.label} style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 8, padding: "12px 14px" }}>
              <div style={{ fontSize: 20, fontWeight: 600, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 10, color: "#475569", marginTop: 2, letterSpacing: 1 }}>{s.label.toUpperCase()}</div>
            </div>
          ))}
        </div>
      )}

      {/* Progress */}
      {(running || done) && companies.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12, color: "#64748b" }}>
            <span>{running ? `Processing... ${searching} active ${eta}` : "✅ Complete"}</span>
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
          <div style={{ display: "grid", gridTemplateColumns: "36px 1fr 70px 1fr 130px 42px", padding: "10px 16px", borderBottom: "1px solid #1e293b", fontSize: 10, color: "#475569", letterSpacing: 2, textTransform: "uppercase" }}>
            <span>#</span><span>Company</span><span>Emp.</span><span>Website</span><span>How Found</span><span></span>
          </div>
          <div style={{ maxHeight: 520, overflowY: "auto" }}>
            {companies.map((c, i) => (
              <div key={c.id} style={{ display: "grid", gridTemplateColumns: "36px 1fr 70px 1fr 130px 42px", padding: "8px 16px", borderBottom: "1px solid #0d1424", fontSize: 12, alignItems: "center", background: c.status === "searching" ? "#0b1a24" : "transparent" }}>
                <span style={{ color: "#334155" }}>{i + 1}</span>
                <span style={{ color: "#cbd5e1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.name}>{c.name}</span>
                <span style={{ color: "#475569", fontSize: 11 }}>{c.employees || "—"}</span>
                <span style={{ color: c.status === "found" ? "#22c55e" : c.status === "searching" ? "#38bdf8" : "#f97316", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>
                  {c.status === "searching" ? "searching..." : (c.website || "—")}
                </span>
                <span style={{ color: "#475569", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {METHOD_LABELS[c.method] || ""}
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
        <div style={{ border: "1px dashed #1e293b", borderRadius: 12, padding: "60px 32px", textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>📋</div>
          <div style={{ fontSize: 14, color: "#475569" }}>Upload your company CSV to get started</div>
          <div style={{ fontSize: 12, marginTop: 8, color: "#334155" }}>Expected: company.name, company.noOfEmployees, company.id</div>
        </div>
      )}
    </div>
  );
}
