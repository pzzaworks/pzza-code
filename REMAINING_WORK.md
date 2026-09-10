# Remaining work

Updated: 2026-09-10. The control and delivery fixes below are verified. The speech acceptance targets are not complete.

## Unresolved product work

- [ ] Achieve accurate, genuinely real-time finalized English/Turkish dictation.
  - The engine remains local and open-source. Inline partial text is provisional and never writes to the terminal process.
  - Microphone-rate conversion now uses antialiased, phase-stable resampling. Native tests cover 44.1/48 kHz rejection, speech passband, duration, boundaries and growing snapshots. Conversion is approximately 16-18 ms for eight seconds of audio and 60-65 ms for thirty seconds in the measured optimized run.
  - This fixes aliasing from higher-rate microphones, not bilingual decoding at 16 kHz. The latter remains bit-exact through the converter.
  - The final production-path synthetic acoustic run passed **7 of 10** cases. English commands had one insertion across eight reference words; rapid mixed commands had three word errors across eight reference words; one continuous bilingual sample had two errors across fourteen words. Turkish commands, two other bilingual samples and all four pause/resume cases passed.
  - Correctly recognized committed-word median latency was approximately 2.30 seconds for English commands and 2.08 seconds for Turkish commands. These statistics exclude unrecognized words; they are not accuracy guarantees or subsecond finalization.
  - Earlier first-correct-partial medians were approximately 0.90 seconds in English and 1.27 seconds in Turkish. Do not confuse provisional rendering with confirmed recognition.
  - Future improvements must keep the original reference transcript unchanged, preserve failure reports, and measure errors alongside first-correct-partial and committed-word timing. Do not replace expected text with the decoder's output.
- [ ] Validate with a human microphone recording: mid-sentence switching, silence/resume, white waveform, manual-input cancellation, stop/restart and ordinary room noise.
  - No live microphone capture or permission prompt was automated during this delivery. Synthetic recognition is not proof of real microphone quality.
- [ ] Exercise long-stalled real network/process cases for Sync beyond the existing bounded-worker, failure, cancellation and real-Git regressions. Network/auth/repository failures should remain actionable, not be hidden to remove warnings.

## Verified implementation and checks

- [x] Shared session-header and empty-workspace controls: Layout, Mic, Focus, Code, Move, Duplicate, Fullscreen, Hide. Existing Close remains available afterward.
- [x] Compact dropdowns, collapsed Sync settings, workspace/session shortcuts and All pinned first.
- [x] Bounded concurrent scans and unchanged-repository short-circuiting, covered by real Git tests. Completion summaries distinguish current/skipped repositories, unsynced dirty work, preserved stashes, errors and cancellation.
- [x] Fast connected-device usage fallback when local data is missing or slow, with shared requests, bounded workers and cooldowns.
- [x] Remote desktop Open/Settings routing and forwarding controls; settings open their actual corresponding panels.
- [x] Agents Hub, notification and Sync view controls: actual browser filtering, selection, previews, pagination, disclosure, unsupported states, asynchronous failures and recovery.
- [x] Bridge configuration saves require the draft's original config hash. Browser tests covered tab changes and navigating away/back, stale-save rejection without restoring a revoked grant, explicit reload and accurate expired/globally-disabled status.
- [x] Pairing has idempotent client-assigned operation IDs and short start/status requests. Lost responses recover by ID rather than replaying grants. Pending outcomes survive panel remount/reload. Backend results are process-local, limited to 32 for one hour; restart/expiry is explicitly unknown and requires review before dismissal. Existing rollback, identity, project, capability, expiry and authorization boundaries remain enforced.
- [x] Launcher repair and guarded provisioning preserve existing settings and private backups. The remote Git protector discovers managed/Homebrew/NVM runtimes without sourcing shell startup files. Git protection remains mandatory for commit, push and PR operations.
- [x] Corrected missing model pricing. Unknown rates display unavailable/partial estimates, never false zero totals. The installed backend reported $222.77 today, $1,102.31 yesterday and $3,173.91 over thirty days for the reported account. The UI explicitly labels standard short-context API-equivalent estimates, not billed charges; long-context/service-tier adjustments are excluded.
- [x] Final aggregate: **326 passed, 0 failed** across backend and frontend script tests. The first run exposed an obsolete dictation test target missing preview callbacks; I corrected the fixture and retained its focus assertions. No production bypass was added.
- [x] Frontend production build passed. Bundled integration tests: **12 passed**. Native suite: **40 passed, 2 ignored**. The ignored acoustic test was run separately with the failures recorded above; the other ignored test measures conversion timing.
  - The frontend build still reports mixed static/dynamic imports and a large bundle warning. These are warnings, not suppressed or represented as failures.
