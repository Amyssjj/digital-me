# STATE-LOG — digital-me-os health sweep

> Append-only. One block per run (written by the motus-sweep controller).
> Enrolled 2026-07-02 (engine-extraction roadmap Phase 0 — first repo on the
> canonical `health-sweep/` convention). Engine: `~/.agents/skills/motus-sweep`
> (global single-source); this dir carries only profiles + evidence.
> First capture pending: serve the dashboard (port 3458), drive the capture
> per profile.captureSelectors, then `motus-sweep run visual` and lock
> baseline.json at the first honest green.

## 2026-07-02T21:06:56.362Z · docs · 32e9a15
- **gates:** 🔴 1 (F1 1 · F2 0 · F3 0)
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** ⏳ pending (LLM C1/C2/C3) · **stories:** ⏳
- **EXIT:** 🔁 loop — fix reds, re-run
- **reds:**
  - `F1/path` README.md:111 (README.md path) — path claim doesn't resolve — `packages/cli/dist/bin/digital-me.js` (truth: filesystem (repo root)) [got missing, want packages/cli/dist/bin/digital-me.js exists in repo]

## 2026-07-02T21:09:18.349Z · docs · 32e9a15
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** ⏳ pending (LLM C1/C2/C3) · **stories:** ⏳
- **EXIT:** 🔁 loop — fix reds, re-run
- **note:** override recorded: dist path is journey-conditional (README says build first)

## 2026-07-02T21:20:34.712Z · docs · cc86f09
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** ⏳ pending (LLM C1/C2/C3) · **stories:** ⏳
- **EXIT:** 🔁 loop — fix reds, re-run
- **note:** scoped artifacts migration — first per-profile baseline lock next

## 2026-07-02T21:20:47.767Z · docs · cc86f09
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** ⏳ pending (LLM C1/C2/C3) · **stories:** ⏳
- **EXIT:** 🔁 loop — fix reds, re-run
- **note:** baseline-docs locked at green

## 2026-07-02T21:27:33.889Z · update · e366b72
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** ⏳ pending (LLM C1/C2/C3) · **stories:** ⏳
- **EXIT:** 🔁 loop — fix reds, re-run

## 2026-07-02T21:27:53.608Z · update · e366b72
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** ⏳ pending (LLM C1/C2/C3) · **stories:** ⏳
- **EXIT:** 🔁 loop — fix reds, re-run
- **note:** baseline-update locked at 0 findings

## 2026-07-02T21:30:05.947Z · update · e366b72
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP
- **note:** critiques:none — update profile has no LLM lane; exit codes now hook-trustworthy

## 2026-07-03T17:41:47.645Z · web · 34df99c
- **gates:** 🔴 7 (G1 0 · G2 6 · G3 1)
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** ⏳ pending (LLM C1/C2/C3) · **stories:** ⏳
- **EXIT:** 🔁 loop — fix reds, re-run
- **reds:**
  - `G2/text-contrast` h1 (/ light) — text contrast 1.18:1 below AA (20px) [got 1.18:1, want ≥4.5:1]
  - `G2/text-contrast` nav button (/ light) — text contrast 1.18:1 below AA (14px) [got 1.18:1, want ≥4.5:1]
  - `G2/text-contrast` body (/ light) — text contrast 1.43:1 below AA (16px) [got 1.43:1, want ≥4.5:1]
  - `G2/text-contrast` h1 (/ light) — text contrast 1.18:1 below AA (20px) [got 1.18:1, want ≥4.5:1]
  - `G2/text-contrast` nav button (/ light) — text contrast 1.18:1 below AA (14px) [got 1.18:1, want ≥4.5:1]
  - `G2/text-contrast` body (/ light) — text contrast 1.43:1 below AA (16px) [got 1.43:1, want ≥4.5:1]
  - `G3/no-overflow` / (/ light) — horizontal overflow 209px [got 584px, want ≤375px]
- **note:** first real dashboard capture (preview-driven, 2 cells)

## 2026-07-03T17:44:05.151Z · web · 34df99c
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** ⏳ pending (LLM C1/C2/C3) · **stories:** ⏳
- **EXIT:** 🔁 loop — fix reds, re-run
- **note:** mobile overflow fixed in App.tsx (contained nav scroll); gradient-contrast overrides recorded

