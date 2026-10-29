package lab.omega.manager;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.DateFormat;
import java.util.Date;

/** The red alert notifications and the quiet "connected" notification the background service needs. */
final class Notifier {
    static final String CH_ALERTS = "alerts";
    static final String CH_QUIET = "alerts_quiet";
    static final String CH_LINK = "link";
    static final String CH_UPDATES = "updates";
    static final int LINK_ID = 1;
    static final int UPDATE_ID = 2;
    static final int RED = 0xFFD32F2F;

    static void channels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        AudioAttributes alarm = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build();
        long[] buzz = {0, 400, 200, 400, 200, 800};

        NotificationChannel a = new NotificationChannel(CH_ALERTS, "Timer alerts", NotificationManager.IMPORTANCE_HIGH);
        a.setDescription("A timer from Omega Manager is done.");
        a.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM), alarm);
        a.enableVibration(true);
        a.setVibrationPattern(buzz);
        a.enableLights(true);
        a.setLightColor(Color.RED);
        a.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);

        NotificationChannel q = new NotificationChannel(CH_QUIET, "Timer alerts (no sound)", NotificationManager.IMPORTANCE_HIGH);
        q.setDescription("Timers whose 'Play a sound' is off.");
        q.setSound(null, null);
        q.enableVibration(true);
        q.setVibrationPattern(buzz);
        q.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);

        NotificationChannel l = new NotificationChannel(CH_LINK, "Connection to the PC", NotificationManager.IMPORTANCE_MIN);
        l.setDescription("Shown while the app keeps its connection to Omega Manager.");
        l.setShowBadge(false);

        nm.createNotificationChannel(a);
        nm.createNotificationChannel(q);
        nm.createNotificationChannel(l);

        NotificationChannel u = new NotificationChannel(CH_UPDATES, "App updates", NotificationManager.IMPORTANCE_DEFAULT);
        u.setDescription("New versions of this app from Omega Manager on your PC.");
        u.setSound(null, null);
        nm.createNotificationChannel(u);
    }

    /** The one app-update notification. progress 0..100 shows a bar; -1 none. */
    static void showUpdate(Context c, String title, String text, PendingIntent tap, int progress) {
        channels(c);
        Notification.Builder b = new Notification.Builder(c, CH_UPDATES)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(RED)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setOnlyAlertOnce(true)
                .setAutoCancel(progress < 0)
                .setOngoing(progress >= 0);
        if (tap != null) b.setContentIntent(tap);
        if (progress >= 0) b.setProgress(100, progress, false);
        c.getSystemService(NotificationManager.class).notify(UPDATE_ID, b.build());
    }

    static void cancelUpdate(Context c) { c.getSystemService(NotificationManager.class).cancel(UPDATE_ID); }

    static Notification link(Context c, String text) {
        PendingIntent open = PendingIntent.getActivity(c, 0, new Intent(c, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(c, CH_LINK)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(RED)
                .setContentTitle("Omega Manager")
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .setShowWhen(false)
                .build();
    }

    /** Notification ids per alert: the PC numbers alerts from 1 each time it starts, so the boot id is part of the key. */
    static int idFor(String bootId, String alertId) { return ("alert:" + bootId + ":" + alertId).hashCode() | 0x100; }

    static String hm(long ms) { return DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date(ms)); }

    static void showAlert(Context c, JSONObject a, String bootId) {
        String id = a.optString("id");
        int nid = idFor(bootId, id);
        String title = a.optString("title", "Timer");
        String msg = a.optString("message", "");
        boolean preview = a.optBoolean("preview");
        long firedAt = a.optLong("firedAt", System.currentTimeMillis());
        String kind = preview ? "TEST" : "TIMER DONE";
        String late = a.optBoolean("late") ? "It was due at " + hm(a.optLong("dueAt")) + ", while the PC app was closed." : "";

        RemoteViews small = new RemoteViews(c.getPackageName(), R.layout.notif_alert);
        small.setTextViewText(R.id.n_title, title);
        small.setTextViewText(R.id.n_msg, msg.isEmpty() ? kind.toLowerCase() : msg);
        RemoteViews big = new RemoteViews(c.getPackageName(), R.layout.notif_alert_big);
        big.setTextViewText(R.id.n_kind, kind + "  ·  " + hm(firedAt));
        big.setTextViewText(R.id.n_title, title);
        big.setTextViewText(R.id.n_msg, msg);
        big.setTextViewText(R.id.n_late, late);

        Intent full = new Intent(c, AlertActivity.class)
                .putExtra("alert", a.toString()).putExtra("boot", bootId)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        PendingIntent fullPi = PendingIntent.getActivity(c, nid, full, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification.Builder b = new Notification.Builder(c, a.optBoolean("sound", true) ? CH_ALERTS : CH_QUIET)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(RED)
                .setStyle(new Notification.DecoratedCustomViewStyle())
                .setCustomContentView(small)
                .setCustomHeadsUpContentView(small)
                .setCustomBigContentView(big)
                .setContentTitle(title)
                .setContentText(msg)
                .setCategory(Notification.CATEGORY_ALARM)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setWhen(firedAt)
                .setShowWhen(true)
                .setAutoCancel(true)
                .setContentIntent(fullPi)
                .setDeleteIntent(ActionReceiver.intent(c, bootId, id, "dismiss", 0, nid));
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent()) b.setFullScreenIntent(fullPi, true);

        if (a.optBoolean("canSnooze")) {
            JSONArray sn = a.optJSONArray("snooze");
            for (int i = 0; sn != null && i < sn.length() && i < 2; i++) {
                int m = sn.optInt(i);
                b.addAction(new Notification.Action.Builder(Icon.createWithResource(c, R.drawable.ic_stat), "Snooze " + m + " min",
                        ActionReceiver.intent(c, bootId, id, "snooze", m, nid)).build());
            }
        }
        b.addAction(new Notification.Action.Builder(Icon.createWithResource(c, R.drawable.ic_stat), "Dismiss",
                ActionReceiver.intent(c, bootId, id, "dismiss", 0, nid)).build());
        nm.notify(nid, b.build());
    }

    static void cancelAlert(Context c, String bootId, String alertId) {
        c.getSystemService(NotificationManager.class).cancel(idFor(bootId, alertId));
        AlertActivity.closeIf(bootId, alertId);
    }
}
