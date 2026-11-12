package com.archstone.connect;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    private static final int BAR_COLOR = 0xFF15181E;
    private volatile String pendingLink = "";

    /** The web app reads the phone's notification token and any tapped alert through this. */
    private final class ArchstoneApp {
        @JavascriptInterface
        public String pushToken() {
            return ArchstoneMessagingService.savedToken(MainActivity.this);
        }

        @JavascriptInterface
        public void configureFirebase(String json) {
            ArchstoneFirebase.configure(MainActivity.this, json);
        }

        @JavascriptInterface
        public String takeLink() {
            String link = pendingLink;
            pendingLink = "";
            return link;
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        pendingLink = linkFrom(getIntent());
        getBridge().getWebView().addJavascriptInterface(new ArchstoneApp(), "ArchstoneApp");
        keepContentClearOfSystemBars();
        handleBackButton();
        ArchstoneMessagingService.createChannel(this);
        askForNotifications();
        ArchstoneFirebase.start(this);
        ArchstoneFirebase.refreshToken(this);
    }

    /**
     * Android 15 and later draw apps behind the status and navigation bars, which hid
     * the header. This keeps the page inside the safe area, and above the keyboard.
     */
    private void keepContentClearOfSystemBars() {
        View root = findViewById(android.R.id.content);
        root.setBackgroundColor(BAR_COLOR);
        WindowInsetsControllerCompat bars = new WindowInsetsControllerCompat(getWindow(), getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(false);
        bars.setAppearanceLightNavigationBars(false);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            int types = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime();
            Insets safe = insets.getInsets(types);
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(root);
    }

    /** The phone's back button goes to the previous screen, not out of the app. */
    private void handleBackButton() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView page = getBridge().getWebView();
                if (page.canGoBack()) page.goBack();
                else finish();
            }
        });
    }

    /** The app is already open, so the running page moves to the alert's screen. */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String link = linkFrom(intent);
        if (link.isEmpty()) return;
        String script = "window.archstoneOpen && window.archstoneOpen(" + JSONObject.quote(link) + ")";
        getBridge().getWebView().evaluateJavascript(script, null);
    }

    private static String linkFrom(Intent intent) {
        String link = intent == null ? null : intent.getStringExtra(ArchstoneMessagingService.EXTRA_LINK);
        return link == null ? "" : link;
    }

    private void askForNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        String permission = Manifest.permission.POST_NOTIFICATIONS;
        if (ContextCompat.checkSelfPermission(this, permission) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[] { permission }, 1);
        }
    }
}