## 2026-07-03T17:44:27.147Z · web · 34df99c
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** ⏳ pending (LLM C1/C2/C3) · **stories:** ⏳
- **EXIT:** 🔁 loop — fix reds, re-run
- **note:** baseline-web locked at green

## 2026-07-03T18:06:02.040Z · docs · 543d7a7
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** ⏳ pending (LLM C1/C2/C3) · **stories:** ⏳
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** 🔁 loop — fix reds, re-run
- **note:** candidate lane enabled — first shadow run (facts/claimkey-substring-overlap)

## 2026-07-03T19:49:58.487Z · runtime · 1bb6c4e
- **gates:** 🔴 3 (R1 0 · R2 3)
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** 🔁 loop — fix reds, re-run
- **reds:**
  - `R2/pin` openclaw-brain-plugin-entry (runtime openclaw) — installed artifact "openclaw-brain-plugin-entry" has drifted from its repo source — $HOME/.openclaw/extensions/digital-me-brain/index.mjs no longer matches packages/runtimes/openclaw/templates/brain/index.mjs [got sha256 33a09f1dd877… ≠ source 633bd5202dfb…, want installed $HOME/.openclaw/extensions/digital-me-brain/index.mjs byte-identical to packages/runtimes/openclaw/templates/brain/index.mjs]
  - `R2/pin` openclaw-recall-plugin-entry (runtime openclaw) — installed artifact "openclaw-recall-plugin-entry" has drifted from its repo source — $HOME/.openclaw/extensions/digital-me-recall/index.mjs no longer matches packages/runtimes/openclaw/templates/recall/index.mjs [got sha256 d938d76ca8f8… ≠ source b746d09e0817…, want installed $HOME/.openclaw/extensions/digital-me-recall/index.mjs byte-identical to packages/runtimes/openclaw/templates/recall/index.mjs]
  - `R2/pin` claude-code-memory-inject-hook (runtime claude-code) — installed artifact "claude-code-memory-inject-hook" has drifted from its repo source — $HOME/.claude/hooks/dm_memory_search_inject.sh no longer matches packages/runtimes/claude-code/hooks/dm_memory_search_inject.sh [got sha256 f1fee2ec129c… ≠ source 7243e20630f3…, want installed $HOME/.claude/hooks/dm_memory_search_inject.sh byte-identical to packages/runtimes/claude-code/hooks/dm_memory_search_inject.sh]
- **note:** first real motus-runtime-sweep run — enrollment

## 2026-07-03T19:52:43.140Z · runtime · 1bb6c4e
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP
- **note:** triage applied: 2 openclaw pins intentional (live hotfix bundle, reconcile-at-next-install), claude-code hook re-installed from repo source

## 2026-07-03T19:53:41.498Z · runtime · 1bb6c4e
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP
- **note:** baseline-runtime locked at green

## 2026-07-03T20:03:52.457Z · data · d74c3ad
- **gates:** 🔴 3 (D1 2 · D2 1 · D3 0) · 🟡 2 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** 🔁 loop — fix reds, re-run
- **reds:**
  - `D1/zero` dashboard-taste-created-2d (http-json metric) — "dashboard-taste-created-2d" shows 0 while the primary source has 1 — a dead/lagging pipeline rendering as calm [got surface 0, want ≈ 1 (truth: cmd python3 health-sweep/bin/count-fm-created.py --root ~/digital-me/tastes --since-days-utc 2)]
  - `D1/zero` digest-wiki-new (digest-staging metric) — "digest-wiki-new" shows 0 while the primary source has 29 — a dead/lagging pipeline rendering as calm [got surface 0, want ≈ 29 (truth: cmd python3 health-sweep/bin/count-fm-created.py --root ~/digital-me/wiki --date $(date -v-1d +%F))]
  - `D2/parity` dashboard-taste-created-7d (http-json metric) — "dashboard-taste-created-7d" drifts from its primary source by -1 (beyond tolerance 0) [got surface 5, want 6 ±0 (truth: cmd python3 health-sweep/bin/count-fm-created.py --root ~/digital-me/tastes --since-days-utc 7)]
- **note:** FIRST real capture — must flag the 2026-07-03 live incident pair

## 2026-07-03T20:12:35.992Z · data · d74c3ad
- **gates:** 🟢 all green · 🟡 2 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP
- **note:** verification run — intake+digest fixes, surface = locally-served fixed build (scratch DB copy + fixed scan) on :3999; live :3458 still needs deploy

