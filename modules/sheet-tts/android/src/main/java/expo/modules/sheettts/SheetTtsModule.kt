package expo.modules.sheettts

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.audiofx.LoudnessEnhancer
import android.os.Build
import com.k2fsa.sherpa.onnx.GeneratedAudio
import com.k2fsa.sherpa.onnx.GenerationConfig
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsPocketModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Collections
import java.util.LinkedHashMap
import java.util.concurrent.Executors

class SheetTtsModule : Module() {
  private val POCKET_STEPS = 2          // flow steps per frame: 2 = fast (the sherpa-onnx example value); higher = a bit cleaner but slower
  private var tts: OfflineTts? = null
  private var currentModelDir: String = ""
  @Volatile private var currentKind: String = "vits"      // "vits" (Piper) or "pocket" (Pocket TTS, voice cloning)

  // Pocket TTS clones the voice from a short reference recording (set from JS with setReference)
  @Volatile private var refAudio: FloatArray? = null
  @Volatile private var refRate: Int = 0
  @Volatile private var refKey: String = ""

  private val playExecutor = Executors.newSingleThreadExecutor()
  private val prepareExecutor = Executors.newSingleThreadExecutor { r ->
    Thread(r).apply { priority = Thread.MIN_PRIORITY }      // background: never steals CPU from the voice that is playing
  }
  // sherpa's OfflineTts must not generate from two threads at once (prepare + speak did): one at a time
  private val genLock = Any()
  @Volatile private var epoch: Int = 0        // bumped on every stop / new speak: a background generation from an older epoch aborts at once

  @Volatile private var activeId: Int = -1
  @Volatile private var cancelled: Boolean = false
  @Volatile private var currentAudioTrack: AudioTrack? = null
  @Volatile private var gain = 1.0f
  @Volatile private var liveEnhancer: LoudnessEnhancer? = null   // the enhancer of the track playing now
  @Volatile private var enhancerOk = false                       // true = the phone's loudness effect is doing the boost

  // sound boost 1x..4x -> 0..+15 dB. The phone's LoudnessEnhancer raises the AVERAGE loudness and limits the peaks,
  // which is what makes a quiet voice louder (plain multiplication cannot: the voice already peaks near full scale).
  private fun boostMb(): Int = (((gain - 1.0f) / 3.0f) * 1500f).toInt().coerceIn(0, 1500)
  private fun attachEnhancer(track: AudioTrack): LoudnessEnhancer? {
    enhancerOk = false
    if (gain <= 1.0f) return null
    return try {
      val e = LoudnessEnhancer(track.audioSessionId)
      e.setTargetGain(boostMb())
      e.enabled = true
      liveEnhancer = e
      enhancerOk = true
      e
    } catch (ex: Exception) { null }          // phone without the effect: applyGain() below does the boost instead
  }
  // fallback only (no LoudnessEnhancer): clean linear gain, only the peaks above 0.8 are rounded off. Never changes the input array.
  private fun applyGain(s: FloatArray): FloatArray {
    val g = gain
    if (g <= 1.0f || enhancerOk) return s
    val o = FloatArray(s.size)
    for (i in s.indices) {
      val y = s[i] * g
      val a = Math.abs(y)
      o[i] = if (a <= 0.8f) y else (if (y < 0f) -1f else 1f) * (0.8f + 0.2f * Math.tanh(((a - 0.8f) / 0.2f).toDouble()).toFloat())
    }
    return o
  }

  private var audioFocusRequest: Any? = null

