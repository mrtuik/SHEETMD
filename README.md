# Sheet.md
1. Create a GitHub repo, push this folder to `main`.
2. Actions tab -> "Build APK" -> run (auto-runs on push).
3. Download artifact `Sheet.md-apk`, unzip, install the .apk.

Done: chat UI, sources sheet (.md/.txt/.zip), SQLite FTS5 index, topic search, rule-based exam notes + cache,
slow point-by-point TTS with speech cleaner, Topic/Repeat/Continue/Pause/Next/Prev/Slower/Faster, session resume.
Pending: on-device LLM (llama.rn), first-run screen. Background: foreground service (modules/sheet-service) keeps reading + mic alive with screen off.