## 2026-07-03T20:43:32.511Z · data · 8b51565
- **gates:** 🔴 2 (D1 1 · D2 1 · D3 0) · 🟡 2 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🔴 worse
- **critiques:** — (no critique lane for this profile)
- **EXIT:** 🔁 loop — fix reds, re-run
- **reds:**
  - `D1/zero` dashboard-taste-created-2d (http-json metric) — "dashboard-taste-created-2d" shows 0 while the primary source has 1 — a dead/lagging pipeline rendering as calm [got surface 0, want ≈ 1 (truth: cmd python3 health-sweep/bin/count-fm-created.py --root ~/digital-me/tastes --since-days-utc 2)]
  - `D2/parity` dashboard-taste-created-7d (http-json metric) — "dashboard-taste-created-7d" drifts from its primary source by -1 (beyond tolerance 0) [got surface 5, want 6 ±0 (truth: cmd python3 health-sweep/bin/count-fm-created.py --root ~/digital-me/tastes --since-days-utc 7)]
- **note:** post-merge live verification — PR #44 deployed via pull, intake re-scanned

## 2026-07-03T20:44:55.621Z · data · 8b51565
- **gates:** 🟢 all green · 🟡 2 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP
- **note:** post-merge live verification take 2 — after fixed-code intake tick

## 2026-07-04T10:30:33.934Z · data · 8b51565
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-04T10:30:34.046Z · docs · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** ⏳ pending (LLM C1/C2/C3) · **stories:** ⏳
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** 🔁 loop — fix reds, re-run

## 2026-07-04T10:30:34.261Z · runtime · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-04T10:30:34.413Z · update · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-05T10:30:35.801Z · data · 8b51565
- **gates:** 🟢 all green · 🟡 2 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-05T10:30:35.911Z · docs · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** ⏳ pending (LLM C1/C2/C3) · **stories:** ⏳
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** 🔁 loop — fix reds, re-run

## 2026-07-05T10:30:36.134Z · runtime · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-05T10:30:36.286Z · update · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-06T10:30:02.739Z · data · 8b51565
- **gates:** 🔴 1 (D1 1 · D2 0 · D3 0) · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🔴 worse
- **critiques:** — (no critique lane for this profile)
- **EXIT:** 🔁 loop — fix reds, re-run
- **reds:**
  - `D1/zero` digest-taste-present (digest-staging metric) — "digest-taste-present" shows 0 while the primary source has 1 — a dead/lagging pipeline rendering as calm [got surface 0, want ≈ 1 (truth: cmd python3 health-sweep/bin/count-fm-created.py --root ~/digital-me/tastes --date $(date -v-1d +%F))]

## 2026-07-06T10:30:02.851Z · docs · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** ⏳ pending (LLM C1/C2/C3) · **stories:** ⏳
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** 🔁 loop — fix reds, re-run

## 2026-07-06T10:30:03.084Z · runtime · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-06T10:30:03.233Z · update · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-07T10:30:12.240Z · data · 8b51565
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-07T10:30:12.352Z · docs · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** ⏳ pending (LLM C1/C2/C3) · **stories:** ⏳
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** 🔁 loop — fix reds, re-run

## 2026-07-07T10:30:12.581Z · runtime · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-07T10:30:12.735Z · update · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-08T10:30:19.106Z · data · 8b51565
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-08T10:30:19.218Z · docs · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** ⏳ pending (LLM C1/C2/C3) · **stories:** ⏳
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** 🔁 loop — fix reds, re-run

## 2026-07-08T10:30:19.432Z · runtime · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-08T10:30:19.584Z · update · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-09T10:30:26.639Z · data · 8b51565
- **gates:** 🟢 all green · 🟡 2 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-09T10:30:26.751Z · docs · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** ⏳ pending (LLM C1/C2/C3) · **stories:** ⏳
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** 🔁 loop — fix reds, re-run

## 2026-07-09T10:30:26.966Z · runtime · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-09T10:30:27.116Z · update · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-09T23:03:13.074Z · data · 8b51565
- **gates:** 🟢 all green · 🟡 2 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-09T23:03:13.186Z · docs · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** ⏳ pending (LLM C1/C2/C3) · **stories:** ⏳
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** 🔁 loop — fix reds, re-run

