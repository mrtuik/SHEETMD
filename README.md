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

Update (exact + PDF structure):
- PDFs are now read WITH layout (font size, bold, x position): real headings, wrapped headings joined, bullets / nested bullets,
  numbered lists, and TABLES (wrapped cell text stays in its cell, a header repeated at a page break is dropped, a table that
  continues on the next page is merged). Remove old PDF sources and add them again to get this.
- Numbered notes ("1. Define ...", "2. Autoclave"): un-numbered headings in between ("Classification of ...", "A. Physical methods")
  stay INSIDE the number above them, so `exact sterilization` reads the whole topic up to the next number.
- `exact`: every point is read with everything under it. A table is read as "Table. Left column: A. Right column: B." then
  "Row 1. Left side: ... Right side: ...".
- Screen: the whole topic is shown as normal text (nothing collapsed); the line being read is highlighted. Tap any block to jump.
- Voice: "one / two / three" also works as "okay one", "number two"; stop / pause / next are also taken from the recogniser's other guesses;
  a "heard: ..." line shows what the mic heard; a Stop button sits next to Next.
