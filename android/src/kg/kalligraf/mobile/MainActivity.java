package kg.kalligraf.mobile;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.ContentValues;
import android.os.VibrationEffect;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.os.Vibrator;
import android.provider.MediaStore;
import android.speech.RecognizerIntent;
import android.webkit.ValueCallback;
import java.util.ArrayList;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;

/** Окно приложения: интерфейс Каллиграфа (из assets/www) + мост к USB-порту машины. */
public class MainActivity extends Activity {
    private static final String HOST = "app.kalligraf.local";
    private static final String ACTION_PERMISSION = "kg.kalligraf.mobile.USB_PERMISSION";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private WebView web;
    private UsbManager usb;
    private volatile UsbSerial port;
    private int pendingBaud = 115200;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        usb = (UsbManager) getSystemService(Context.USB_SERVICE);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                boolean image = false;
                for (String t : params.getAcceptTypes()) if (t != null && t.startsWith("image")) image = true;
                return image ? pickImage(cb) : pickAnyFile(cb);
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                // ошибки интерфейса — в logcat (adb logcat -s Kalligraf)
                android.util.Log.println(m.messageLevel() == ConsoleMessage.MessageLevel.ERROR ? android.util.Log.ERROR : android.util.Log.INFO,
                        "Kalligraf", m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                return HOST.equals(u.getHost()) ? asset(u.getPath()) : null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return !HOST.equals(req.getUrl().getHost()); // наружу не уходим
            }
        });
        web.addJavascriptInterface(new Bridge(), "KalligrafUsb");
        web.addJavascriptInterface(new NativeBridge(), "KalligrafNative");
        setContentView(web);

        IntentFilter f = new IntentFilter(ACTION_PERMISSION);
        f.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(receiver, f, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(receiver, f);

        if (state != null) web.restoreState(state);
        else web.loadUrl("https://" + HOST + "/index.html");
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        closePort(null);
        try { unregisterReceiver(receiver); } catch (Exception ignored) { }
        web.destroy();
        super.onDestroy();
    }

    // ── файлы интерфейса из assets/www ─────────────────────────────────

    private WebResourceResponse asset(String path) {
        if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
        // CORS-заголовки обязательны: скрипты-модули и стили грузятся в режиме crossorigin,
        // без заголовка WebView молча их отбрасывает — получается белый экран
        HashMap<String, String> headers = new HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Cache-Control", "no-cache");
        try {
            InputStream in = getAssets().open("www" + path);
            return new WebResourceResponse(mime(path), "UTF-8", 200, "OK", headers, in);
        } catch (IOException e) {
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", headers,
                    new ByteArrayInputStream(new byte[0]));
        }
    }

    private static String mime(String p) {
        p = p.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "application/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    // ── USB ─────────────────────────────────────────────────────────────

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent i) {
            UsbDevice d = i.getParcelableExtra(UsbManager.EXTRA_DEVICE);
            if (ACTION_PERMISSION.equals(i.getAction())) {
                if (d != null && i.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)) openPort(d, pendingBaud);
                else emit("error", "Нет разрешения на USB. Нажмите «Подключить» ещё раз и разрешите доступ.");
            } else if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(i.getAction())) {
                UsbSerial p = port;
                if (p != null && d != null && d.getDeviceName().equals(p.device.getDeviceName())) closePort("Кабель машины отключён");
            }
        }
    };

    private void connect(int baud) {
        UsbDevice dev = null;
        for (UsbDevice d : usb.getDeviceList().values()) {
            if (UsbSerial.supported(d)) { dev = d; break; }
        }
        if (dev == null) {
            emit("error", "Машина не найдена. Подключите кабель через OTG-переходник и включите питание машины.");
            return;
        }
        if (usb.hasPermission(dev)) { openPort(dev, baud); return; }
        pendingBaud = baud;
        int flags = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
        Intent intent = new Intent(ACTION_PERMISSION).setPackage(getPackageName());
        usb.requestPermission(dev, PendingIntent.getBroadcast(this, 0, intent, flags));
    }

    private void openPort(UsbDevice d, int baud) {
        closePort(null);
        try {
            port = UsbSerial.open(usb, d, baud, (data, len) -> emit("data", new String(data, 0, len, StandardCharsets.ISO_8859_1)));
            emit("open", d.getProductName() != null ? d.getProductName() : "USB");
        } catch (IOException e) {
            emit("error", e.getMessage());
        }
    }

    private void closePort(String reason) {
        UsbSerial p = port;
        port = null;
        if (p != null) {
            p.close();
            if (reason != null) emit("closed", reason);
        }
    }

    private void emit(String type, String data) {
        final String js = "window.__usb&&window.__usb(" + JSONObject.quote(type) + "," + JSONObject.quote(data == null ? "" : data) + ")";
        ui.post(() -> { if (web != null) web.evaluateJavascript(js, null); });
    }

    // ── голос, фото, вибрация ──────────────────────────────────────────

    private static final int REQ_VOICE = 41, REQ_IMAGE = 42;
    private ValueCallback<Uri[]> fileCb;
    private Uri cameraUri;

    private void emitNative(String type, String data) {
        final String js = "window.__native&&window.__native(" + JSONObject.quote(type) + "," + JSONObject.quote(data == null ? "" : data) + ")";
        ui.post(() -> { if (web != null) web.evaluateJavascript(js, null); });
    }

    private void startVoice() {
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ru-RU");
        i.putExtra(RecognizerIntent.EXTRA_PROMPT, "Диктуйте текст");
        try {
            startActivityForResult(i, REQ_VOICE);
        } catch (ActivityNotFoundException e) {
            emitNative("voice-error", "На телефоне нет распознавания речи. Установите приложение Google или используйте микрофон на клавиатуре.");
        }
    }

    /** Выбор любого файла (шрифт .ttf или почерк .kfont). */
    private boolean pickAnyFile(ValueCallback<Uri[]> cb) {
        if (fileCb != null) fileCb.onReceiveValue(null);
        fileCb = cb;
        cameraUri = null;
        Intent i = new Intent(Intent.ACTION_GET_CONTENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
        try {
            startActivityForResult(Intent.createChooser(i, "Файл шрифта"), REQ_IMAGE);
            return true;
        } catch (ActivityNotFoundException e) {
            fileCb = null;
            return false;
        }
    }

    /** Печать HTML через системную печать Android (принтер или «Сохранить как PDF»). */
    private WebView printView;
    private void printHtml(String html, String name) {
        WebView pv = new WebView(this);
        printView = pv; // держим ссылку, пока идёт печать
        pv.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                PrintAttributes attrs = new PrintAttributes.Builder()
                        .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                        .setMinMargins(PrintAttributes.Margins.NO_MARGINS).build();
                pm.print(name, view.createPrintDocumentAdapter(name), attrs);
            }
        });
        pv.loadDataWithBaseURL("https://" + HOST + "/", html, "text/html", "UTF-8", null);
    }

    /** Сохранить текстовый файл в «Загрузки». */
    private void saveFile(String name, String mime, String text) {
        try {
            byte[] data = text.getBytes(StandardCharsets.UTF_8);
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
                cv.put(MediaStore.Downloads.MIME_TYPE, mime);
                Uri u = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (u == null) throw new IOException("нет доступа к «Загрузкам»");
                try (java.io.OutputStream os = getContentResolver().openOutputStream(u)) {
                    if (os == null) throw new IOException("нет доступа к «Загрузкам»");
                    os.write(data);
                }
                emitNative("save", "Загрузки/" + name);
            } else {
                java.io.File dir = getExternalFilesDir(null);
                java.io.File f = new java.io.File(dir, name);
                try (java.io.FileOutputStream os = new java.io.FileOutputStream(f)) { os.write(data); }
                emitNative("save", f.getAbsolutePath());
            }
        } catch (Exception e) {
            emitNative("save-error", "Не удалось сохранить: " + e.getMessage());
        }
    }

    /** Выбор фото: камера или галерея. */
    private boolean pickImage(ValueCallback<Uri[]> cb) {
        if (fileCb != null) fileCb.onReceiveValue(null);
        fileCb = cb;
        Intent gallery = new Intent(Intent.ACTION_GET_CONTENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE);
        Intent chooser = Intent.createChooser(gallery, "Фото текста");
        cameraUri = null;
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.Images.Media.DISPLAY_NAME, "kalligraf_" + System.currentTimeMillis() + ".jpg");
                cv.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                cameraUri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
                if (cameraUri != null) {
                    Intent cam = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, cameraUri)
                            .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                    chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{cam});
                }
            } catch (Exception ignored) { cameraUri = null; }
        }
        try {
            startActivityForResult(chooser, REQ_IMAGE);
            return true;
        } catch (ActivityNotFoundException e) {
            fileCb = null;
            return false;
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_VOICE) {
            ArrayList<String> r = data != null ? data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS) : null;
            if (res == RESULT_OK && r != null && !r.isEmpty()) emitNative("voice", r.get(0));
            else emitNative("voice-error", "Не расслышал, попробуйте ещё раз");
        } else if (req == REQ_IMAGE && fileCb != null) {
            Uri result = null;
            if (res == RESULT_OK) {
                if (data != null && data.getData() != null) result = data.getData();
                else if (cameraUri != null) result = cameraUri; // снимок с камеры
            }
            if (result == null && cameraUri != null) {
                try { getContentResolver().delete(cameraUri, null, null); } catch (Exception ignored) { }
            }
            fileCb.onReceiveValue(result != null ? new Uri[]{result} : null);
            fileCb = null;
        }
    }

    /** Методы, доступные из JavaScript как window.KalligrafNative. */
    private final class NativeBridge {
        @JavascriptInterface
        public void voice() { ui.post(MainActivity.this::startVoice); }

        @JavascriptInterface
        public void print(String html, String name) { ui.post(() -> printHtml(html, name)); }

        @JavascriptInterface
        public void saveFile(String name, String mime, String text) { new Thread(() -> MainActivity.this.saveFile(name, mime, text)).start(); }

        @JavascriptInterface
        public void vibrate(int ms) {
            Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (v == null || !v.hasVibrator()) return;
            int d = Math.max(10, Math.min(2000, ms));
            if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createOneShot(d, VibrationEffect.DEFAULT_AMPLITUDE));
            else v.vibrate(d);
        }
    }

    /** Методы, доступные из JavaScript как window.KalligrafUsb. */
    private final class Bridge {
        @JavascriptInterface
        public void open(int baud) { ui.post(() -> connect(baud)); }

        @JavascriptInterface
        public void write(String text) {
            UsbSerial p = port;
            if (p == null) { emit("closed", "Порт закрыт"); return; }
            try {
                p.write(text.getBytes(StandardCharsets.ISO_8859_1));
            } catch (IOException e) {
                ui.post(() -> closePort(e.getMessage()));
            }
        }

        @JavascriptInterface
        public void close() { ui.post(() -> closePort(null)); }
    }
}
