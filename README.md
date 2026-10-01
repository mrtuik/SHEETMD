# Sheet.md
1. Create a GitHub repo, push this folder to `main`.
2. Actions tab -> "Build APK" -> run (auto-runs on push).
3. Download artifact `Sheet.md-apk`, unzip, install the .apk.

Done: chat UI, sources sheet (.md/.txt/.zip), SQLite FTS5 index, topic search, rule-based exam notes + cache,
slow point-by-point TTS with speech cleaner, Topic/Repeat/Continue/Pause/Next/Prev/Slower/Faster, session resume.
Pending: on-device LLM (llama.rn), first-run screen. Background: foreground service (modules/sheet-service) keeps reading + mic alive with screen off.

Update: PDFs are split into real topics (headings, header/footer removal, scanned pages via OCR + OCR repair), `topic X` reads ONLY X
(never the whole file), typo-tolerant search (FTS5 trigram, filled automatically from the existing index), clearest-voice picker in Voice settings.
Note: sources added with the old version keep their old (whole-file) topics - remove and add PDFs again to get the new topic split.