## 2026-07-09T23:03:13.450Z · runtime · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-09T23:03:13.601Z · update · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-09T23:08:16.578Z · web · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** ⏳ pending (LLM C1/C2/C3) · **stories:** ⏳
- **EXIT:** 🔁 loop — fix reds, re-run

## 2026-07-09T23:09:28.234Z · data · 8b51565
- **gates:** 🟢 all green · 🟡 2 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-09T23:09:28.342Z · docs · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-09T23:09:28.559Z · runtime · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-09T23:09:28.708Z · update · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-09T23:09:28.756Z · web · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-09T23:09:38.919Z · data · 8b51565
- **gates:** 🟢 all green · 🟡 2 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-09T23:09:39.028Z · docs · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-09T23:09:39.236Z · runtime · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-09T23:09:39.386Z · update · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-09T23:09:39.433Z · web · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-09T23:23:36.688Z · runtime · ecda974
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-09T23:24:46.130Z · runtime · ecda974
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-09T23:24:59.655Z · data · ecda974
- **gates:** 🟢 all green · 🟡 2 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-09T23:24:59.763Z · docs · ecda974
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-09T23:24:59.972Z · runtime · ecda974
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-09T23:25:00.126Z · update · ecda974
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-09T23:25:18.082Z · data · ecda974
- **gates:** 🟢 all green · 🟡 2 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-09T23:25:18.190Z · docs · ecda974
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-09T23:25:18.395Z · runtime · ecda974
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-09T23:25:18.545Z · update · ecda974
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-09T23:25:18.594Z · web · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-10T10:30:06.384Z · data · 8f578d9
- **gates:** 🔴 1 (D1 1 · D2 0 · D3 0) · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🔴 worse
- **critiques:** — (no critique lane for this profile)
- **EXIT:** 🔁 loop — fix reds, re-run
- **reds:**
  - `D1/zero` digest-taste-present (digest-staging metric) — "digest-taste-present" shows 0 while the primary source has 1 — a dead/lagging pipeline rendering as calm [got surface 0, want ≈ 1 (truth: cmd python3 health-sweep/bin/count-fm-created.py --root ~/digital-me/tastes --date $(date -v-1d +%F))]

## 2026-07-10T10:30:06.498Z · docs · 8f578d9
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-10T10:30:06.713Z · runtime · 8f578d9
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-10T10:30:06.863Z · update · 8f578d9
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-10T10:30:06.912Z · web · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-10T16:25:02.844Z · update · 8f578d9
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-10T16:27:41.722Z · data · 8f578d9
- **gates:** 🔴 1 (D1 1 · D2 0 · D3 0) · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🔴 worse
- **critiques:** — (no critique lane for this profile)
- **EXIT:** 🔁 loop — fix reds, re-run
- **reds:**
  - `D1/zero` digest-taste-present (digest-staging metric) — "digest-taste-present" shows 0 while the primary source has 1 — a dead/lagging pipeline rendering as calm [got surface 0, want ≈ 1 (truth: cmd python3 health-sweep/bin/count-fm-created.py --root ~/digital-me/tastes --date $(date -v-1d +%F))]

## 2026-07-10T16:27:41.837Z · docs · 8f578d9
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-10T16:27:42.304Z · runtime · 8f578d9
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-10T16:27:42.470Z · update · 8f578d9
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-10T16:27:42.522Z · web · 8b51565
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-10T16:32:12.187Z · data · 8f578d9
- **gates:** 🔴 1 (D1 1 · D2 0 · D3 0) · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🔴 worse
- **critiques:** — (no critique lane for this profile)
- **EXIT:** 🔁 loop — fix reds, re-run
- **reds:**
  - `D1/zero` digest-taste-present (digest-staging metric) — "digest-taste-present" shows 0 while the primary source has 1 — a dead/lagging pipeline rendering as calm [got surface 0, want ≈ 1 (truth: cmd python3 health-sweep/bin/count-fm-created.py --root ~/digital-me/tastes --date $(date -v-1d +%F))]


