package expo.modules.sheettts

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import com.k2fsa.sherpa.onnx.EndpointConfig
import com.k2fsa.sherpa.onnx.EndpointRule
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

// Shared switch: when true the app's own voice (TTS) plays on the "voice communication" stream, like a phone call,
// so the phone's echo canceller knows what to remove from the mic.
object VoiceRoute { @Volatile var comm = false }

// Offline speech-to-text (sherpa-onnx streaming zipformer, English) that records the mic itself.
class SheetSttModule : Module() {
  @Volatile private var rec: OnlineRecognizer? = null
  @Volatile private var running = false
  private var worker: Thread? = null
  private var savedMode = AudioManager.MODE_NORMAL
  private var savedSpeaker = false
  private var savedCallVol = -1
  private var routed = false

  private fun ctx(): Context? = appContext.reactContext?.applicationContext
  private fun am(): AudioManager? = ctx()?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

  private fun find(dir: File, vararg names: String): File? {
    for (n in names) { val f = File(dir, n); if (f.isFile && f.length() > 0) return f }
    return null
  }

  // phone-call style audio: communication mode + loudspeaker, so the echo canceller has a reference
  private fun routeToCall() {
    val a = am() ?: return
    try {
      savedMode = a.mode
      @Suppress("DEPRECATION") run { savedSpeaker = a.isSpeakerphoneOn }
      a.mode = AudioManager.MODE_IN_COMMUNICATION
      var headset = false
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val devs = a.availableCommunicationDevices
        headset = devs.any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET || it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES || it.type == AudioDeviceInfo.TYPE_USB_HEADSET || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET }
        if (!headset) devs.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }?.let { a.setCommunicationDevice(it) }
      } else {
        @Suppress("DEPRECATION") run {
          headset = a.isWiredHeadsetOn || a.isBluetoothScoOn
          if (!headset) a.isSpeakerphoneOn = true
        }
      }
      // call volume follows the call stream: keep it at least 80% so the reading stays loud
      savedCallVol = a.getStreamVolume(AudioManager.STREAM_VOICE_CALL)
      val mx = a.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL)
      if (savedCallVol < (mx * 0.8f).toInt()) a.setStreamVolume(AudioManager.STREAM_VOICE_CALL, (mx * 0.8f).toInt(), 0)
      routed = true
      VoiceRoute.comm = true
    } catch (e: Exception) { }
  }

  private fun routeBack() {
    VoiceRoute.comm = false
    if (!routed) return
    routed = false
    val a = am() ?: return
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) a.clearCommunicationDevice()
      else @Suppress("DEPRECATION") run { a.isSpeakerphoneOn = savedSpeaker }
      a.mode = savedMode
      if (savedCallVol >= 0) a.setStreamVolume(AudioManager.STREAM_VOICE_CALL, savedCallVol, 0)
    } catch (e: Exception) { }
  }

  private fun stopWorker() {
    running = false
    try { worker?.join(1500) } catch (e: Exception) { }
    worker = null
    routeBack()
  }

  private fun loop(aec: Boolean, maxGain: Float) {
    val r = rec ?: return
    val rate = 16000
    var ar: AudioRecord? = null
    var aecFx: AcousticEchoCanceler? = null
    var nsFx: NoiseSuppressor? = null
    var agcFx: AutomaticGainControl? = null
    val stream = r.createStream()
    try {
      val minBuf = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      val src = if (aec) MediaRecorder.AudioSource.VOICE_COMMUNICATION else MediaRecorder.AudioSource.VOICE_RECOGNITION
      ar = AudioRecord(src, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, max(minBuf, rate / 2))
      if (ar.state != AudioRecord.STATE_INITIALIZED) { sendEvent("onError", mapOf("message" to "Mic could not start")); return }
      val sid = ar.audioSessionId
      var info = ""
      if (aec) {
        try { if (AcousticEchoCanceler.isAvailable()) { aecFx = AcousticEchoCanceler.create(sid); aecFx?.enabled = true; info += "AEC " } } catch (e: Exception) { }
        try { if (NoiseSuppressor.isAvailable()) { nsFx = NoiseSuppressor.create(sid); nsFx?.enabled = true; info += "NS " } } catch (e: Exception) { }
      }
      try { if (AutomaticGainControl.isAvailable()) { agcFx = AutomaticGainControl.create(sid); agcFx?.enabled = true; info += "AGC " } } catch (e: Exception) { }
      sendEvent("onInfo", mapOf("effects" to info.trim()))
      ar.startRecording()

      val chunk = rate / 10                           // 100 ms
      val buf = ShortArray(chunk)
      val f = FloatArray(chunk)
      var gain = 1.0f
      var lastText = ""
      var lastLevelAt = 0L
      while (running) {
        val n = ar.read(buf, 0, chunk)
        if (n <= 0) { if (n < 0) break else continue }
        // soft voices: a slow automatic gain (up to maxGain) so a quiet voice reaches the recogniser at a good level
        var peak = 0f; var sum = 0.0
        for (i in 0 until n) { val v = buf[i] / 32768f; f[i] = v; sum += (v * v).toDouble(); val a = abs(v); if (a > peak) peak = a }
        val rms = sqrt(sum / n).toFloat()
        if (rms > 0.004f) {                           // only adapt to speech-like input, never amplify pure silence
          val want = (0.10f / max(rms, 0.001f)).coerceIn(1.0f, maxGain)
          gain += (want - gain) * (if (want < gain) 0.5f else 0.15f)   // fast down (loud), slow up (soft)
        }
        val g = min(gain, 0.98f / max(peak, 0.001f))  // never clip
        for (i in 0 until n) f[i] = (f[i] * g).coerceIn(-1f, 1f)
        stream.acceptWaveform(f.copyOf(n), rate)
        while (r.isReady(stream)) r.decode(stream)
        val text = r.getResult(stream).text.trim().lowercase()
        if (text.isNotEmpty() && text != lastText) { lastText = text; sendEvent("onPartial", mapOf("text" to text)) }
        if (r.isEndpoint(stream)) {
          if (text.isNotEmpty()) sendEvent("onFinal", mapOf("text" to text))
          r.reset(stream)
          lastText = ""
        }
        val now = System.currentTimeMillis()
        if (now - lastLevelAt > 70) { lastLevelAt = now; sendEvent("onLevel", mapOf("level" to min(1f, rms * g * 6f))) }
      }
    } catch (e: Exception) {
      sendEvent("onError", mapOf("message" to (e.message ?: "STT failed")))
    } finally {
      try { ar?.stop() } catch (e: Exception) { }
      try { ar?.release() } catch (e: Exception) { }
      try { aecFx?.release() } catch (e: Exception) { }
      try { nsFx?.release() } catch (e: Exception) { }
      try { agcFx?.release() } catch (e: Exception) { }
      try { stream.release() } catch (e: Exception) { }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("SheetStt")
    Events("onPartial", "onFinal", "onLevel", "onError", "onInfo")

    OnDestroy { stopWorker(); try { rec?.release() } catch (e: Exception) { }; rec = null }

    // modelDir holds: tokens.txt + encoder / decoder / joiner .onnx (int8 or normal)
    AsyncFunction("init") { modelDir: String, threads: Int ->
      try {
        stopWorker()
        try { rec?.release() } catch (e: Exception) { }
        rec = null
        val d = File(modelDir)
        val tokens = find(d, "tokens.txt") ?: return@AsyncFunction false
        val enc = d.listFiles()?.firstOrNull { it.name.startsWith("encoder") && it.name.endsWith(".onnx") && it.length() > 0 && it.name.contains("int8") }
          ?: d.listFiles()?.firstOrNull { it.name.startsWith("encoder") && it.name.endsWith(".onnx") && it.length() > 0 } ?: return@AsyncFunction false
        val dec = d.listFiles()?.firstOrNull { it.name.startsWith("decoder") && it.name.endsWith(".onnx") && it.length() > 0 } ?: return@AsyncFunction false
        val join = d.listFiles()?.firstOrNull { it.name.startsWith("joiner") && it.name.endsWith(".onnx") && it.length() > 0 && it.name.contains("int8") }
          ?: d.listFiles()?.firstOrNull { it.name.startsWith("joiner") && it.name.endsWith(".onnx") && it.length() > 0 } ?: return@AsyncFunction false
        // sherpa-onnx aborts the whole process on a bad model, so refuse obviously broken files before loading
        if (tokens.readLines().count { it.isNotBlank() } < 20) { sendEvent("onError", mapOf("message" to "STT tokens file is broken")); return@AsyncFunction false }
        if (enc.length() < 20_000_000L || dec.length() < 100_000L || join.length() < 50_000L) { sendEvent("onError", mapOf("message" to "STT model files incomplete")); return@AsyncFunction false }
        val cfg = OnlineRecognizerConfig(
          featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80),
          modelConfig = OnlineModelConfig(
            transducer = OnlineTransducerModelConfig(encoder = enc.absolutePath, decoder = dec.absolutePath, joiner = join.absolutePath),
            tokens = tokens.absolutePath,
            numThreads = threads.coerceIn(1, 4),
            provider = "cpu",
            // left empty on purpose: sherpa-onnx reads the real type (zipformer2) from the model file itself.
            // Forcing "zipformer" on this zipformer2 model made the native code abort (app crash) right after loading.
            modelType = "",
          ),
          // ends an utterance after ~0.9 s of silence (a command), or after 15 s of talking
          endpointConfig = EndpointConfig(EndpointRule(false, 1.6f, 0.0f), EndpointRule(true, 0.9f, 0.0f), EndpointRule(false, 0.0f, 15.0f)),
          enableEndpoint = true,
          decodingMethod = "greedy_search",
        )
        rec = OnlineRecognizer(config = cfg)
        true
      } catch (e: Throwable) {
        sendEvent("onError", mapOf("message" to ("STT model: " + (e.message ?: "load failed"))))
        false
      }
    }

    Function("isReady") { rec != null }
    Function("running") { running }

    Function("aecAvailable") { try { AcousticEchoCanceler.isAvailable() } catch (e: Exception) { false } }

    Function("start") { aec: Boolean, maxGain: Float ->
      if (rec == null) return@Function false
      stopWorker()
      if (aec) routeToCall()
      running = true
      worker = Thread({ loop(aec, maxGain.coerceIn(1f, 12f)) }, "sheet-stt").apply { priority = Thread.MAX_PRIORITY; start() }
      true
    }

    Function("stop") { stopWorker() }

    Function("release") { stopWorker(); try { rec?.release() } catch (e: Exception) { }; rec = null }
  }
}
