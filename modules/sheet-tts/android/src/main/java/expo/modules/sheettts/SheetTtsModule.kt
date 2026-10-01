package expo.modules.sheettts

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import com.k2fsa.sherpa.onnx.GeneratedAudio
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
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
import java.util.Collections
import java.util.LinkedHashMap
import java.util.concurrent.Executors

class SheetTtsModule : Module() {
  private var tts: OfflineTts? = null
  private var currentModelDir: String = ""

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

    AsyncFunction("init") { modelDir: String ->
      try {
        stopPlayback()
        releaseModel()

        val dir = File(modelDir)
        if (!dir.exists() || !dir.isDirectory) return@AsyncFunction false

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
        val modelConfig = OfflineTtsModelConfig(
          vits = vits,
          numThreads = 2,
          provider = "cpu",
          debug = false
        )
        val config = OfflineTtsConfig(model = modelConfig)
        val newTts = OfflineTts(config = config)

        synchronized(this@SheetTtsModule) {
          tts = newTts
          currentModelDir = modelDir
        }
        true
      } catch (e: Exception) {
        releaseModel()
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

    Function("stop") {
      stopPlayback()
    }

    Function("prepare") { text: String, speed: Float ->
      val currentTts = tts ?: return@Function
      val curDir = currentModelDir
      val key = "$curDir:$speed:$text"
      if (preCache.containsKey(key)) return@Function

      val myEpoch = epoch
      prepareExecutor.submit {
        try {
          if (tts === currentTts && epoch == myEpoch) {
            val parts = ArrayList<FloatArray>()
            var total = 0
            synchronized(genLock) {
              currentTts.generateWithCallback(text, sid = 0, speed = speed) { samples ->
                if (epoch != myEpoch || tts !== currentTts) return@generateWithCallback 0   // a command arrived: give the engine back immediately
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

    Function("speak") { id: Int, text: String, speed: Float ->
      val currentTts = tts
      if (currentTts == null) {
        sendEvent("onError", mapOf("id" to id, "message" to "TTS model not loaded"))
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
                  .setUsage(AudioAttributes.USAGE_MEDIA)
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
                .setUsage(AudioAttributes.USAGE_MEDIA)
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

          val curDir = currentModelDir
          val cacheKey = "$curDir:$speed:$text"
          val cached = preCache.remove(cacheKey)

          var totalWrittenFrames = 0

          if (cached != null) {
            if (!cancelled && activeId == id) {
              started = true
              sendEvent("onStart", mapOf("id" to id))
              audioTrack.play()
              val samples = cached.samples
              if (samples.isNotEmpty()) {
                audioTrack.write(samples, 0, samples.size, AudioTrack.WRITE_BLOCKING)
                totalWrittenFrames = samples.size
              }
            }
          } else {
            synchronized(genLock) {
              currentTts.generateWithCallback(text, sid = 0, speed = speed) { samples ->
                if (cancelled || activeId != id) {
                  return@generateWithCallback 0
                }
                if (samples.isNotEmpty()) {
                  if (!started) {
                    started = true
                    sendEvent("onStart", mapOf("id" to id))
                    audioTrack.play()
                  }
                  audioTrack.write(samples, 0, samples.size, AudioTrack.WRITE_BLOCKING)
                  totalWrittenFrames += samples.size
                }
                1
              }
            }
          }

          // Drain playback buffer
          if (started && !cancelled && activeId == id) {
            while (!cancelled && activeId == id) {
              val head = audioTrack.playbackHeadPosition
              if (head >= totalWrittenFrames) {
                break
              }
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

        val (model, tokens, data) = findFiles(targetDir)
        moved && model != null && tokens != null && data != null
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
