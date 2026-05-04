#!/usr/bin/env python3
"""
PostToolUse hook — runs after every Edit/Write.
Validates index.html in three ways:
  1. JS syntax check via `node --check`
  2. Critical symbol presence (functions, constants, CSS vars)
  3. Asset file existence for every src: reference
Exits 1 (blocking) on any error so Claude sees the failure immediately.
"""
import json, os, re, subprocess, sys, tempfile

ROOT = "/Users/adityabasak/Desktop/Dropshipping/bpn-ops"
HTML = os.path.join(ROOT, "index.html")

REQUIRED_SYMBOLS = [
    # Core rendering
    "function render(",
    "function S(",
    # Auth flow
    "function signIn(",
    "function signOut(",
    "function checkSession(",
    # App entry — roar transition must be intact
    'screen:"roar"',
    'screen:"app"',
    # Key data constants
    "const TABS=",
    "const SOURCES=",
    # Supabase init
    "supabase.createClient(",
    # Theme system
    "--accent-text",
    "--bg:",
    "data-theme",
]


def main():
    # ── Read hook context from stdin ──────────────────────────
    try:
        ctx = json.load(sys.stdin)
        path = ctx.get("tool_input", {}).get("file_path", "")
        if path and "index.html" not in path:
            # A different file was edited — nothing to validate
            sys.exit(0)
    except Exception:
        pass  # no stdin context (e.g. manual run) — validate anyway

    if not os.path.exists(HTML):
        sys.exit(0)  # not in this project

    with open(HTML, encoding="utf-8") as f:
        src = f.read()

    errors = []

    # ── 1. JS syntax check ───────────────────────────────────
    match = re.search(r"<script>(.*?)</script>", src, re.DOTALL)
    if match:
        js = match.group(1)
        with tempfile.NamedTemporaryFile(
            suffix=".js", mode="w", delete=False, encoding="utf-8"
        ) as tmp:
            tmp.write(js)
            tname = tmp.name
        result = subprocess.run(
            ["node", "--check", tname], capture_output=True, text=True
        )
        os.unlink(tname)
        if result.returncode != 0:
            msg = result.stderr.replace(tname, "index.html <script>")
            errors.append("JS syntax error:\n      " + msg.strip())
    else:
        errors.append("<script> block not found — HTML structure may be broken")

    # ── 2. Critical symbol check ──────────────────────────────
    for sym in REQUIRED_SYMBOLS:
        if sym not in src:
            errors.append(f"Critical symbol missing: {sym!r}")

    # ── 3. Asset existence check ──────────────────────────────
    for asset in re.findall(r'src:"(assets/[^"]+)"', src):
        fpath = os.path.join(ROOT, asset)
        if not os.path.exists(fpath):
            errors.append(f"Referenced asset not on disk: {asset}")

    # ── Report ────────────────────────────────────────────────
    if errors:
        print("\n🚨  WEBAPP VALIDATION FAILED — the app may be broken:\n", flush=True)
        for e in errors:
            print(f"   ✗  {e}\n", flush=True)
        print(
            "   Fix the issue above before committing or the live site will break.\n",
            flush=True,
        )
        sys.exit(2)  # exit 2 = block Claude from continuing
    else:
        line_count = src.count("\n")
        print(
            f"✅  index.html OK  "
            f"({line_count} lines · JS syntax valid · {len(REQUIRED_SYMBOLS)} symbols present · assets OK)",
            flush=True,
        )


main()
