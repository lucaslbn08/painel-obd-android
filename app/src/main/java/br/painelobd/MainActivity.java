package br.painelobd;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.StrictMode;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.speech.tts.TextToSpeech;
import android.util.Base64;
import android.webkit.ValueCallback;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.UUID;

public class MainActivity extends Activity {
    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final int REQ_BT = 42;
    private static final int REQ_FILE = 43;
    private TextToSpeech tts;
    private boolean ttsReady;
    private ValueCallback<Uri[]> fileCb;

    private WebView web;
    private volatile BluetoothSocket socket;
    private volatile OutputStream out;
    private volatile boolean closing;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.parseColor("#10161e"));
        getWindow().setNavigationBarColor(Color.parseColor("#10161e"));
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0a0e13"));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        web.setWebViewClient(new WebViewClient());
        // permite compartilhar arquivos em Androids antigos (antes do 10)
        StrictMode.setVmPolicy(new StrictMode.VmPolicy.Builder().build());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try { startActivityForResult(Intent.createChooser(i, "Escolha o backup"), REQ_FILE); }
                catch (Exception e) { fileCb = null; return false; }
                return true;
            }
        });
        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) {
                int r = tts.setLanguage(new Locale("pt", "BR"));
                ttsReady = r != TextToSpeech.LANG_MISSING_DATA && r != TextToSpeech.LANG_NOT_SUPPORTED;
                if (!ttsReady) ttsReady = tts.setLanguage(Locale.getDefault()) >= 0;
            }
        });
        web.addJavascriptInterface(new Bridge(), "AndroidBT");
        setContentView(web);
        web.loadUrl("file:///android_asset/www/index.html");
    }

    @Override
    protected void onDestroy() {
        disconnect();
        if (tts != null) tts.shutdown();
        super.onDestroy();
    }

    @Override
    protected void onPause() { super.onPause(); if (web != null) web.onPause(); }

    @Override
    protected void onResume() { super.onResume(); if (web != null) web.onResume(); }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == REQ_FILE && fileCb != null) {
            Uri u = (result == RESULT_OK && data != null) ? data.getData() : null;
            fileCb.onReceiveValue(u == null ? null : new Uri[]{u});
            fileCb = null;
        }
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(window.onAndroidBack ? window.onAndroidBack() : 0)",
                v -> { if (!"1".equals(v)) moveTaskToBack(true); });
    }

    // ------------------------------------------------------------------ arquivos
    /** Grava em Downloads/Painel OBD (ou Pictures/Painel OBD para imagens). Retorna [uri, caminho legível]. */
    private Object[] writePublic(String name, byte[] bytes, String mime) throws IOException {
        boolean img = mime.startsWith("image/");
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            String dir = (img ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS) + "/Painel OBD";
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, dir);
            Uri coll = img ? MediaStore.Images.Media.EXTERNAL_CONTENT_URI : MediaStore.Downloads.EXTERNAL_CONTENT_URI;
            Uri uri = getContentResolver().insert(coll, v);
            if (uri == null) throw new IOException("sem acesso ao armazenamento");
            try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                if (os == null) throw new IOException("sem acesso ao armazenamento");
                os.write(bytes);
            }
            return new Object[]{uri, dir + "/" + name};
        } else {
            File d = new File(getExternalFilesDir(null), "Painel OBD");
            if (!d.exists() && !d.mkdirs()) throw new IOException("sem acesso ao armazenamento");
            File f = new File(d, name);
            try (FileOutputStream os = new FileOutputStream(f)) { os.write(bytes); }
            return new Object[]{Uri.fromFile(f), f.getAbsolutePath()};
        }
    }

    private void shareUri(Uri uri, String mime, String title) {
        Intent s = new Intent(Intent.ACTION_SEND);
        s.setType(mime);
        s.putExtra(Intent.EXTRA_STREAM, uri);
        s.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent c = Intent.createChooser(s, title);
        c.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        runOnUiThread(() -> { try { startActivity(c); } catch (Exception ignored) { } });
    }

    // ------------------------------------------------------------------ util
    private void js(final String code) {
        runOnUiThread(() -> { if (web != null) web.evaluateJavascript(code, null); });
    }

    private void event(String kind, String msg) {
        js("window.btEvent(" + JSONObject.quote(kind) + "," + JSONObject.quote(msg == null ? "" : msg) + ")");
    }

    private BluetoothAdapter adapter() {
        BluetoothManager m = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        return m == null ? null : m.getAdapter();
    }

    private boolean hasBtPermission() {
        if (Build.VERSION.SDK_INT >= 31)
            return checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
        return true;
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        if (code == REQ_BT) event("perm", res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED ? "granted" : "denied");
    }

    private synchronized void disconnect() {
        closing = true;
        try { if (socket != null) socket.close(); } catch (IOException ignored) { }
        socket = null;
        out = null;
    }

    @SuppressLint("MissingPermission")
    private BluetoothSocket openSocket(BluetoothDevice dev) throws IOException {
        IOException last = null;
        // 1) padrão SPP  2) SPP sem criptografia  3) canal 1 direto (clones chineses)
        for (int attempt = 0; attempt < 3; attempt++) {
            BluetoothSocket s = null;
            try {
                if (attempt == 0) s = dev.createRfcommSocketToServiceRecord(SPP);
                else if (attempt == 1) s = dev.createInsecureRfcommSocketToServiceRecord(SPP);
                else {
                    Method m = dev.getClass().getMethod("createRfcommSocket", int.class);
                    s = (BluetoothSocket) m.invoke(dev, 1);
                }
                s.connect();
                return s;
            } catch (Exception e) {
                last = e instanceof IOException ? (IOException) e : new IOException(e.toString());
                try { if (s != null) s.close(); } catch (IOException ignored) { }
            }
        }
        throw last;
    }

    // ------------------------------------------------------------------ ponte JS
    private class Bridge {
        @JavascriptInterface
        public boolean hasPermission() { return hasBtPermission(); }

        @JavascriptInterface
        public void requestPermission() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 31)
                    requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT}, REQ_BT);
                else event("perm", "granted");
            });
        }

        @JavascriptInterface
        public boolean isEnabled() {
            BluetoothAdapter a = adapter();
            return a != null && a.isEnabled();
        }

        @SuppressLint("MissingPermission")
        @JavascriptInterface
        public String paired() {
            JSONArray arr = new JSONArray();
            try {
                BluetoothAdapter a = adapter();
                if (a != null && hasBtPermission()) {
                    for (BluetoothDevice d : a.getBondedDevices()) {
                        JSONObject o = new JSONObject();
                        o.put("addr", d.getAddress());
                        o.put("name", d.getName() == null ? "" : d.getName());
                        arr.put(o);
                    }
                }
            } catch (Exception ignored) { }
            return arr.toString();
        }

        @JavascriptInterface
        public void openBluetoothSettings() {
            runOnUiThread(() -> {
                try { startActivity(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS)); }
                catch (Exception e) { startActivity(new Intent(Settings.ACTION_SETTINGS)); }
            });
        }

        @SuppressLint("MissingPermission")
        @JavascriptInterface
        public void connect(final String address) {
            disconnect();
            new Thread(() -> {
                BluetoothAdapter a = adapter();
                if (a == null) { event("error", "Este celular não tem Bluetooth."); return; }
                if (!a.isEnabled()) { event("error", "O Bluetooth do celular está desligado. Ligue e tente de novo."); return; }
                if (!hasBtPermission()) { event("error", "O app não tem permissão de Bluetooth."); return; }
                try { a.cancelDiscovery(); } catch (Exception ignored) { }
                final BluetoothSocket s;
                try {
                    s = openSocket(a.getRemoteDevice(address));
                } catch (Exception e) {
                    event("error", "Não foi possível conectar ao adaptador.\n\nConfira:\n" +
                            "• O adaptador está na tomada OBD do carro e a luz Power está acesa.\n" +
                            "• A ignição do carro está ligada.\n" +
                            "• Nenhum outro aparelho (notebook, outro celular) está conectado nele.\n\n" +
                            "Detalhe técnico: " + e.getMessage());
                    return;
                }
                InputStream in;
                try {
                    in = s.getInputStream();
                    out = s.getOutputStream();
                } catch (IOException e) {
                    event("error", "Falha ao abrir a comunicação: " + e.getMessage());
                    return;
                }
                socket = s;
                closing = false;
                event("connected", "");
                byte[] buf = new byte[1024];
                try {
                    while (true) {
                        int n = in.read(buf);
                        if (n < 0) break;
                        if (n > 0) js("window.btData(" + JSONObject.quote(new String(buf, 0, n, StandardCharsets.ISO_8859_1)) + ")");
                    }
                    if (!closing) event("closed", "adaptador desconectado");
                } catch (IOException e) {
                    if (!closing) event("closed", e.getMessage());
                }
            }, "bt-reader").start();
        }

        @JavascriptInterface
        public void write(String data) {
            OutputStream o = out;
            if (o == null) { event("closed", "não conectado"); return; }
            try {
                o.write(data.getBytes(StandardCharsets.ISO_8859_1));
                o.flush();
            } catch (IOException e) {
                event("closed", e.getMessage());
            }
        }

        @JavascriptInterface
        public void disconnect() { MainActivity.this.disconnect(); }

        @JavascriptInterface
        public String saveFile2(String name, String content, String mime) {
            try { return (String) writePublic(name, content.getBytes(StandardCharsets.UTF_8), mime)[1]; }
            catch (Exception e) { return ""; }
        }

        @JavascriptInterface
        public String shareText(String name, String content, String mime) {
            try {
                Object[] r = writePublic(name, content.getBytes(StandardCharsets.UTF_8), mime);
                shareUri((Uri) r[0], mime, "Enviar arquivo");
                return (String) r[1];
            } catch (Exception e) { return ""; }
        }

        @JavascriptInterface
        public String shareImage(String base64, String name) {
            try {
                Object[] r = writePublic(name, Base64.decode(base64, Base64.DEFAULT), "image/png");
                shareUri((Uri) r[0], "image/png", "Enviar relatório");
                return (String) r[1];
            } catch (Exception e) { return ""; }
        }

        @JavascriptInterface
        public void speak(String text) {
            if (tts != null && ttsReady) tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "alerta");
        }

        @JavascriptInterface
        public void vibrate(String pattern) {
            try {
                String[] p = pattern.split(",");
                long[] t = new long[p.length];
                for (int i = 0; i < p.length; i++) t[i] = Long.parseLong(p[i].trim());
                Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                if (v == null) return;
                if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createWaveform(t, -1));
                else v.vibrate(t, -1);
            } catch (Exception ignored) { }
        }

        @JavascriptInterface
        public void setBrightness(final boolean full) {
            runOnUiThread(() -> {
                WindowManager.LayoutParams lp = getWindow().getAttributes();
                lp.screenBrightness = full ? 1f : WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
                getWindow().setAttributes(lp);
            });
        }

        @JavascriptInterface
        public String appVersion() {
            try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
            catch (Exception e) { return "?"; }
        }

        /** Salva texto na pasta Downloads/Painel OBD. Retorna o local ou "" em caso de erro. */
        @JavascriptInterface
        public String saveFile(String name, String content) {
            byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, "text/csv");
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Painel OBD");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) return "";
                    try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                        if (os == null) return "";
                        os.write(bytes);
                    }
                    return "Downloads/Painel OBD/" + name;
                } else {
                    File dir = new File(getExternalFilesDir(null), "trajetos");
                    if (!dir.exists() && !dir.mkdirs()) return "";
                    File f = new File(dir, name);
                    try (FileOutputStream os = new FileOutputStream(f)) { os.write(bytes); }
                    return f.getAbsolutePath();
                }
            } catch (Exception e) {
                return "";
            }
        }
    }
}
