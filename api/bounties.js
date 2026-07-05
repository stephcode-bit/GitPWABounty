// Vercel serverless function: GET /api/bounties
// Discovers open bounty issues on GitHub, scores them, returns ranked JSON.
//
// Env vars (set in the Vercel dashboard):
//   GITHUB_TOKEN  - a read-only GitHub token (recommended; higher rate limit)
//   MY_SKILLS     - comma separated, e.g. "python,react,go" (optional)
//
// Query params:
//   ?demo=1       - return bundled sample data (no token/network needed)
//   ?top=30       - how many to return (default 40)

const GITHUB_QUERIES = [
  'label:"💰 Bounty" state:open',
  "label:bounty state:open",
  '"/bounty" in:comments state:open',
];

const AMOUNT_RE = /\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)\s?(k)?/gi;

function parseAmount(...texts) {
  let best = null;
  for (const text of texts) {
    if (!text) continue;
    for (const m of String(text).matchAll(AMOUNT_RE)) {
      let value = parseFloat(m[1].replace(/,/g, ""));
      if (Number.isNaN(value)) continue;
      if (m[2]) value *= 1000;
      best = best === null ? value : Math.max(best, value);
    }
  }
  return best;
}

function scoreBounty(b, skills) {
  let score = 50;
  const reasons = [];

  if (b.amount_usd === null) { score -= 15; reasons.push("no reward amount found"); }
  else if (b.amount_usd >= 1000) { score += 25; reasons.push(`high reward ($${b.amount_usd})`); }
  else if (b.amount_usd >= 300) { score += 15; reasons.push(`solid reward ($${b.amount_usd})`); }
  else if (b.amount_usd >= 100) { score += 5; reasons.push(`modest reward ($${b.amount_usd})`); }
  else { score -= 5; reasons.push(`low reward ($${b.amount_usd})`); }

  const hay = `${b.title} ${(b.labels || []).join(" ")} ${b.body}`.toLowerCase();
  const matched = skills.filter((s) => s && hay.includes(s));
  if (matched.length) { score += 12; reasons.push(`matches your skills: ${matched.join(", ")}`); }
  else { score -= 5; reasons.push("no clear skill match"); }

  if (b.comments >= 15) { score -= 12; reasons.push(`crowded (${b.comments} comments)`); }
  else if (b.comments <= 2) { score += 5; reasons.push("little activity yet"); }

  const body = (b.body || "").toLowerCase();
  if (body.includes("steps to reproduce") || body.includes("expected behavior") || body.includes("test")) {
    score += 8; reasons.push("has repro / expected behavior");
  }
  if ((b.body || "").length < 80) { score -= 8; reasons.push("very thin description"); }

  b.score = Math.max(0, Math.min(100, Math.round(score)));
  b.reasons = reasons;
  return b;
}

async function githubDiscover(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "bounty-scout",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const seen = new Map();
  for (const q of GITHUB_QUERIES) {
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=30&sort=created&order=desc`;
    let resp;
    try {
      resp = await fetch(url, { headers });
    } catch (e) {
      continue; // network hiccup on one query shouldn't kill the run
    }
    if (!resp.ok) continue;
    const data = await resp.json();
    for (const item of data.items || []) {
      const labels = (item.labels || []).map((l) => l.name);
      const repo = (item.repository_url || "").split("/").slice(-2).join("/");
      const body = (item.body || "").slice(0, 2000);
      seen.set(item.id, {
        source: "github",
        id: `github:${item.id}`,
        title: item.title || "",
        url: item.html_url || "",
        repo,
        amount_usd: parseAmount(item.title, body, ...labels),
        labels,
        comments: item.comments || 0,
        created_at: item.created_at,
        body,
      });
    }
  }
  return [...seen.values()];
}

function demoBounties() {
  return [
    { source: "github", id: "github:1", title: "Fix memory leak in websocket reconnect (Python)", url: "https://github.com/acme/realtime/issues/1", repo: "acme/realtime", amount_usd: 1500, labels: ["bounty", "bug"], comments: 1, created_at: "2026-07-01", body: "Steps to reproduce: open 100 sockets. Expected behavior: memory stays flat. Includes failing test." },
    { source: "algora", id: "algora:4", title: "CLI crashes on empty config (Go)", url: "https://github.com/tools/cli/issues/4", repo: "tools/cli", amount_usd: 400, labels: ["bounty"], comments: 0, created_at: "2026-07-03", body: "Running with an empty config file panics. Expected behavior: friendly error message." },
    { source: "github", id: "github:2", title: "Add dark mode toggle to settings page (React)", url: "https://github.com/acme/webapp/issues/2", repo: "acme/webapp", amount_usd: 250, labels: ["bounty", "good first issue"], comments: 3, created_at: "2026-07-02", body: "Would love a dark mode toggle. Use the existing theme context." },
    { source: "github", id: "github:3", title: "Rewrite entire billing system", url: "https://github.com/acme/payments/issues/3", repo: "acme/payments", amount_usd: 800, labels: ["bounty"], comments: 22, created_at: "2026-06-20", body: "We need a full rewrite." },
    { source: "github", id: "github:5", title: "Typo somewhere in docs", url: "https://github.com/acme/docs/issues/5", repo: "acme/docs", amount_usd: 40, labels: ["bounty"], comments: 0, created_at: "2026-07-04", body: "typo" },
  ];
}

export default async function handler(req, res) {
  const demo = req.query.demo === "1" || !process.env.GITHUB_TOKEN;
  const top = Math.min(parseInt(req.query.top || "40", 10) || 40, 100);
  const skills = (process.env.MY_SKILLS || "python,javascript,typescript,react,go,rust")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

  let bounties;
  let mode;
  try {
    if (req.query.demo === "1") {
      bounties = demoBounties(); mode = "demo";
    } else {
      bounties = await githubDiscover(process.env.GITHUB_TOKEN);
      mode = process.env.GITHUB_TOKEN ? "live" : "live-unauthenticated";
      if (!bounties.length) { bounties = demoBounties(); mode = "demo-fallback"; }
    }
  } catch (e) {
    bounties = demoBounties(); mode = "demo-error";
  }

  bounties = bounties.map((b) => scoreBounty(b, skills));
  bounties.sort((a, b) => b.score - a.score);

  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  res.status(200).json({
    mode,
    generated_at: new Date().toISOString(),
    count: bounties.length,
    bounties: bounties.slice(0, top),
  });
}
