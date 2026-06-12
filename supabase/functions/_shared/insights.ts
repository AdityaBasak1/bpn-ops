// Shared prompt + context builder for video analysis insights.

export const INSIGHTS_PROMPT = `You are an expert TikTok content strategist for @thebluepodcastnetwork — a UK football podcast account with ~13K followers, growing approximately 138% year-on-year. The account does affiliate marketing for TikTok Shop UK products.

You will be given the account's analytics data for a selected time window (see "ANALYSIS WINDOW" below — it may be the last 7, 28, or 365 days):
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
3. NEXT VIDEO IDEAS: 5 specific, posting-ready video concepts grounded in what's worked. CRITICAL COMPLIANCE RULE: this is an affiliate account, so every idea MUST build the linked TikTok Shop product into the video itself — the product has to be explicitly shown (worn / held / on-screen) or verbally named during the video, and it must be the exact product that gets linked. Thematic relevance alone is NOT allowed: TikTok Shop issues "irrelevant content" violations for any linked product that is not displayed or mentioned in the video, and these strikes accumulate toward affiliate suspension. So do NOT propose pure talking-head/opinion concepts that merely relate to a product's theme — for each idea, state exactly how and when the product appears on screen or is spoken about.
4. BEST TIMING: Hour-of-day and day-of-week recommendations from the activity heatmap and daily metrics.
5. DEMOGRAPHIC INSIGHTS: What does the audience composition imply for strategy?
6. TREND WARNINGS: Compare the recent vs prior halves of the window (see ANALYSIS WINDOW for the exact day counts). Surface any declines.

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
    {"title": "the actual video title to post", "rationale": "why this will work based on data", "predictedViewRange": "e.g. '50k-100k'", "productPlacement": "the exact affiliate product to feature and how/when it is shown or named on screen, so the link is compliant (required — never leave blank)"}
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

// Build a compact prompt-friendly context string from all the studio snapshots.
// windowDays (7 | 28 | 365) limits every time-series to the most recent N days;
// trend comparisons split that window into two equal halves (capped at 30 days each).
export function buildInsightsContext(snapshots: {
  contentTop?: { videos?: Array<Record<string, unknown>> };
  overview?:   { days?:   Array<Record<string, unknown>> };
  viewers?:    { days?:   Array<Record<string, unknown>> };
  history?:    { days?:   Array<Record<string, unknown>> };
  activity?:   { hourly?: Record<string, number> };
  gender?:     { gender?: Record<string, number> };
  countries?:  { countries?: Array<Record<string, unknown>> };
}, windowDays = 365): string {
  const parts: string[] = [];
  const win = windowDays;
  const cmp = Math.min(30, Math.max(1, Math.floor(win / 2))); // each side of the trend comparison
  const listCap = Math.min(win, 30);                          // cap per-day listings to keep the prompt compact

  parts.push("## ANALYSIS WINDOW");
  parts.push(`All data below is from the account's last-${win}-day TikTok Studio export. For trend comparisons, the most recent ${cmp} days are compared against the ${cmp} days immediately before them.\n`);

  // ── Top videos (already scoped to this window's export by TikTok) ────────
  const videos = snapshots.contentTop?.videos || [];
  if (videos.length) {
    parts.push("## TOP VIDEOS (sorted by views)\n");
    parts.push(videos.map((v, i) => {
      const title = String(v.title || "").replace(/\s+/g, " ").slice(0, 200);
      return `${i + 1}. "${title}"\n   posted ${v.postDate} · views ${v.views} · likes ${v.likes} · comments ${v.comments} · shares ${v.shares} · engagement ${v.engagementPct}%`;
    }).join("\n"));
    parts.push("");
  }

  // ── Daily overview (CSVs are OLDEST-FIRST, so slice(-N) = most recent) ──
  const days = (snapshots.overview?.days || []).slice(-win);
  if (days.length) {
    const recent = days.slice(-cmp);          // most recent cmp days
    const prior = days.slice(-2 * cmp, -cmp);  // cmp days before that
    const sumViews = (arr: typeof days) => arr.reduce((s, d) => s + Number(d.views || 0), 0);
    const rv = sumViews(recent), pv = sumViews(prior);
    parts.push("## ACCOUNT-WIDE DAILY METRICS\n");
    parts.push(`${days.length} days in window. Last ${cmp}d: ${rv.toLocaleString()} views. Prior ${cmp}d: ${pv.toLocaleString()} views. Change: ${pv ? Math.round((rv - pv) / pv * 100) : 0}%.\n`);
    parts.push(`Daily breakdown (newest last, up to ${listCap} shown):`);
    parts.push(days.slice(-listCap).map((d) => `  ${d.date}: views ${d.views} | likes ${d.likes} | comments ${d.comments} | shares ${d.shares} | profile views ${d.profileViews}`).join("\n"));
    parts.push("");
  }

  // ── New vs returning viewers ─────────────────────────────────────────────
  const vdays = (snapshots.viewers?.days || []).slice(-win);
  if (vdays.length) {
    const avgNewPct = Math.round(vdays.reduce((s, d) => s + Number(d.newPct || 0), 0) / vdays.length);
    parts.push(`## VIEWER COMPOSITION (last ${win} days)\n`);
    parts.push(`Average new-viewer %: ${avgNewPct}% (high = FYP serving you to fresh audiences; low = mostly existing fans).`);
    parts.push("Daily breakdown (chronological):");
    parts.push(vdays.slice(-Math.min(vdays.length, 14)).map((d) => `  ${d.date}: total ${d.total} | new ${d.new} (${d.newPct}%) | returning ${d.returning}`).join("\n"));
    parts.push("");
  }

  // ── Follower history (key milestones + recent trend) ─────────────────────
  // history is OLDEST-FIRST: [0] = start of window, [length-1] = today
  const hist = (snapshots.history?.days || []).slice(-win);
  if (hist.length) {
    const oldest = hist[0], newest = hist[hist.length - 1];
    const recent = hist.slice(-cmp);
    const prior = hist.slice(-2 * cmp, -cmp);
    const gainR = recent.reduce((s, d) => s + Number(d.delta || 0), 0);
    const gainP = prior.reduce((s, d) => s + Number(d.delta || 0), 0);
    const bestDay = hist.reduce((m, d) => (Number(d.delta) || 0) > (Number(m?.delta) || 0) ? d : m, hist[0]);
    parts.push("## FOLLOWER GROWTH\n");
    parts.push(`${hist.length} days in window. Started at ${oldest?.count} (${oldest?.date}) → currently ${newest?.count} (${newest?.date}). Net change: ${((Number(newest?.count) || 0) - (Number(oldest?.count) || 0) >= 0 ? "+" : "")}${((Number(newest?.count) || 0) - (Number(oldest?.count) || 0)).toLocaleString()} followers over the window.`);
    parts.push(`Last ${cmp}d gain: +${gainR}. Prior ${cmp}d gain: +${gainP}. Best single day: +${bestDay?.delta} on ${bestDay?.date}.`);
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
