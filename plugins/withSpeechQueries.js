// Android 11+ package visibility: without <queries> for RecognitionService the app may not "see" Google's speech engine
// and Voice.start fails silently. Safe to add even if the voice library already declares it (duplicates are skipped).
const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withSpeechQueries(config) {
  return withAndroidManifest(config, (cfg) => {
    const m = cfg.modResults.manifest;
    m.queries = m.queries || [];
    const has = m.queries.some((q) => (q.intent || []).some((i) => (i.action || []).some((a) => a.$ && a.$['android:name'] === 'android.speech.RecognitionService')));
    if (!has) m.queries.push({ intent: [{ action: [{ $: { 'android:name': 'android.speech.RecognitionService' } }] }] });
    return cfg;
  });
};