- [x] Actual installed desktop smoke: **175 tools / 107 app actions**, explicit connected-client selection, strict invalid-input rejection, native window state, integration/dictation/sync/forwarding/update reads and usage-menu interaction.
- [x] Disposable installed editor/terminal interactions: read/edit/save, stale revision rejection, dirty-close rejection, dirty-file rename, explicit discard and terminal text that runs only after explicit Submit. No user files or microphone audio were used.

## Installed delivery and preservation

- [x] Built a signed local app with the original signing identity, without updater artifacts, a public release or tags.
- [x] Replaced and relaunched `/Applications/PzzaCode.app`. Signature, all **59** regular bundle-file hashes and backend health passed. Both original local terminal pane IDs/PIDs survived.
- [x] Refreshed **58** managed remote server/integration source files. Source hashes, service health, bridge identity/configuration and the existing read-only project grant were verified. No dependency directory, private configuration or grant scope was replaced or broadened.
- [x] The remote refresh itself preserved all eight original panes. After local app relaunch, the strict all-pane check detected one replacement: Quick Chat starts a fresh conversation under the existing launch policy in `src/state/quickChatSession.ts`. All **seven regular remote terminal panes** retained their IDs/PIDs. Do not report that every helper process survived relaunch.
- [x] Actual remote startup/tool-list handshakes passed for Railway, the runtime REPL and the trading integration. The local configured runtime REPL handshake passed. This is not a claim that every configured integration on every possible device was started during this final check.
- The read-only project bridge grant expires at `2026-09-10T06:36:12Z`. Check validity before future bridge tests. Do not silently extend it or broaden its permissions.
- OS permission prompts and enabling local app-control consent remain human actions. External clients may need a restart to discover the expanded tool catalog.
- Delivery targets `origin/main`; the introducing commit and remote reference are the source of truth for its exact revision. No public release or tags are part of this task.

## Rollback and local evidence

These paths are local verification artifacts, not repository dependencies. Inspect helpers before running them; temporary directories may be cleared.

- Local rollback bundle: `/Applications/.PzzaCode.install-etss_cog/PzzaCode.previous.app`.
- Remote rollback source: `/home/pzzaworks/pzzacode-agent-upgrades/final-20260910T001550Z/previous`.
- Remote refresh/rollback helpers: `/tmp/pzza-final-agent-refresh.py`, `/tmp/pzza-final-agent-refresh-remote.py`.
- Latest delivery helpers and acoustic reports: `/var/folders/m6/gqhnz38x0dn_k2xhw9t41dw40000gn/T/pzza-continuation-zgv0dag8/`.
- Acoustic acceptance summary: `acoustics/summary.json` beneath that directory. Each case retains its original reference, timed production events and result.
- Browser and terminal interaction evidence: `/tmp/pzza-integration-ui/`, including the final Bridge draft regression.
- Signed build helper/log: `/tmp/pzza-dictation-language/build-local.py` and `app-build.log`.

Keep rollback backups and terminal sessions. Run long builds/tests in the background. Isolate `XDG_CONFIG_HOME` for standalone backend tests because importing `server/lib/http.js` writes an agent-token file. Never print authentication values. Before every commit or push, run the required repository protection for the exact staged tree or branch and keep its hooks enabled. Stage only requested source, tests and this handoff, never dependencies, build artifacts, environment files or credentials.
