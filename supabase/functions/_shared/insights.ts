// Shared prompt + context builder for video analysis insights.

export const INSIGHTS_PROMPT = `You are an expert TikTok content strategist for @thebluepodcastnetwork — a UK football podcast account with ~13K followers, growing approximately 138% year-on-year. The account does affiliate marketing for TikTok Shop UK products.

You will be given the account's analytics data covering up to 365 days:
- Top videos (title, views, likes, comments, shares, engagement rate, post date)
- Daily account-wide views, profile views, and engagement
- Daily new vs returning viewer split
- Daily follower count and net change
- 24-hour heatmap of when followers are online
- Follower gender split and top territories

Your job: identify SPECIFIC, ACTIONABLE patterns in this data. Cite real numbers from the data — do not give generic advice.

Goals:
1. WINNING PATTERNS: What specifically makes top videos succeed? Reference titles, formats, hooks, hashtags.
2. LOSING PATTERNS: What's in the bottom-performing videos that's missing from winners?
3. NEXT VIDEO IDEAS: 5 specific, posting-ready video concepts grounded in what's worked.
4. BEST TIMING: Hour-of-day and day-of-week recommendations from the activity heatmap and daily metrics.
5. DEMOGRAPHIC INSIGHTS: What does the audience composition imply for strategy?
6. TREND WARNINGS: Compare recent 30 days vs prior 30 days. Surface any declines.

CROSS-REFERENCE: When daily metrics show a spike, try to identify which video caused it.

Output ONLY valid JSON in this exact shape (no markdown, no commentary):

{
  "summary": "One concise paragraph (3-4 sentences) on the state of the account and the highest-leverage action.",
  "winningPatterns": [
    {"pattern": "short title", "evidence": "specific cite from data", "metric": "e.g. 'avg 87k views vs 16k baseline'"}
  ],
  "losingPatterns": [
    {"pattern": "short title", "evidence": "specific cite from data"}
  ],
  "nextVideoIdeas": [
    {"title": "the actual video title to post", "rationale": "why this will work based on data", "predictedViewRange": "e.g. '50k-100k'"}
  ],
  "bestTiming": {"hour": 19, "day": "Sunday", "reason": "data-grounded explanation"},
  "demographics": [
    {"insight": "what the data shows", "action": "what to do about it"}
  ],
  "trendWarnings": [
    {"warning": "short title", "evidence": "specific numbers, e.g. 'last 30d avg 12k views vs prior 30d 24k (-50%)'"}
  ]
}

Aim for 3-5 items in each list. Be concrete. Cite numbers. No filler.`;