  // LRU cache for 2-3 prepared utterances
  private val preCache = Collections.synchronizedMap(
    object : LinkedHashMap<String, GeneratedAudio>(4, 0.75f, true) {
      override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, GeneratedAudio>?): Boolean {
        return size > 3
      }
    }
  )

  private fun requestAudioFocus(): Boolean {
    val ctx = appContext.reactContext?.applicationContext ?: return false
    val am = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return false
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
          .setAudioAttributes(
            AudioAttributes.Builder()
              .setUsage(AudioAttributes.USAGE_MEDIA)
              .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
              .build()
          )
          .setAcceptsDelayedFocusGain(false)
          .setOnAudioFocusChangeListener { /* transient focus change */ }
          .build()
        audioFocusRequest = req
        am.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
      } else {
        @Suppress("DEPRECATION")
        am.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
      }
    } catch (e: Exception) {
      false
    }
  }

  private fun abandonAudioFocus() {
    val ctx = appContext.reactContext?.applicationContext ?: return
    val am = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        (audioFocusRequest as? AudioFocusRequest)?.let {
          am.abandonAudioFocusRequest(it)
        }
        audioFocusRequest = null
      } else {
        @Suppress("DEPRECATION")
        am.abandonAudioFocus(null)
      }
    } catch (e: Exception) { }
  }

  private fun findFiles(baseDir: File): Triple<File?, File?, File?> {
    var modelFile: File? = null
    var tokensFile: File? = null
    var dataDir: File? = null

    fun inspect(dir: File) {
      val list = dir.listFiles() ?: return
      for (f in list) {
        if (f.isFile && f.name.endsWith(".onnx") && !f.name.endsWith(".json")) {
          if (modelFile == null) modelFile = f
        } else if (f.isFile && f.name == "tokens.txt") {
          tokensFile = f
        } else if (f.isDirectory && f.name == "espeak-ng-data") {
          dataDir = f
        }
      }
    }

    inspect(baseDir)
    if (modelFile == null || tokensFile == null || dataDir == null) {
      baseDir.listFiles()?.filter { it.isDirectory }?.forEach { sub ->
        inspect(sub)
      }
    }
    return Triple(modelFile, tokensFile, dataDir)
  }

  private fun findNamed(baseDir: File, name: String): File? {
    baseDir.listFiles()?.forEach { f -> if (f.isFile && f.name == name) return f }
    baseDir.listFiles()?.filter { it.isDirectory }?.forEach { sub ->
      sub.listFiles()?.forEach { f -> if (f.isFile && f.name == name) return f }
    }
    return null
  }

  private fun findAny(baseDir: File, vararg names: String): File? {
    for (n in names) { val f = findNamed(baseDir, n); if (f != null) return f }
    return null
  }

  private fun isPocketDir(dir: File): Boolean =
    findNamed(dir, "vocab.json") != null && findAny(dir, "lm_main.int8.onnx", "lm_main.onnx") != null

  // 16-bit / 8 / 24 / 32-bit PCM or 32-bit float WAV, any channel count -> mono floats in [-1, 1]
  private fun readWavMono(f: File): Pair<FloatArray, Int>? {
    val b = f.readBytes()
    if (b.size < 44) return null
    if (String(b, 0, 4, Charsets.US_ASCII) != "RIFF" || String(b, 8, 4, Charsets.US_ASCII) != "WAVE") return null
    val bb = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN)
    var pos = 12
    var fmtTag = 0; var ch = 0; var rate = 0; var bits = 0
    var dataOff = -1; var dataLen = 0
    while (pos + 8 <= b.size) {
      val id = String(b, pos, 4, Charsets.US_ASCII)
      var len = bb.getInt(pos + 4)
      val body = pos + 8
      if (len < 0 || body + len > b.size) len = b.size - body
      if (id == "fmt " && len >= 16) {
        fmtTag = bb.getShort(body).toInt() and 0xFFFF
        ch = bb.getShort(body + 2).toInt()
        rate = bb.getInt(body + 4)
        bits = bb.getShort(body + 14).toInt()
        if (fmtTag == 0xFFFE && len >= 26) fmtTag = bb.getShort(body + 24).toInt() and 0xFFFF
      } else if (id == "data") {
        dataOff = body; dataLen = len
        break
      }
      pos = body + len + (len and 1)
    }
    if (dataOff < 0 || ch < 1 || rate <= 0 || bits < 8) return null
    val bytesPer = bits / 8
    val frames = dataLen / (bytesPer * ch)
    if (frames <= 0) return null
    val out = FloatArray(frames)
    for (i in 0 until frames) {
      var acc = 0f
      for (c in 0 until ch) {
        val o = dataOff + (i * ch + c) * bytesPer
        acc += when {
          fmtTag == 1 && bits == 16 -> bb.getShort(o) / 32768f
          fmtTag == 1 && bits == 8 -> ((b[o].toInt() and 0xFF) - 128) / 128f
          fmtTag == 1 && bits == 24 -> ((b[o + 2].toInt() shl 16) or ((b[o + 1].toInt() and 0xFF) shl 8) or (b[o].toInt() and 0xFF)) / 8388608f
          fmtTag == 1 && bits == 32 -> bb.getInt(o) / 2147483648f
          fmtTag == 3 && bits == 32 -> bb.getFloat(o)
          else -> return null
        }
      }
      out[i] = acc / ch
    }
    return Pair(out, rate)
  }

  // One entry point for both engines: Piper uses the speaker id, Pocket uses the reference recording.
  private fun generate(t: OfflineTts, text: String, sid: Int, speed: Float, cb: (FloatArray) -> Int) {
    if (currentKind == "pocket") {
      val ref = refAudio ?: throw IllegalStateException("No reference voice set")
      val g = GenerationConfig(speed = speed, sid = 0, referenceAudio = ref, referenceSampleRate = refRate, numSteps = POCKET_STEPS)
      t.generateWithConfigAndCallback(text, g, cb)
    } else {
      t.generateWithCallback(text, sid = sid, speed = speed, callback = cb)
    }
  }

  private fun releaseModel() {
    synchronized(this) {
      try {
        tts?.release()
      } catch (e: Exception) { }
      tts = null
      currentModelDir = ""
      preCache.clear()
    }
  }

  override fun definition() = ModuleDefinition {
    Name("SheetTts")
    Events("onStart", "onDone", "onStopped", "onError")

    OnDestroy {
      stopPlayback()
      releaseModel()
      playExecutor.shutdownNow()
      prepareExecutor.shutdownNow()
    }

    AsyncFunction("init") { modelDir: String, kind: String ->
      try {
        stopPlayback()
        releaseModel()

        val dir = File(modelDir)
        if (!dir.exists() || !dir.isDirectory) return@AsyncFunction false

        val modelConfig = if (kind == "pocket") {
          val lmFlow = findAny(dir, "lm_flow.int8.onnx", "lm_flow.onnx") ?: return@AsyncFunction false
          val lmMain = findAny(dir, "lm_main.int8.onnx", "lm_main.onnx") ?: return@AsyncFunction false
          val encoder = findAny(dir, "encoder.onnx", "encoder.int8.onnx") ?: return@AsyncFunction false
          val decoder = findAny(dir, "decoder.int8.onnx", "decoder.onnx") ?: return@AsyncFunction false
          val textCond = findAny(dir, "text_conditioner.onnx", "text_conditioner.int8.onnx") ?: return@AsyncFunction false
          val vocab = findNamed(dir, "vocab.json") ?: return@AsyncFunction false
          val scores = findNamed(dir, "token_scores.json") ?: return@AsyncFunction false
          OfflineTtsModelConfig(
            pocket = OfflineTtsPocketModelConfig(
              lmFlow = lmFlow.absolutePath,
              lmMain = lmMain.absolutePath,
              encoder = encoder.absolutePath,
              decoder = decoder.absolutePath,
              textConditioner = textCond.absolutePath,
              vocabJson = vocab.absolutePath,
              tokenScoresJson = scores.absolutePath
            ),
            numThreads = 3,
            provider = "cpu",
            debug = false
          )
        } else {
          val (modelFile, tokensFile, dataDir) = findFiles(dir)
          if (modelFile == null || tokensFile == null || dataDir == null) {
            return@AsyncFunction false
          }
          val vits = OfflineTtsVitsModelConfig(
            model = modelFile.absolutePath,
            tokens = tokensFile.absolutePath,
            dataDir = dataDir.absolutePath,
            lengthScale = 1.0f
          )
          OfflineTtsModelConfig(
            vits = vits,
            numThreads = 2,
            provider = "cpu",
            debug = false
          )
        }
        val config = OfflineTtsConfig(model = modelConfig)
        val newTts = OfflineTts(config = config)

        synchronized(this@SheetTtsModule) {
          tts = newTts
          currentModelDir = modelDir
          currentKind = kind
        }
        true
      } catch (e: Throwable) {
        releaseModel()
        false
      }
    }

    // Pocket TTS: load the reference recording (WAV) the voice is cloned from. At most 12 s are used.
    AsyncFunction("setReference") { path: String ->
      try {
        val f = File(path)
        if (!f.exists() || !f.isFile) return@AsyncFunction false
        val (samples, rate) = readWavMono(f) ?: return@AsyncFunction false
        if (samples.size < rate) return@AsyncFunction false          // shorter than 1 second
        val maxN = rate * 12
        val used = if (samples.size > maxN) samples.copyOf(maxN) else samples
        refAudio = used
        refRate = rate
        refKey = "${f.absolutePath}@${f.lastModified()}"
        preCache.clear()
        true
      } catch (e: Throwable) {
        false
      }
    }

    Function("isReady") {
      tts != null
    }

    Function("release") {
      stopPlayback()
      releaseModel()
    }

    Function("setGain") { g: Float ->
      gain = g.coerceIn(1.0f, 4.0f)
      try { liveEnhancer?.setTargetGain(boostMb()) } catch (e: Exception) { }
    }

    Function("stop") {
      stopPlayback()
    }

    Function("prepare") { text: String, speed: Float, sid: Int ->
      val currentTts = tts ?: return@Function
      val curDir = currentModelDir
      val key = "$curDir:$sid:$speed:$refKey:$text"
      if (preCache.containsKey(key)) return@Function

      val myEpoch = epoch
      prepareExecutor.submit {
        try {
          if (tts === currentTts && epoch == myEpoch) {
            val parts = ArrayList<FloatArray>()
            var total = 0
            synchronized(genLock) {
              generate(currentTts, text, sid, speed) { samples ->
                if (epoch != myEpoch || tts !== currentTts) return@generate 0   // a command arrived: give the engine back immediately
                parts.add(samples); total += samples.size
                1
              }
            }
            if (tts === currentTts && epoch == myEpoch && total > 0) {
              val all = FloatArray(total)
              var o = 0
              for (a in parts) { System.arraycopy(a, 0, all, o, a.size); o += a.size }
              preCache[key] = GeneratedAudio(all, currentTts.sampleRate())
            }
          }
        } catch (e: Exception) { }
      }
    }

    Function("speak") { id: Int, text: String, speed: Float, sid: Int ->
      val currentTts = tts
      if (currentTts == null) {
        sendEvent("onError", mapOf("id" to id, "message" to "TTS model not loaded"))
        return@Function
      }
      if (currentKind == "pocket" && refAudio == null) {
        sendEvent("onError", mapOf("id" to id, "message" to "No reference voice set"))
        return@Function
      }

      epoch++                                       // any background prepare for older text gives up now
      // If already playing another chunk, stop previous playback
      if (activeId != -1) {
        val prevId = activeId
        activeId = -1
        cancelled = true
        currentAudioTrack?.let { track ->
          try {
            track.pause()
            track.flush()
            track.stop()
          } catch (e: Exception) { }
        }
        sendEvent("onStopped", mapOf("id" to prevId))
      }

      playExecutor.submit {
        activeId = id
        cancelled = false
        var audioTrack: AudioTrack? = null
        var enh: LoudnessEnhancer? = null
        var started = false

        try {
          requestAudioFocus()
          val sampleRate = currentTts.sampleRate()
          val minBuf = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_FLOAT
          )
          val bufSize = maxOf(minBuf, sampleRate * 4) // 1s buffer for float audio

          audioTrack = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            AudioTrack.Builder()
              .setAudioAttributes(
                AudioAttributes.Builder()
                  .setUsage(if (VoiceRoute.comm) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_MEDIA)
                  .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                  .build()
              )
              .setAudioFormat(
                AudioFormat.Builder()
                  .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                  .setSampleRate(sampleRate)
                  .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                  .build()
              )
              .setBufferSizeInBytes(bufSize)
              .setTransferMode(AudioTrack.MODE_STREAM)
              .build()
          } else {
            @Suppress("DEPRECATION")
            AudioTrack(
              AudioAttributes.Builder()
                .setUsage(if (VoiceRoute.comm) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
              AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                .setSampleRate(sampleRate)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build(),
              bufSize,
              AudioTrack.MODE_STREAM,
              AudioManager.AUDIO_SESSION_ID_GENERATE
            )
          }
          currentAudioTrack = audioTrack
          enh = attachEnhancer(audioTrack)

          val curDir = currentModelDir
          val cacheKey = "$curDir:$sid:$speed:$refKey:$text"
          val cached = preCache.remove(cacheKey)

          var totalWrittenFrames = 0

          if (cached != null) {
            if (!cancelled && activeId == id) {
              started = true
              sendEvent("onStart", mapOf("id" to id))
              audioTrack.play()
              val samples = cached.samples
              if (samples.isNotEmpty()) {
                audioTrack.write(applyGain(samples), 0, samples.size, AudioTrack.WRITE_BLOCKING)
                totalWrittenFrames = samples.size
              }
            }
          } else {
            if (currentKind == "pocket") {
              // Pocket is heavy: on a slow phone streaming would stutter (audio underrun). Generate the whole line first, then play it smoothly.
              val parts = ArrayList<FloatArray>()
              var total = 0
              synchronized(genLock) {
                generate(currentTts, text, sid, speed) { samples ->
                  if (cancelled || activeId != id) return@generate 0
                  parts.add(samples); total += samples.size
                  1
                }
              }
              if (!cancelled && activeId == id && total > 0) {
                started = true
                sendEvent("onStart", mapOf("id" to id))
                audioTrack.play()
                for (a in parts) {
                  if (cancelled || activeId != id) break
                  audioTrack.write(applyGain(a), 0, a.size, AudioTrack.WRITE_BLOCKING)
                  totalWrittenFrames += a.size
                }
              }
            } else {
              synchronized(genLock) {
                generate(currentTts, text, sid, speed) { samples ->
                  if (cancelled || activeId != id) {
                    return@generate 0
                  }
                  if (samples.isNotEmpty()) {
                    if (!started) {
                      started = true
                      sendEvent("onStart", mapOf("id" to id))
                      audioTrack.play()
                    }
                    audioTrack.write(applyGain(samples), 0, samples.size, AudioTrack.WRITE_BLOCKING)
                    totalWrittenFrames += samples.size
                  }
                  1
                }
              }
            }
          }

          // Drain playback buffer
          if (started && !cancelled && activeId == id) {
            // stall guard: if the playback position stops moving for 4 s (audio focus stolen, track stuck), give up waiting,
            // so onDone is still sent and the reader can never hang in "reading" with no sound
            var lastHead = -1
            var lastMove = System.currentTimeMillis()
            while (!cancelled && activeId == id) {
              val head = audioTrack.playbackHeadPosition
              if (head >= totalWrittenFrames) {
                break
              }
              val now = System.currentTimeMillis()
              if (head != lastHead) { lastHead = head; lastMove = now }
              else if (now - lastMove > 4000) break
              Thread.sleep(15)
            }
          }

          if (!cancelled && activeId == id) {
            sendEvent("onDone", mapOf("id" to id))
          }
        } catch (e: Exception) {
          if (!cancelled && activeId == id) {
            sendEvent("onError", mapOf("id" to id, "message" to (e.message ?: "Playback failed")))
          }
        } finally {
          try {
            audioTrack?.stop()
            audioTrack?.release()
          } catch (e: Exception) { }
          try { enh?.release() } catch (e: Exception) { }
          if (liveEnhancer === enh) { liveEnhancer = null; enhancerOk = false }
          if (currentAudioTrack === audioTrack) {
            currentAudioTrack = null
          }
          abandonAudioFocus()
          if (activeId == id) {
            activeId = -1
          }
        }
      }
    }

    AsyncFunction("extractTarBz2") { archivePath: String, destDir: String ->
      try {
        val archiveFile = File(archivePath)
        if (!archiveFile.exists()) return@AsyncFunction false

        val targetDir = File(destDir)
        val tempDir = File(targetDir.parentFile, targetDir.name + "_tmp_" + System.currentTimeMillis())
        if (tempDir.exists()) tempDir.deleteRecursively()
        tempDir.mkdirs()

        FileInputStream(archiveFile).use { fis ->
          BufferedInputStream(fis).use { bis ->
            BZip2CompressorInputStream(bis).use { bz2 ->
              TarArchiveInputStream(bz2).use { tar ->
                var entry: TarArchiveEntry? = tar.nextTarEntry
                while (entry != null) {
                  val name = entry.name
                  if (name.contains("..") || name.startsWith("/")) {
                    throw SecurityException("Path traversal attempt in archive: $name")
                  }
                  val outFile = File(tempDir, name)
                  if (entry.isDirectory) {
                    outFile.mkdirs()
                  } else {
                    outFile.parentFile?.mkdirs()
                    FileOutputStream(outFile).use { fos ->
                      tar.copyTo(fos)
                    }
                  }
                  entry = tar.nextTarEntry
                }
              }
            }
          }
        }

        // If files are wrapped in a single root folder (e.g. vits-piper-.../), flatten it
        val subs = tempDir.listFiles() ?: emptyArray()
        if (subs.size == 1 && subs[0].isDirectory) {
          val inner = subs[0]
          val innerFiles = inner.listFiles() ?: emptyArray()
          for (f in innerFiles) {
            val dest = File(tempDir, f.name)
            if (dest.exists()) dest.deleteRecursively()
            f.renameTo(dest)
          }
          inner.delete()
        }

        if (targetDir.exists()) targetDir.deleteRecursively()
        var moved = tempDir.renameTo(targetDir)
        if (!moved) {
          targetDir.mkdirs()
          tempDir.copyRecursively(targetDir, overwrite = true)
          tempDir.deleteRecursively()
          moved = true
        }

        if (isPocketDir(targetDir)) {
          moved
        } else {
          val (model, tokens, data) = findFiles(targetDir)
          moved && model != null && tokens != null && data != null
        }
      } catch (e: Exception) {
        false
      }
    }
  }

  private fun stopPlayback() {
    epoch++
    val prevId = activeId
    activeId = -1
    cancelled = true
    currentAudioTrack?.let { track ->
      try {
        track.pause()
        track.flush()
        track.stop()
      } catch (e: Exception) { }
    }
    if (prevId != -1) {
      sendEvent("onStopped", mapOf("id" to prevId))
    }
    abandonAudioFocus()
    preCache.clear()
  }
}
