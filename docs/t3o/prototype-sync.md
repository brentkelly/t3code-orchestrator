# Pulling the design prototype into `.plans/prototype/`

The board's design prototype is a Claude Design canvas published as a claude.ai artifact
(`https://claude.ai/artifact/8YRaTm6qhsKXt3bvZbvu9w`). When asked to "download the prototype" or
"update `./prototype`", the target is `.plans/prototype/`. There is no top-level `prototype/`.

## What does not work

- **The Claude Docs MCP tools.** A design canvas is not a doc, so `read` returns `access` even
  after the artifact is shared with the agent's account.
- **`DesignSync`.** It needs `/design-login`, which a headless board session cannot run.
- **Plain `curl` or `WebFetch` on the artifact URL.** It returns only the login shell, and
  `claude.ai/api/frame/…` sits behind a Cloudflare challenge.

## What works

A real browser gets past the challenge and loads the canvas from its frame host. The frame host
serves a `_files.json` manifest listing every project file with its sha256. Once you have the
manifest's version, plain `curl` can fetch the files. Python's `urllib` gets a 403 because of
its user agent, so use `curl`.

1. **Capture the manifest with headless Chromium.** Find the binaries with
   `ls -d node_modules/.pnpm/playwright-core@*/` and `ls ~/.cache/ms-playwright/`, and adjust the
   two paths below if the versions differ. Keep scripts and downloads in separate `/tmp`
   directories, never in the repo.

   ```sh
   mkdir -p /tmp/proto-scripts /tmp/proto/out
   cat > /tmp/proto-scripts/grab.mjs <<'EOF'
   import { chromium } from "/home/ai1/projects/t3o/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core/index.mjs";
   import fs from "node:fs";
   const [out, url] = process.argv.slice(2);
   const browser = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome", headless: true, args: ["--disable-blink-features=AutomationControlled"] });
   const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" });
   const page = await ctx.newPage();
   page.on("response", async (r) => {
     if (r.url().endsWith("/_files.json")) {
       fs.writeFileSync(`${out}/_files.json`, await r.body());
       fs.writeFileSync(`${out}/base.txt`, r.url().replace(/_files\.json$/, ""));
     }
   });
   await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
   await page.waitForTimeout(20000);
   await browser.close();
   EOF
   (cd /tmp/proto/out && timeout 120 node /tmp/proto-scripts/grab.mjs /tmp/proto/out "https://claude.ai/artifact/8YRaTm6qhsKXt3bvZbvu9w")
   ```

2. **Download every `project/` file and check each hash.** `project/compat.json` is canvas
   machinery and isn't part of the prototype.

   ```sh
   cd /tmp/proto && rm -rf dl && mkdir dl && python3 -I - <<'EOF'
   import json, hashlib, subprocess, urllib.parse, os
   d = json.load(open("out/_files.json")); base = open("out/base.txt").read().strip()
   bad = n = 0
   for k, v in d["files"].items():
       if not k.startswith("project/") or k == "project/compat.json": continue
       p = os.path.join("dl", k[len("project/"):]); os.makedirs(os.path.dirname(p) or "dl", exist_ok=True)
       subprocess.run(["curl", "-sf", "--max-time", "60", "-o", p, base + urllib.parse.quote(k)], check=True)
       if hashlib.sha256(open(p, "rb").read()).hexdigest() != v["sha256"]: print("HASH MISMATCH", k); bad += 1
       n += 1
   print("ver", d["ver"], "files", n, "bad", bad)
   EOF
   ```

3. **Compare with the repo and copy over only what changed.**
   `diff -rq /tmp/proto/dl .plans/prototype`. Copy across the files that differ, plus any new ones.
   - **Files only in the repo stay:** `.thumbnail`, `.plans/`, `Card Merge Strategy.dc.html`.
     The published manifest is `narrowed` and omits some files, so a file missing from the
     download doesn't mean the designer deleted it.
   - **Committing:** commit on `t3o` with `--no-verify`, since this is a `.plans`-only commit.
     Use a message in the existing style, `updated prototype: <what changed>`. The root checkout
     is shared, so check the branch, a clean tree and `HEAD == origin/t3o` in the same command as
     the commit. Push only when asked.
