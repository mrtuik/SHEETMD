package expo.modules.sheetpdf

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.io.MemoryUsageSetting
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.text.PDFTextStripper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class SheetPdfModule : Module() {
  private var doc: PDDocument? = null
  private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }

  private fun path(p: String): String = Uri.parse(p).path ?: p

  override fun definition() = ModuleDefinition {
    Name("SheetPdf")

    // Opens a PDF (temp-file memory mode, so huge PDFs are fine) and returns page count
    AsyncFunction("open") { p: String ->
      doc?.close()
      val ctx = appContext.reactContext?.applicationContext ?: throw Exception("No context")
      PDFBoxResourceLoader.init(ctx)
      val d = PDDocument.load(File(path(p)), MemoryUsageSetting.setupTempFileOnly())
      doc = d
      d.numberOfPages
    }

    // Text of pages start..end (1-based, inclusive), one string per page
    AsyncFunction("readPages") { start: Int, end: Int ->
      val d = doc ?: throw Exception("PDF not open")
      val out = ArrayList<String>()
      val last = minOf(end, d.numberOfPages)
      for (i in start..last) {
        val s = PDFTextStripper()
        s.sortByPosition = true
        s.startPage = i
        s.endPage = i
        out.add(try { s.getText(d) } catch (e: Exception) { "" })
      }
      out
    }

    AsyncFunction("close") {
      doc?.close()
      doc = null
    }

    // OCR one page of a scanned PDF (offline ML Kit, Latin script)
    AsyncFunction("ocrPdfPage") { p: String, page: Int ->
      val pfd = ParcelFileDescriptor.open(File(path(p)), ParcelFileDescriptor.MODE_READ_ONLY)
      val r = PdfRenderer(pfd)
      try {
        val pg = r.openPage(page - 1)
        try {
          val scale = minOf(2.5f, 2000f / pg.width)
          val bmp = Bitmap.createBitmap((pg.width * scale).toInt(), (pg.height * scale).toInt(), Bitmap.Config.ARGB_8888)
          bmp.eraseColor(Color.WHITE)
          pg.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
          val res = Tasks.await(recognizer.process(InputImage.fromBitmap(bmp, 0)))
          bmp.recycle()
          res.text
        } finally { pg.close() }
      } finally { r.close(); pfd.close() }
    }

    AsyncFunction("ocrImage") { p: String ->
      val f = path(p)
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(f, bounds)
      var s = 1
      while (bounds.outWidth / s > 3000) s *= 2
      val bmp = BitmapFactory.decodeFile(f, BitmapFactory.Options().apply { inSampleSize = s })
        ?: throw Exception("Cannot decode image")
      val res = Tasks.await(recognizer.process(InputImage.fromBitmap(bmp, 0)))
      bmp.recycle()
      res.text
    }
  }
}
