// Domain variation generator
const HARD_STOP = new Set([
  "inc","llc","ltd","corp","plc","pty","the","and","of","for","a","an",
  "company","enterprises","ventures","holdings","co",
]);

const TLDS = ["com","net","io","co","org","ai","app","tech","biz","us","digital","media"];

function generateVariations(companyName) {
  const dotComMatch = companyName.match(/^(.+?)\.(com|io|net|org|co|ai|app|biz)$/i);
  if (dotComMatch) {
    const base = dotComMatch[1].toLowerCase().replace(/[^a-z0-9]/g, "");
    const tld = dotComMatch[2].toLowerCase();
    return [`https://www.${base}.${tld}`, `https://${base}.${tld}`];
  }

  const raw = companyName.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
  const allWords = raw.split(/\s+/).filter(w => w.length > 0);
  const cleanWords = allWords.filter(w => !HARD_STOP.has(w) && w.length > 1);

  const bases = [];
  const add = (b) => {
    const clean = (b || "").replace(/[^a-z0-9]/g, "");
    if (clean.length >= 2 && !bases.includes(clean)) bases.push(clean);
  };

  add(cleanWords.join(""));
  if (cleanWords.length >= 2) add(cleanWords.slice(0,2).join(""));
  if (cleanWords.length >= 3) add(cleanWords.slice(0,3).join(""));
  add(cleanWords[0]);
  const initials = cleanWords.map(w => w[0]).join("");
  if (initials.length >= 2 && initials.length <= 5) add(initials);
  if (allWords.length >= 2) add(allWords.slice(0,2).join(""));
  add(allWords[0]);

  const urls = [];
  for (const base of bases.slice(0, 5)) {
    for (const tld of TLDS) {
      if (urls.length >= 15) break;
      urls.push(`https://www.${base}.${tld}`);
    }
    if (urls.length >= 15) break;
  }
  return urls;
}

// Title match score: what % of company name keywords appear in page title
function titleScore(companyName, pageTitle) {
  if (!pageTitle) return 0;
  const raw = companyName.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
  const keywords = raw.split(/\s+/).filter(w => !HARD_STOP.has(w) && w.length > 2);
  if (keywords.length === 0) return 0;
  const title = pageTitle.toLowerCase();
  return keywords.filter(w => title.includes(w)).length / keywords.length;
}

// Fetch page title from a URL (3s timeout)
async function fetchTitle(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
      signal: AbortSignal.timeout(3000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
    if (match) return match[1].trim();
    const h1 = html.match(/<h1[^>]*>([^<]{1,200})<\/h1>/i);
    if (h1) return h1[1].replace(/<[^>]+>/g, "").trim();
    return null;
  } catch {
    return null;
  }
}

