import { useState, useRef, useCallback } from "react";

const CONCURRENCY = 3;

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

async function searchCompanyWebsite(company) {
  const empHint = company.employees ? ` (${company.employees} employees)` : "";
  const prompt = `Find the official website URL for this company: "${company.name}"${empHint}.

Rules:
- Return ONLY the bare domain URL like https://www.example.com
- If you cannot find it with confidence, return exactly: Not Available
- If there are too many companies with similar names and you cannot determine which is correct, return exactly: Too many similar results
- Do not include any explanation, just the URL or one of the two phrases above.`;

  const response = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 200,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) throw new Error(`API error ${response.status}`);
  const data = await response.json();
  const textBlock = data.content?.find((b) => b.type === "text");
  return textBlock?.text?.trim() || "Not Available";
}

export default function App() {
  const [companies, setCompanies] = useState([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [stats, setStats] = useState({ found: 0, notAvailable: 0, tooMany: 0, total: 0 });
  const stopRef = useRef(false);

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const parsed = parseCSV(ev.target.result);
      setCompanies(parsed);
      setStats({ found: 0, notAvailable: 0, tooMany: 0, total: parsed.length });
      setDone(false);
    };
    reader.readAsText(file);
  };

  const updateCompany = useCallback((id, website, status) => {
    setCompanies((prev) =>
      prev.map((c) => (c.id === id ? { ...c, website, status } : c))
    );
    setStats((prev) => {
      const next = { ...prev };
      if (status === "found") next.found++;
      else if (status === "notAvailable") next.notAvailable++;
      else if (status === "tooMany") next.tooMany++;
      return next;
    });
  }, []);

  const runEnrichment = async () => {
    if (!companies.length) return;
    setRunning(true);
    stopRef.current = false;

    const pending = companies.filter((c) => c.status === "pending");
    let idx = 0;

    const processNext = async () => {
      while (idx < pending.length && !stopRef.current) {
        const company = pending[idx++];
        setCompanies((prev) =>
          prev.map((c) => (c.id === company.id ? { ...c, status: "searching" } : c))
        );
        try {
          const website = await searchCompanyWebsite(company);
          const status =
            website === "Not Available"
              ? "notAvailable"
              : website === "Too many similar results"
              ? "tooMany"
              : "found";
          updateCompany(company.id, website, status);
        } catch {
          updateCompany(company.id, "Not Available", "notAvailable");
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    };

    const workers = Array.from({ length: CONCURRENCY }, () => processNext());
    await Promise.all(workers);

    setRunning(false);
    setDone(true);
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

  const processed = companies.filter((c) => c.status !== "pending" && c.status !== "searching").length;
  const searching = companies.filter((c) => c.status === "searching").length;
  const progress = companies.length ? Math.round((processed / companies.length) * 100) : 0;

  const statusColor = {
    found: "#22c55e",
    notAvailable: "#f97316",
    tooMany: "#a78bfa",
    searching: "#38bdf8",
    pending: "#475569",
  };

  const statusLabel = {
    found: "✓",
    notAvailable: "–",
    tooMany: "?",
    searching: "⟳",
    pending: "·",
  };

  return (
    <div style={{
      fontFamily: "'IBM Plex Mono', 'Courier New', monospace",
      background: "#0a0f1e",
      minHeight: "100vh",
      color: "#e2e8f0",
      padding: "32px",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 8px #22c55e" }} />
          <span style={{ fontSize: 11, color: "#64748b", letterSpacing: 3, textTransform: "uppercase" }}>
            Website Enrichment Engine
          </span>
        </div>
        <h1 style={{ fontSize: 28, fontWeight: 600, margin: 0, color: "#f1f5f9", letterSpacing: -0.5 }}>
          Company URL Finder
        </h1>
        <p style={{ color: "#64748b", fontSize: 13, marginTop: 6, margin: "6px 0 0" }}>
          Upload CSV → AI searches each company → Download enriched results
        </p>
      </div>

      {/* Upload + Controls */}
      <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{
          background: "#1e293b",
          border: "1px solid #334155",
          borderRadius: 6,
          padding: "10px 18px",
          cursor: "pointer",
          fontSize: 13,
          color: "#94a3b8",
        }}>
          <input type="file" accept=".csv" onChange={handleFile} style={{ display: "none" }} />
          {companies.length ? `✓ ${companies.length} companies loaded` : "📂 Upload CSV"}
        </label>

        {companies.length > 0 && !running && !done && (
          <button onClick={runEnrichment} style={{
            background: "#3b82f6",
            border: "none",
            borderRadius: 6,
            padding: "10px 24px",
            color: "#fff",
            cursor: "pointer",
            fontSize: 13,
            fontFamily: "inherit",
            fontWeight: 600,
          }}>
            ▶ Start Enrichment
          </button>
        )}

        {running && (
          <button onClick={stopEnrichment} style={{
            background: "#7f1d1d",
            border: "1px solid #991b1b",
            borderRadius: 6,
            padding: "10px 24px",
            color: "#fca5a5",
            cursor: "pointer",
            fontSize: 13,
            fontFamily: "inherit",
          }}>
            ■ Stop
          </button>
        )}

        {companies.length > 0 && (
          <button onClick={downloadCSV} style={{
            background: "#064e3b",
            border: "1px solid #065f46",
            borderRadius: 6,
            padding: "10px 24px",
            color: "#6ee7b7",
            cursor: "pointer",
            fontSize: 13,
            fontFamily: "inherit",
          }}>
            ↓ Download CSV
          </button>
        )}
      </div>

      {/* Stats Bar */}
      {companies.length > 0 && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          gap: 12,
          marginBottom: 24,
        }}>
          {[
            { label: "Total", value: companies.length, color: "#94a3b8" },
            { label: "Processed", value: processed, color: "#38bdf8" },
            { label: "Found", value: stats.found, color: "#22c55e" },
            { label: "Not Available", value: stats.notAvailable, color: "#f97316" },
            { label: "Too Many", value: stats.tooMany, color: "#a78bfa" },
          ].map((s) => (
            <div key={s.label} style={{
              background: "#111827",
              border: "1px solid #1e293b",
              borderRadius: 8,
              padding: "12px 16px",
            }}>
              <div style={{ fontSize: 22, fontWeight: 600, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 11, color: "#475569", marginTop: 2, letterSpacing: 1 }}>{s.label.toUpperCase()}</div>
            </div>
          ))}
        </div>
      )}

      {/* Progress Bar */}
      {(running || done) && companies.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12, color: "#64748b" }}>
            <span>{running ? `Processing... ${searching} active` : "Complete"}</span>
            <span>{progress}% ({processed}/{companies.length})</span>
          </div>
          <div style={{ height: 4, background: "#1e293b", borderRadius: 2 }}>
            <div style={{
              height: "100%",
              width: `${progress}%`,
              background: done ? "#22c55e" : "#3b82f6",
              borderRadius: 2,
              transition: "width 0.3s ease",
              boxShadow: done ? "0 0 8px #22c55e" : "0 0 8px #3b82f6",
            }} />
          </div>
        </div>
      )}

      {/* Company List */}
      {companies.length > 0 && (
        <div style={{
          background: "#0f172a",
          border: "1px solid #1e293b",
          borderRadius: 8,
          overflow: "hidden",
        }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: "40px 1fr 100px 200px 60px",
            padding: "10px 16px",
            borderBottom: "1px solid #1e293b",
            fontSize: 10,
            color: "#475569",
            letterSpacing: 2,
            textTransform: "uppercase",
          }}>
            <span>#</span><span>Company Name</span><span>Employees</span><span>Website</span><span>Status</span>
          </div>
          <div style={{ maxHeight: 500, overflowY: "auto" }}>
            {companies.map((c, i) => (
              <div key={c.id} style={{
                display: "grid",
                gridTemplateColumns: "40px 1fr 100px 200px 60px",
                padding: "8px 16px",
                borderBottom: "1px solid #0f172a",
                fontSize: 12,
                alignItems: "center",
                background: c.status === "searching" ? "#0f2027" : "transparent",
                transition: "background 0.2s",
              }}>
                <span style={{ color: "#334155" }}>{i + 1}</span>
                <span style={{ color: "#cbd5e1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                <span style={{ color: "#475569" }}>{c.employees || "—"}</span>
                <span style={{
                  color: c.status === "found" ? "#22c55e" : c.status === "searching" ? "#38bdf8" : "#64748b",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 11,
                }}>
                  {c.status === "searching" ? "searching..." : c.website || "—"}
                </span>
                <span style={{ color: statusColor[c.status] || "#475569", textAlign: "center" }}>
                  {statusLabel[c.status] || "·"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {companies.length === 0 && (
        <div style={{
          border: "1px dashed #1e293b",
          borderRadius: 12,
          padding: "60px 32px",
          textAlign: "center",
          color: "#334155",
        }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>📋</div>
          <div style={{ fontSize: 14 }}>Upload your company CSV to get started</div>
          <div style={{ fontSize: 12, marginTop: 8, color: "#1e293b" }}>
            Expected format: company.name, company.noOfEmployees, company.id
          </div>
        </div>
      )}
    </div>
  );
}
