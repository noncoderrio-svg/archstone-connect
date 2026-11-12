package com.archstone.connect;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

public class ArchstoneMessagingService extends FirebaseMessagingService {
    static final String EXTRA_LINK = "archstone_link";
    private static final String CHANNEL = "alerts";
    private static final String LEADS = "new_leads";
    private static final String FOLLOW_UPS = "follow_ups";
    private static final String PREFS = "archstone-push";
    private static final String TOKEN = "token";

    static String savedToken(Context context) {
        return context.getSharedPreferences(PREFS, MODE_PRIVATE).getString(TOKEN, "");
    }

    static void saveToken(Context context, String token) {
        context.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(TOKEN, token).apply();
    }

    static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        // Separate channels let each person set a different sound in their phone settings.
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "General alerts", NotificationManager.IMPORTANCE_DEFAULT));
        manager.createNotificationChannel(new NotificationChannel(LEADS, "New leads", NotificationManager.IMPORTANCE_HIGH));
        manager.createNotificationChannel(new NotificationChannel(FOLLOW_UPS, "Follow-up reminders", NotificationManager.IMPORTANCE_HIGH));
    }

    private static String channelFor(String kind) {
        if ("new_lead".equals(kind)) return LEADS;
        if ("followup".equals(kind) || "overdue".equals(kind) || "team".equals(kind)) return FOLLOW_UPS;
        return CHANNEL;
    }

    @Override
    public void onNewToken(@NonNull String token) {
        saveToken(this, token);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> data = message.getData();
        createChannel(this);

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        open.putExtra(EXTRA_LINK, data.get("link"));
        int id = (int) System.currentTimeMillis();
        PendingIntent tap = PendingIntent.getActivity(this, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder alert = new NotificationCompat.Builder(this, channelFor(data.get("kind")))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(data.get("title"))
            .setContentText(data.get("body"))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(tap);
        getSystemService(NotificationManager.class).notify(id, alert.build());
    }
}
