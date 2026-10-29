package lab.omega.manager;

import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.widget.Toast;

/** Dismiss / Snooze from a notification button (or swiping it away): tells Omega Manager on the PC. */
public final class ActionReceiver extends BroadcastReceiver {

    static PendingIntent intent(Context c, String bootId, String alertId, String action, int minutes, int nid) {
        Intent i = new Intent(c, ActionReceiver.class)
                .setAction("lab.omega.manager.ALERT_" + action.toUpperCase() + "_" + minutes)
                .putExtra("boot", bootId).putExtra("id", alertId).putExtra("action", action)
                .putExtra("minutes", minutes).putExtra("nid", nid);
        int code = nid * 31 + action.hashCode() + minutes;
        return PendingIntent.getBroadcast(c, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @Override
    public void onReceive(Context c, Intent i) {
        String boot = i.getStringExtra("boot"), id = i.getStringExtra("id"), action = i.getStringExtra("action");
        int minutes = i.getIntExtra("minutes", 5);
        c.getSystemService(NotificationManager.class).cancel(i.getIntExtra("nid", 0));
        AlertActivity.closeIf(boot, id);
        PendingResult done = goAsync();
        send(c.getApplicationContext(), id, action, minutes, done);
    }

    /** Sends the action on a background thread; a failure shows a short message. */
    static void send(final Context c, final String alertId, final String action, final int minutes, final PendingResult done) {
        new Thread(() -> {
            try {
                new Prefs(c).client().post("/api/alerts/" + alertId + "/" + action, "{\"minutes\":" + minutes + "}");
                if (action.equals("snooze")) toast(c, "Snoozed for " + minutes + " min.");
            } catch (Exception e) {
                toast(c, "Could not reach Omega Manager: " + e.getMessage());
            } finally {
                if (done != null) done.finish();
            }
        }, "omega-action").start();
    }

    static void toast(final Context c, final String text) {
        new Handler(Looper.getMainLooper()).post(() -> Toast.makeText(c, text, Toast.LENGTH_LONG).show());
    }
}
