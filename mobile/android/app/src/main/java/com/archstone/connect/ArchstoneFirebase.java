package com.archstone.connect;

import android.content.Context;
import android.content.SharedPreferences;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.messaging.FirebaseMessaging;
import org.json.JSONObject;

/**
 * Starts Firebase from the settings an admin uploaded in Archstone Connect
 * (Settings → Integrations), so the Firebase project can be replaced without
 * rebuilding the app. A google-services.json built into the app still works.
 */
final class ArchstoneFirebase {
    private static final String PREFS = "archstone-firebase";
    private static final String CONFIG = "config";

    private ArchstoneFirebase() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static FirebaseOptions optionsFrom(String json) {
        try {
            JSONObject c = new JSONObject(json);
            return new FirebaseOptions.Builder()
                .setProjectId(c.getString("project_id"))
                .setGcmSenderId(c.getString("sender_id"))
                .setApplicationId(c.getString("app_id"))
                .setApiKey(c.getString("api_key"))
                .build();
        } catch (Exception e) {
            return null;
        }
    }

    /** Called when the app process starts, before any notification arrives. */
    static synchronized void start(Context context) {
        if (!FirebaseApp.getApps(context).isEmpty()) return;
        FirebaseOptions options = optionsFrom(prefs(context).getString(CONFIG, ""));
        if (options != null) FirebaseApp.initializeApp(context, options);
    }

    /** The page passes the server's current settings. A change replaces the running Firebase project. */
    static synchronized void configure(Context context, String json) {
        if (json == null || json.isEmpty()) return;
        String saved = prefs(context).getString(CONFIG, "");
        FirebaseOptions options = optionsFrom(json);
        if (options == null || json.equals(saved) && !FirebaseApp.getApps(context).isEmpty()) {
            refreshToken(context);
            return;
        }
        prefs(context).edit().putString(CONFIG, json).apply();
        if (!FirebaseApp.getApps(context).isEmpty()) {
            FirebaseApp current = FirebaseApp.getInstance();
            if (options.getProjectId() != null && options.getProjectId().equals(current.getOptions().getProjectId())
                && options.getApplicationId().equals(current.getOptions().getApplicationId())) {
                refreshToken(context);
                return;
            }
            current.delete();
        }
        ArchstoneMessagingService.saveToken(context, "");
        FirebaseApp.initializeApp(context, options);
        refreshToken(context);
    }

    static void refreshToken(Context context) {
        if (FirebaseApp.getApps(context).isEmpty()) return;
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> ArchstoneMessagingService.saveToken(context, token));
    }
}