// Build a compact prompt-friendly context string from all the studio snapshots
export function buildInsightsContext(snapshots: {
  contentTop?: { videos?: Array<Record<string, unknown>> };
  overview?:   { days?:   Array<Record<string, unknown>> };
  viewers?:    { days?:   Array<Record<string, unknown>> };
  history?:    { days?:   Array<Record<string, unknown>> };
  activity?:   { hourly?: Record<string, number> };
  gender?:     { gender?: Record<string, number> };
  countries?:  { countries?: Array<Record<string, unknown>> };
}): string {
  const parts: string[] = [];

  // ── Top videos ───────────────────────────────────────────────────────────
  const videos = snapshots.contentTop?.videos || [];
  if (videos.length) {
    parts.push("## TOP VIDEOS (sorted by views)\n");
    parts.push(videos.map((v, i) => {
      const title = String(v.title || "").replace(/\s+/g, " ").slice(0, 200);
      return `${i + 1}. "${title}"\n   posted ${v.postDate} · views ${v.views} · likes ${v.likes} · comments ${v.comments} · shares ${v.shares} · engagement ${v.engagementPct}%`;
    }).join("\n"));
    parts.push("");
  }

  // ── Daily overview (compress to summary stats + recent 30 days raw) ──────
  const days = snapshots.overview?.days || [];
  if (days.length) {
    const recent30 = days.slice(0, 30);
    const prior30 = days.slice(30, 60);
    const sumViews = (arr: typeof days) => arr.reduce((s, d) => s + Number(d.views || 0), 0);
    const r30v = sumViews(recent30), p30v = sumViews(prior30);
    parts.push("## ACCOUNT-WIDE DAILY METRICS\n");
    parts.push(`Total ${days.length} days of data. Recent 30d: ${r30v.toLocaleString()} views. Prior 30d: ${p30v.toLocaleString()} views. Change: ${p30v ? Math.round((r30v - p30v) / p30v * 100) : 0}%.\n`);
    parts.push("Last 30 days (newest first):");
    parts.push(recent30.map((d) => `  ${d.date}: views ${d.views} | likes ${d.likes} | comments ${d.comments} | shares ${d.shares} | profile views ${d.profileViews}`).join("\n"));
    parts.push("");
  }

  // ── New vs returning viewers (last 30 days for trend detection) ──────────
  const vdays = snapshots.viewers?.days || [];
  if (vdays.length) {
    const recent = vdays.slice(0, 30);
    const avgNewPct = recent.length ? Math.round(recent.reduce((s, d) => s + Number(d.newPct || 0), 0) / recent.length) : 0;
    parts.push("## VIEWER COMPOSITION (last 30 days)\n");
    parts.push(`Average new-viewer %: ${avgNewPct}% (high = FYP serving you to fresh audiences; low = mostly existing fans).`);
    parts.push("Daily breakdown:");
    parts.push(recent.slice(0, 14).map((d) => `  ${d.date}: total ${d.total} | new ${d.new} (${d.newPct}%) | returning ${d.returning}`).join("\n"));
    parts.push("");
  }

  // ── Follower history (key milestones + recent trend) ─────────────────────
  const hist = snapshots.history?.days || [];
  if (hist.length) {
    const first = hist[hist.length - 1], last = hist[0];
    const recent30 = hist.slice(0, 30);
    const prior30 = hist.slice(30, 60);
    const gain30 = recent30.reduce((s, d) => s + Number(d.delta || 0), 0);
    const gain60 = prior30.reduce((s, d) => s + Number(d.delta || 0), 0);
    const bestDay = hist.reduce((m, d) => (Number(d.delta) || 0) > (Number(m?.delta) || 0) ? d : m, hist[0]);
    parts.push("## FOLLOWER GROWTH\n");
    parts.push(`${hist.length} days of history. Started ${first?.count} → currently ${last?.count} (+${(Number(last?.count) - Number(first?.count)).toLocaleString()}).`);
    parts.push(`Last 30d gain: +${gain30}. Prior 30d gain: +${gain60}. Best single day: +${bestDay?.delta} on ${bestDay?.date}.`);
    parts.push("");
  }

  // ── Hourly follower activity ─────────────────────────────────────────────
  const hourly = snapshots.activity?.hourly || {};
  if (Object.keys(hourly).length) {
    parts.push("## HOURLY FOLLOWER ACTIVITY (avg active fans per hour)\n");
    const hours = Array.from({ length: 24 }, (_, i) => `  ${String(i).padStart(2, "0")}:00 — ${hourly["h" + i] || 0}`);
    parts.push(hours.join("\n"));
    parts.push("");
  }

  // ── Demographics ─────────────────────────────────────────────────────────
  const g = snapshots.gender?.gender;
  if (g) {
    parts.push("## FOLLOWER GENDER");
    parts.push(`Male ${g.male}% · Female ${g.female}% · Other ${g.other}%`);
    parts.push("");
  }
  const countries = snapshots.countries?.countries || [];
  if (countries.length) {
    parts.push("## TOP FOLLOWER TERRITORIES");
    parts.push(countries.slice(0, 10).map((c) => `  ${c.code}: ${c.pct}%`).join("\n"));
    parts.push("");
  }

  return parts.join("\n");
}