## 2026-07-10T16:32:54.638Z · data · 8f578d9
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-10T16:50:12.272Z · data · 1c4ba75
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP
## 2026-07-10T17:08:14.335Z · web · 1c4ba75
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-10T17:08:31.168Z · web · 1c4ba75
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-12T16:06:51.804Z · ops · 0bfd619
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-12T16:07:14.652Z · ops · 0bfd619
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP
## 2026-07-10T17:35:58.722Z · data · 03dd2b5
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-10T17:35:58.840Z · docs · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-10T17:35:59.083Z · runtime · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-10T17:35:59.248Z · update · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-10T17:36:01.715Z · web · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-11T10:30:05.643Z · data · 03dd2b5
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-11T10:30:05.756Z · docs · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-11T10:30:05.971Z · runtime · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-11T10:30:06.122Z · update · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-11T10:30:08.530Z · web · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-11T21:33:49.550Z · data · 03dd2b5
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-11T21:33:49.663Z · docs · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-11T21:33:49.881Z · runtime · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-11T21:33:50.031Z · update · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-11T21:33:52.072Z · web · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-11T21:59:00.314Z · data · 03dd2b5
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-11T21:59:00.449Z · docs · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-11T21:59:00.673Z · runtime · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-11T21:59:00.829Z · update · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-11T21:59:02.569Z · web · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-12T10:30:04.318Z · data · 03dd2b5
- **gates:** 🟢 all green · 🟡 2 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-12T10:30:04.435Z · docs · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-12T10:30:04.654Z · runtime · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-12T10:30:04.806Z · update · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-12T10:30:06.813Z · web · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-12T16:06:26.173Z · data · 03dd2b5
- **gates:** 🟢 all green · 🟡 2 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-12T16:06:26.303Z · docs · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-12T16:06:26.595Z · runtime · 03dd2b5
- **gates:** 🔴 1 (R1 1 · R2 0) · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🔴 worse
- **critiques:** — (no critique lane for this profile)
- **EXIT:** 🔁 loop — fix reds, re-run
- **reds:**
  - `R1/participation` m1-application-rate (runtime all) — runtime check "m1-application-rate" [all] — `python3 scripts/verify_m1_application.py --days 7` exit 1 · tail: UNHEALTHY: codex [got exit 1, want exit 0]

## 2026-07-12T16:06:26.746Z · update · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-12T16:06:29.257Z · web · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-12T16:09:10.080Z · data · 03dd2b5
- **gates:** 🟢 all green · 🟡 2 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-12T16:09:10.192Z · docs · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-12T16:09:10.417Z · runtime · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-12T16:09:10.568Z · update · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-12T16:09:12.672Z · web · 03dd2b5
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-12T16:31:27.674Z · data · 313a201
- **gates:** 🟢 all green · 🟡 2 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-12T16:31:27.800Z · docs · 313a201
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-12T16:31:27.977Z · ops · 313a201
- **gates:** 🔴 1 (O1 1 · O2 0 · O3 0)
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** 🔁 loop — fix reds, re-run
- **reds:**
  - `O1/schedule-failed` 94c103ae-f4b8-44d5-bf5d-fc3fed1ecfcb (scheduler engine-roadmap-session) — schedule "engine-roadmap-session" last run failed [got failed (26h ago, streak 6), want completed]