// Google search fallback — fetch results page and extract URLs
async function googleSearch(companyName) {
  try {
    const q = encodeURIComponent(`"${companyName}" official website`);
    const res = await fetch(`https://www.google.com/search?q=${q}&num=8`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36" },
      signal: AbortSignal.timeout(5000),
    });
    const html = await res.text();
    // Extract URLs from href attributes
    const urls = [...html.matchAll(/href="(https?:\/\/(?!www\.google)[^"&]+)"/g)]
      .map(m => {
        try { return new URL(m[1]).origin; } catch { return null; }
      })
      .filter(u => u && !u.includes("google.") && !u.includes("youtube.") &&
        !u.includes("facebook.") && !u.includes("linkedin.") &&
        !u.includes("wikipedia.") && !u.includes("bloomberg.") &&
        !u.includes("crunchbase."));
    // Deduplicate
    return [...new Set(urls)].slice(0, 5);
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { companyName, employees } = req.body;
  if (!companyName) return res.status(400).json({ error: "Missing companyName" });

  const THRESHOLD = 0.5; // 50% keyword match required

  // ── PHASE 1: Try domain variations in parallel ──────────────────────────────
  const variations = generateVariations(companyName);
  let bestCandidate = null; // { url, score } — live but title didn't match threshold

  // Check all variations in parallel, max 3s each
  const results = await Promise.allSettled(
    variations.map(async (url) => {
      const title = await fetchTitle(url);
      if (!title) return null; // not live
      const score = titleScore(companyName, title);
      return { url, title, score };
    })
  );

  // Find best match from domain variations
  const liveResults = results
    .filter(r => r.status === "fulfilled" && r.value)
    .map(r => r.value)
    .sort((a, b) => b.score - a.score);

  // Immediate match: first result above threshold
  const strongMatch = liveResults.find(r => r.score >= THRESHOLD);
  if (strongMatch) {
    return res.json({ url: strongMatch.url, method: "domain_variation", score: strongMatch.score });
  }

  // Keep best candidate even if below threshold
  if (liveResults.length > 0) {
    bestCandidate = liveResults[0];
  }

  // ── PHASE 2: Google search ──────────────────────────────────────────────────
  const googleUrls = await googleSearch(companyName);

  // Validate Google results with title check
  const googleResults = await Promise.allSettled(
    googleUrls.map(async (url) => {
      const title = await fetchTitle(url);
      if (!title) return null;
      const score = titleScore(companyName, title);
      return { url, title, score };
    })
  );

  const liveGoogle = googleResults
    .filter(r => r.status === "fulfilled" && r.value)
    .map(r => r.value)
    .sort((a, b) => b.score - a.score);

  const googleMatch = liveGoogle.find(r => r.score >= THRESHOLD);
  if (googleMatch) {
    return res.json({ url: googleMatch.url, method: "google_search", score: googleMatch.score });
  }

  // ── PHASE 3: Ask Claude to judge if we have candidates but no threshold match ─
  const allCandidates = [...liveResults, ...liveGoogle].sort((a, b) => b.score - a.score);

  if (allCandidates.length > 0) {
    // Use Claude to pick best from candidates
    const candidateList = allCandidates.slice(0, 5)
      .map(c => `URL: ${c.url} | Page title: "${c.title}"`)
      .join("\n");

    const empHint = employees ? ` (${employees} employees)` : "";
    const claudeBody = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: `Company: "${companyName}"${empHint}

These URLs were found live. Which one is most likely the official website?
${candidateList}

Reply with ONLY the URL (e.g. https://www.example.com) or NOT_AVAILABLE if none match.`,
      }],
    };

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(claudeBody),
      signal: AbortSignal.timeout(10000),
    });

    if (claudeRes.ok) {
      const data = await claudeRes.json();
      const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
      if (text && !text.includes("NOT_AVAILABLE")) {
        const urlMatch = text.match(/https?:\/\/[^\s\)\n]+/);
        if (urlMatch) {
          return res.json({ url: new URL(urlMatch[0]).origin, method: "claude_judgment" });
        }
      }
    }
  }

  // ── PHASE 4: Claude with web search as last resort ──────────────────────────
  const empHint = employees ? ` (${employees} employees)` : "";
  const claudeBody = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 150,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    messages: [{
      role: "user",
      content: `Find the official website for: "${companyName}"${empHint}. Return ONLY the URL or NOT_AVAILABLE.`,
    }],
  };

  let waitMs = 5000;
  for (let attempt = 0; attempt <= 3; attempt++) {
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(claudeBody),
      signal: AbortSignal.timeout(25000),
    });

    if (claudeRes.status === 429) {
      if (attempt === 3) break;
      const retryAfter = claudeRes.headers.get("retry-after");
      await new Promise(r => setTimeout(r, Math.min(retryAfter ? parseInt(retryAfter) * 1000 : waitMs, 20000)));
      waitMs *= 2;
      continue;
    }

    if (claudeRes.ok) {
      const data = await claudeRes.json();
      const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
      if (text && !text.includes("NOT_AVAILABLE")) {
        const urlMatch = text.match(/https?:\/\/[^\s\)\n]+/);
        if (urlMatch) {
          try {
            return res.json({ url: new URL(urlMatch[0]).origin, method: "claude_websearch" });
          } catch {}
        }
      }
    }
    break;
  }

  return res.json({ url: "Not Available", method: "exhausted" });
}