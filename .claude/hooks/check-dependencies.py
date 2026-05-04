#!/usr/bin/env python3
"""
PostToolUse hook — dependency integrity checks for index.html.
Runs after every Edit/Write, complements validate-app.py (which does syntax).

Checks:
  DATABASE  1. Supabase table names match known migrations
            2. RPC names match known migrations
            3. Edge function names have matching folders on disk
            4. Credentials are real values, not placeholders

  HOSTING   5. No absolute asset paths (breaks GitHub Pages subpath)
            6. No http:// URLs (mixed content on HTTPS host)
            7. No localhost/127.0.0.1 references
            8. CDN script tags still present
            9. Required meta tags still present

  CSS/JS   10. CSS variable parity: dark theme vars == light theme vars
           11. Every var(--X) used in JS is defined in CSS
           12. Every className:"X" used in JS has a CSS rule
           13. localStorage keys are consistent (no orphaned reads/writes)

Exit 0 = all clear
Exit 1 = warnings only (printed but not blocking)
Exit 2 = errors found (blocks Claude)
"""
import json, os, re, sys

ROOT = "/Users/adityabasak/Desktop/Dropshipping/bpn-ops"
HTML = os.path.join(ROOT, "index.html")
FUNCTIONS_DIR = os.path.join(ROOT, "supabase", "functions")

# ── Ground-truth sets from migrations ───────────────────────────────────────
KNOWN_TABLES = {"bpn", "teams", "team_members", "team_secrets"}
KNOWN_RPCS   = {"get_team_llm_status", "set_team_llm_secret"}