## 2026-07-12T16:31:28.284Z · runtime · 313a201
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-12T16:31:28.450Z · update · 313a201
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-12T16:31:30.721Z · web · 313a201
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-12T16:33:21.412Z · ops · 313a201
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-13T10:30:06.575Z · data · f2b7568
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-13T10:30:06.687Z · docs · f2b7568
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-13T10:30:06.859Z · ops · f2b7568
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-13T10:30:07.078Z · runtime · f2b7568
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-13T10:30:07.229Z · update · f2b7568
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-13T10:30:09.889Z · web · f2b7568
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-14T10:30:15.812Z · data · 62b2843
- **gates:** 🟢 all green · 🟡 2 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-14T10:30:15.927Z · docs · 62b2843
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-14T10:30:16.288Z · ops · 62b2843
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-14T10:30:16.509Z · runtime · 62b2843
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-14T10:30:16.660Z · update · 62b2843
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-14T10:30:22.934Z · web · 62b2843
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-15T10:30:17.255Z · data · 62b2843
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-15T10:30:17.371Z · docs · 62b2843
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-15T10:30:17.539Z · ops · 62b2843
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-15T10:30:17.764Z · runtime · 62b2843
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-15T10:30:17.915Z · update · 62b2843
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-15T10:30:24.024Z · web · 62b2843
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-16T10:30:22.989Z · data · 62b2843
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-16T10:30:23.129Z · docs · 62b2843
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-16T10:30:23.355Z · ops · 62b2843
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-16T10:30:23.642Z · runtime · 62b2843
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-16T10:30:23.837Z · update · 62b2843
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-16T10:30:26.866Z · web · 62b2843
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-17T10:30:03.002Z · data · 20d5d41
- **gates:** 🟢 all green · 🟡 2 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-17T10:30:03.115Z · docs · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-17T10:30:03.288Z · ops · 20d5d41
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-17T10:30:03.516Z · runtime · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-17T10:30:03.666Z · update · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-17T10:30:09.332Z · web · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-18T19:13:37.963Z · data · 20d5d41
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-18T19:13:38.111Z · docs · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-18T19:13:38.318Z · ops · 20d5d41
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-18T19:13:38.627Z · runtime · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-18T19:13:39.070Z · update · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-18T19:13:41.371Z · web · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-19T10:30:03.748Z · data · 20d5d41
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-19T10:30:03.862Z · docs · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-19T10:30:04.032Z · ops · 20d5d41
- **gates:** 🟢 all green · 🟡 2 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-19T10:30:04.258Z · runtime · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-19T10:30:04.407Z · update · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-19T10:30:06.373Z · web · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-20T10:30:16.759Z · data · 20d5d41
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-20T10:30:16.872Z · docs · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-20T10:30:17.053Z · ops · 20d5d41
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-20T10:30:17.281Z · runtime · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-20T10:30:17.432Z · update · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-20T10:30:19.060Z · web · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-21T10:30:03.773Z · data · 20d5d41
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-21T10:30:03.885Z · docs · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-21T10:30:04.061Z · ops · 20d5d41
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-21T10:30:04.288Z · runtime · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-21T10:30:04.437Z · update · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-21T10:30:10.299Z · web · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-22T10:30:04.039Z · data · 20d5d41
- **gates:** 🟢 all green · 🟡 2 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-22T10:30:04.153Z · docs · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-22T10:30:04.323Z · ops · 20d5d41
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-22T10:30:04.553Z · runtime · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-22T10:30:04.705Z · update · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-22T10:30:11.233Z · web · 20d5d41
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-23T10:30:14.981Z · data · 4d75ca8
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-23T10:30:15.093Z · docs · 4d75ca8
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-23T10:30:15.280Z · ops · 4d75ca8
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-23T10:30:15.511Z · runtime · 4d75ca8
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-23T10:30:15.660Z · update · 4d75ca8
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-23T10:30:21.316Z · web · 4d75ca8
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-07-24T14:13:37.082Z · data · 4d75ca8
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-24T14:13:37.210Z · docs · 4d75ca8
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-07-24T14:13:37.384Z · ops · 4d75ca8
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-24T14:13:37.684Z · runtime · 4d75ca8
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-24T14:13:37.895Z · update · 4d75ca8
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-07-24T14:13:40.944Z · web · 4d75ca8
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-08-14T01:38:21.844Z · data · 4d75ca8
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-08-14T01:38:22.070Z · docs · 4d75ca8
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-08-14T01:38:22.496Z · ops · 4d75ca8
- **gates:** 🔴 2 (O1 0 · O2 0 · O3 2) · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** 🔁 loop — fix reds, re-run
- **reds:**
  - `O3/source-quiet` digests (sources quiet) — source "digests" went quiet — producer dead or store migrated (consumers may be silently reporting zero) [got no artifact in 48h (cadence 24h), want ≥1 file newer than 48h under /Users/jingshi/digital-me/digests]
  - `O3/source-quiet` dream-cycle-logs (sources quiet) — source "dream-cycle-logs" went quiet — producer dead or store migrated (consumers may be silently reporting zero) [got no artifact in 48h (cadence 24h), want ≥1 file newer than 48h under /Users/jingshi/digital-me/dream_cycle/logs]

