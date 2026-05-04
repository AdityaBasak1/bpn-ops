# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

BlueDrop Shop (`bpn-ops`) is a tool for the Blue Podcast Network team to monetise trending football moments. It surfaces hot Reddit signals, uses an LLM to suggest real products on TikTok Shop / Amazon UK, and tracks affiliate commissions. Two users share one team.

## Architecture

**Single HTML file + Supabase backend. No build step, no npm.**

- `index.html` — the entire frontend (114 KB). All state, rendering, and UI logic lives here. There is no framework; the app uses a hyperscript helper `h()` and a single `render()` function that rebuilds the DOM on every state change via `S({...})`.
- `supabase/functions/llm-suggest/` — Edge Function: server-side LLM proxy. Looks up the team's encrypted API key from `team_secrets`, calls Groq/OpenAI/Anthropic, returns 3–5 product suggestions.
- `supabase/functions/scan-signals/` — Edge Function: cron-triggered Reddit scanner. Fetches hot posts from r/soccer, r/PremierLeague, r/EFL every 30 min, scores by velocity, runs LLM on top signals, upserts `auto_signal` rows into the `bpn` table.
- `supabase/functions/_shared/llm.ts` — shared multi-provider LLM abstraction used by both functions.
- `supabase/migrations/phase1_secrets_and_cron.sql` — creates `team_secrets` table, two security-definer RPCs (`set_team_llm_secret`, `get_team_llm_status`), and the pg_cron job that fires `scan-signals` every 30 minutes.

## Key Patterns in index.html

- **State**: `let st = {...}` — one flat object. `S(patch)` merges and re-renders.
- **Rendering**: `render()` clears `app.innerHTML` and rebuilds the full DOM. `document.documentElement.dataset.theme` is set on every render for light/dark mode.
- **Theme**: CSS variables defined in `<style>` under `html{...}` (dark default) and `html[data-theme="light"]{...}`. All colours in JS inline styles use `"var(--X)"` strings.
- **Helpers**: `h(tag, props, ...children)` — hyperscript. `btn()`, `inp()`, `sel()`, `met()`, `lnk()`, `sec()` — UI component helpers.
- **Supabase credentials**: hardcoded on lines 46–47. The anon key is intentionally public (protected by RLS).
- **localStorage keys**: `bpn-cfg` (user config), `bpn-auto` (auto signals cache), `bpn-ls` (last scan time), `bpn-dark` (theme preference), `bpn-llm-key`, `bpn-llm-provider`.

## Database

All app data lives in the `bpn` table, scoped by `team_id` via RLS. The `type` column distinguishes rows: `signal`, `drop`, `promo`, `content`, `auto_signal`. Auto-signals are deleted after 48 h. LLM keys are stored in `team_secrets` (never readable by the client — only via service-role Edge Functions).

## Development

**Run locally:**
```bash
python3 -m http.server 8000
# open http://localhost:8000
```
No install step. The app fetches Supabase JS from CDN and needs internet access to function.

**Deploy edge functions:**
```bash
supabase functions deploy llm-suggest
supabase functions deploy scan-signals
```

**Apply migrations:**
```bash
supabase db push
# or paste phase1_secrets_and_cron.sql into Supabase SQL Editor
```

Required Supabase extensions (enable in Dashboard → Database → Extensions): `pg_cron`, `pg_net`, `supabase_vault`.

**After enabling extensions**, store vault secrets once in the SQL editor:
```sql
SELECT vault.create_secret('https://<project>.supabase.co', 'project_url');
SELECT vault.create_secret('<service-role-key>', 'service_role_key');
```

**Deployed site:** https://adityabasak1.github.io/bpn-ops/ (GitHub Pages, auto-deploys from `main`).

## Velocity Formula

Used in `scan-signals` to rank Reddit posts:
```
velocity = min(10, round(log2(1 + (upvotes + comments×3) / ageHours)))
```
Posts with velocity ≥ 6 get LLM enrichment.