def main():
    # Only run when index.html is touched
    try:
        ctx  = json.load(sys.stdin)
        path = ctx.get("tool_input", {}).get("file_path", "")
        if path and "index.html" not in path:
            sys.exit(0)
    except Exception:
        pass

    if not os.path.exists(HTML):
        sys.exit(0)

    with open(HTML, encoding="utf-8") as f:
        src = f.read()

    # Split into style and script regions for targeted checks
    style_m  = re.search(r"<style>(.*?)</style>", src, re.DOTALL)
    script_m = re.search(r"<script>(.*?)</script>", src, re.DOTALL)
    style    = style_m.group(1)  if style_m  else ""
    script   = script_m.group(1) if script_m else ""

    errors   = []   # exit 2
    warnings = []   # exit 1 (non-blocking)

    # ── 1. Table names ───────────────────────────────────────────────────────
    used_tables = set(re.findall(r'sb\.from\("([^"]+)"', script))
    unknown_tables = used_tables - KNOWN_TABLES
    for t in sorted(unknown_tables):
        errors.append(f"[DB] Unknown table: sb.from(\"{t}\") — not in migrations")

    # ── 2. RPC names ─────────────────────────────────────────────────────────
    used_rpcs = set(re.findall(r'sb\.rpc\("([^"]+)"', script))
    unknown_rpcs = used_rpcs - KNOWN_RPCS
    for r in sorted(unknown_rpcs):
        errors.append(f"[DB] Unknown RPC: sb.rpc(\"{r}\") — not in migrations")

    # ── 3. Edge function folders ─────────────────────────────────────────────
    used_fns = set(re.findall(r'/functions/v1/([a-zA-Z0-9_-]+)', src))
    for fn in sorted(used_fns):
        fn_dir = os.path.join(FUNCTIONS_DIR, fn)
        if not os.path.isdir(fn_dir):
            warnings.append(
                f"[DB] Edge function referenced but folder missing: "
                f"supabase/functions/{fn}/ (deploy or create it)"
            )

    # ── 4. Credential format ─────────────────────────────────────────────────
    url_m = re.search(r'const SUPABASE_URL\s*=\s*"([^"]*)"', src)
    key_m = re.search(r'const SUPABASE_KEY\s*=\s*"([^"]*)"', src)
    if url_m:
        url_val = url_m.group(1)
        if not re.match(r'https://[a-z0-9]+\.supabase\.co$', url_val):
            errors.append(
                f"[DB] SUPABASE_URL looks invalid or is a placeholder: \"{url_val}\""
            )
    if key_m:
        key_val = key_m.group(1)
        if not key_val.startswith("eyJ"):
            errors.append(
                f"[DB] SUPABASE_KEY is not a valid JWT (should start with 'eyJ')"
            )

    # ── 5. Absolute asset paths ──────────────────────────────────────────────
    abs_srcs = re.findall(r'src:"(/[^"]+)"', script)
    for p in abs_srcs:
        errors.append(
            f"[HOST] Absolute asset path will break on GitHub Pages subpath: src:\"{p}\""
        )

    # ── 6. Insecure HTTP URLs ────────────────────────────────────────────────
    # Allow https://, skip data: and relative URLs; flag bare http://
    http_hits = re.findall(r'["\s](http://[^\s"\'<>]+)', src)
    for h in http_hits:
        errors.append(f"[HOST] Insecure http:// URL (mixed content on HTTPS): {h.strip()}")

    # ── 7. Localhost references ───────────────────────────────────────────────
    for pattern in ("localhost", "127.0.0.1"):
        if pattern in src:
            errors.append(f"[HOST] Development URL found in production code: \"{pattern}\"")

    # ── 8. CDN scripts ───────────────────────────────────────────────────────
    if "cdn.jsdelivr.net/npm/@supabase/supabase-js@2" not in src:
        errors.append("[HOST] Supabase CDN script tag missing — app will not initialise")
    if "fonts.googleapis.com" not in src:
        warnings.append("[HOST] Google Fonts link missing — UI fonts will fall back to system fonts")

    # ── 9. Meta tags ─────────────────────────────────────────────────────────
    if 'name="viewport"' not in src:
        errors.append("[HOST] <meta name=\"viewport\"> missing — mobile layout will break")
    if 'name="apple-mobile-web-app-capable"' not in src:
        warnings.append("[HOST] apple-mobile-web-app-capable meta missing — PWA behaviour affected")

    # ── 10. CSS variable parity (dark ↔ light) ───────────────────────────────
    dark_block  = re.search(r'html\{([^}]+)\}', style)
    light_block = re.search(r'html\[data-theme="light"\]\{([^}]+)\}', style)
    if dark_block and light_block:
        dark_vars  = set(re.findall(r'--([a-zA-Z0-9-]+):', dark_block.group(1)))
        light_vars = set(re.findall(r'--([a-zA-Z0-9-]+):', light_block.group(1)))
        for v in sorted(dark_vars - light_vars):
            errors.append(
                f"[CSS] --{v} defined in dark theme but missing from light theme "
                f"(will be invisible/wrong in light mode)"
            )
        for v in sorted(light_vars - dark_vars):
            warnings.append(
                f"[CSS] --{v} defined in light theme but missing from dark theme"
            )
    else:
        warnings.append("[CSS] Could not parse dark/light theme blocks for variable parity check")

    # ── 11. CSS variable completeness ────────────────────────────────────────
    all_vars_defined = set(re.findall(r'--([a-zA-Z0-9-]+):', style))
    all_vars_used    = set(re.findall(r'var\(--([a-zA-Z0-9-]+)\)', script))
    for v in sorted(all_vars_used - all_vars_defined):
        errors.append(
            f"[CSS] var(--{v}) used in JS inline styles but --{v} not defined in <style> "
            f"(renders as empty/transparent)"
        )

    # ── 12. CSS class completeness ───────────────────────────────────────────
    classes_defined = set(re.findall(r'\.([a-zA-Z][a-zA-Z0-9-]*)[\s{,:]', style))
    raw_classnames  = re.findall(r'className:"([^"]+)"', script)
    classes_used    = set()
    for cn in raw_classnames:
        classes_used.update(cn.split())  # handle multi-class strings
    # Classes provided by CDN stylesheets (Phosphor Icons, etc.) — not in local <style>
    CDN_CLASS_PREFIXES = ("ph", "ph-fill", "ti", "lucide")
    for c in sorted(classes_used - classes_defined):
        if any(c == p or c.startswith(p + "-") for p in CDN_CLASS_PREFIXES):
            continue  # provided by CDN stylesheet, not a local rule
        warnings.append(
            f"[CSS] className:\"{c}\" used in JS but .{c} has no CSS rule (unstyled element)"
        )

    # ── 13. localStorage key consistency ─────────────────────────────────────
    ls_gets = set(re.findall(r'localStorage\.getItem\("([^"]+)"', src))
    ls_sets = set(re.findall(r'localStorage\.setItem\("([^"]+)"', src))
    for k in sorted(ls_sets - ls_gets):
        warnings.append(
            f"[STORE] localStorage key \"{k}\" is written but never read — possible typo"
        )
    for k in sorted(ls_gets - ls_sets):
        warnings.append(
            f"[STORE] localStorage key \"{k}\" is read but never written — "
            f"may rely on external write or be an orphan"
        )

    # ── Report ────────────────────────────────────────────────────────────────
    has_errors   = bool(errors)
    has_warnings = bool(warnings)

    if has_warnings:
        print("\n⚠️   DEPENDENCY WARNINGS:\n", flush=True)
        for w in warnings:
            print(f"   ⚠  {w}", flush=True)

    if has_errors:
        print("\n🚨  DEPENDENCY ERRORS — these will break the live app:\n", flush=True)
        for e in errors:
            print(f"   ✗  {e}", flush=True)
        print(flush=True)
        sys.exit(2)
    elif has_warnings:
        print(
            "\n   ✅  No blocking dependency errors "
            "(resolve warnings above when possible)\n",
            flush=True,
        )
        sys.exit(1)
    else:
        print(
            "✅  Dependencies OK  "
            f"(tables:{len(used_tables)} rpcs:{len(used_rpcs)} "
            f"fns:{len(used_fns)} css-vars:{len(all_vars_used)} "
            f"classes:{len(classes_used)} ls-keys:{len(ls_gets|ls_sets)})",
            flush=True,
        )


main()