## 2026-08-14T01:38:22.889Z · runtime · 4d75ca8
- **gates:** 🔴 1 (R1 1 · R2 0) · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🔴 worse
- **critiques:** — (no critique lane for this profile)
- **EXIT:** 🔁 loop — fix reds, re-run
- **reds:**
  - `R1/participation` m1-application-rate (runtime all) — runtime check "m1-application-rate" [all] — `python3 scripts/verify_m1_application.py --days 7` exit 1 · tail: UNHEALTHY: openclaw [got exit 1, want exit 0]

## 2026-08-14T01:38:23.137Z · update · 4d75ca8
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-08-14T01:38:31.417Z · web · 4d75ca8
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-08-14T10:30:09.291Z · data · 31a4b84
- **gates:** 🟢 all green · 🟡 2 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-08-14T10:30:09.402Z · docs · 31a4b84
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-08-14T10:30:09.576Z · ops · 31a4b84
- **gates:** 🔴 2 (O1 2 · O2 0 · O3 0)
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** 🔁 loop — fix reds, re-run
- **reds:**
  - `O1/schedule-failed` 8cdf3c6a-8ffd-4003-9f13-7bc125a879ba (scheduler dream-cycle-nightly) — schedule "dream-cycle-nightly" last run failed [got failed (1h ago, streak 2), want completed]
  - `O1/schedule-failed` 1186b0bf-0d5b-4cd1-9805-5a0e5a7e8b40 (scheduler daily-activity-digest) — schedule "daily-activity-digest" last run failed [got failed (9h ago, streak 1), want completed]

## 2026-08-14T10:30:09.806Z · runtime · 31a4b84
- **gates:** 🔴 1 (R1 1 · R2 0) · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🔴 worse
- **critiques:** — (no critique lane for this profile)
- **EXIT:** 🔁 loop — fix reds, re-run
- **reds:**
  - `R1/participation` m1-application-rate (runtime all) — runtime check "m1-application-rate" [all] — `python3 scripts/verify_m1_application.py --days 7` exit 1 · tail: UNHEALTHY: openclaw [got exit 1, want exit 0]

## 2026-08-14T10:30:09.955Z · update · 31a4b84
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-08-14T10:30:12.913Z · web · 31a4b84
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP

## 2026-08-15T10:30:11.738Z · data · 31a4b84
- **gates:** 🟢 all green · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-08-15T10:30:11.851Z · docs · 31a4b84
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **candidates:** facts/claimkey-substring-overlap [candidate] 🟢 quiet
- **EXIT:** ✅ SHIP

## 2026-08-15T10:30:12.029Z · ops · 31a4b84
- **gates:** 🔴 2 (O1 2 · O2 0 · O3 0)
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** — (no baseline)
- **critiques:** — (no critique lane for this profile)
- **EXIT:** 🔁 loop — fix reds, re-run
- **reds:**
  - `O1/schedule-failed` 8cdf3c6a-8ffd-4003-9f13-7bc125a879ba (scheduler dream-cycle-nightly) — schedule "dream-cycle-nightly" last run failed [got failed (1h ago, streak 3), want completed]
  - `O1/schedule-failed` 1186b0bf-0d5b-4cd1-9805-5a0e5a7e8b40 (scheduler daily-activity-digest) — schedule "daily-activity-digest" last run failed [got failed (21h ago, streak 2), want completed]

## 2026-08-15T10:30:12.259Z · runtime · 31a4b84
- **gates:** 🔴 1 (R1 1 · R2 0) · 🟡 1 advisory
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🔴 worse
- **critiques:** — (no critique lane for this profile)
- **EXIT:** 🔁 loop — fix reds, re-run
- **reds:**
  - `R1/participation` m1-application-rate (runtime all) — runtime check "m1-application-rate" [all] — `python3 scripts/verify_m1_application.py --days 7` exit 1 · tail: UNHEALTHY: openclaw [got exit 1, want exit 0]

## 2026-08-15T10:30:12.409Z · update · 31a4b84
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** — (no critique lane for this profile)
- **EXIT:** ✅ SHIP

## 2026-08-15T10:30:14.952Z · web · 31a4b84
- **gates:** 🟢 all green
- **delivery:** 🟢 deploy check off
- **regression vs baseline:** 🟢 none
- **critiques:** 🟢 cleared · **stories:** 🟢
- **EXIT:** ✅ SHIP
