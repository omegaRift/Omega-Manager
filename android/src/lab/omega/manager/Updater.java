package lab.omega.manager;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.os.Build;

import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;

/**
 * Updates this app from the APK that Omega Manager on the PC offers (GET /omega-manager.apk).
 * The PC says which version it has in its "hello" and "app" events. With Auto updates on, the app downloads and
 * installs it by itself (Android 12+ lets an app update itself without asking; older Android, or when Android still
 * wants a tap, gets a "Tap to install" notification). With Auto updates off it only offers the update.
 */
final class Updater {
    static volatile JSONObject latest;      // what the PC offers (any version)
    static volatile String status = "";     // shown on the main screen
    static volatile int progress = -1;      // 0..100 while downloading
    static volatile boolean busy;
    private static long autoVersion, autoAt;
    private static volatile boolean offerShown;   // an Update available/ready notice from this run is up

    static long installed(Context c) {
        try {
            PackageInfo pi = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
        } catch (Exception e) { return 0; }
    }

    static String installedName(Context c) {
        try { return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
    }

    /** The newer app the PC has, or null when this phone is up to date. */
    static JSONObject newer(Context c) {
        JSONObject a = latest;
        return a != null && a.optLong("versionCode") > installed(c) ? a : null;
    }

    static String label(JSONObject a) { return a.optString("versionName") + ", build " + a.optLong("versionCode"); }

    static boolean allowed(Context c) { return c.getPackageManager().canRequestPackageInstalls(); }

    /** From the link service: the PC told us which app it offers. */
    static synchronized void offer(Context c, JSONObject app) {
        if (app == null || !app.has("versionCode")) return;
        boolean changed = latest == null || latest.optLong("versionCode") != app.optLong("versionCode");
        latest = app;
        JSONObject a = newer(c);
        if (a == null) { if (!busy) { status = ""; if (offerShown) Notifier.cancelUpdate(c); offerShown = false; } return; }
        if (new Prefs(c).autoUpdate()) {
            // Each version is tried by itself at most once an hour, so a failing update can't loop.
            long v = a.optLong("versionCode"), now = System.currentTimeMillis();
            if (busy || (v == autoVersion && now - autoAt < 3600_000L)) return;
            autoVersion = v;
            autoAt = now;
            install(c, false);
        } else if (changed) {
            offerShown = true;
            Notifier.showUpdate(c, "Update available", "Version " + label(a) + " is on your PC. Tap to install it.", openApp(c, true), -1);
        }
    }

    /** The Auto updates switch was turned on: start at once if an update is waiting. */
    static void autoTurnedOn(Context c) {
        autoVersion = 0;
        JSONObject a = latest;
        if (a != null) offer(c, a);
    }

    static PendingIntent openApp(Context c, boolean install) {
        Intent i = new Intent(c, MainActivity.class).putExtra("install", install).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, install ? 21 : 20, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** Downloads the PC's APK into an install session and hands it to Android. byUser: a tap started it. */
    static synchronized void install(Context c0, final boolean byUser) {
        final Context c = c0.getApplicationContext();
        final JSONObject a = newer(c);
        if (a == null || busy) return;
        if (!allowed(c)) {
            status = "Allow Omega Manager to install updates (one time).";
            if (!byUser) { offerShown = true; Notifier.showUpdate(c, "Update ready", "Version " + label(a) + ": tap, then allow Omega Manager to install updates.", openApp(c, true), -1); }
            return;
        }
        busy = true;
        progress = 0;
        status = "Downloading version " + label(a) + "…";
        offerShown = true;
        Notifier.showUpdate(c, "Updating Omega Manager", status, openApp(c, false), 0);
        new Thread(() -> {
            PackageInstaller.Session s = null;
            try {
                PackageInstaller pi = c.getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                p.setAppPackageName(c.getPackageName());
                long size = a.optLong("size");
                if (size > 0) p.setSize(size);
                if (Build.VERSION.SDK_INT >= 31) p.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
                s = pi.openSession(pi.createSession(p));
                String sha;
                OutputStream out = s.openWrite("omega-manager.apk", 0, size > 0 ? size : -1);
                try {
                    final long[] shown = {-1};
                    sha = new Prefs(c).client().download("/omega-manager.apk", out, size, pct -> {
                        progress = pct;
                        if (pct >= shown[0] + 5) { shown[0] = pct; Notifier.showUpdate(c, "Updating Omega Manager", status, openApp(c, false), pct); }
                    });
                    s.fsync(out);
                } finally { out.close(); }
                if (!sha.equalsIgnoreCase(a.optString("sha256")))
                    throw new IOException("The download did not match what the PC described (it may have been rebuilt meanwhile). Try again.");
                progress = -1;
                status = "Installing version " + label(a) + "…";
                Notifier.showUpdate(c, "Updating Omega Manager", status, openApp(c, false), -1);
                Intent done = new Intent(c, UpdateReceiver.class).putExtra("label", label(a));
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                s.commit(PendingIntent.getBroadcast(c, 22, done, flags).getIntentSender());
                s.close();
                s = null;
            } catch (Exception e) {
                if (s != null) try { s.abandon(); } catch (Exception ignored) { }
                busy = false;
                progress = -1;
                status = "Update failed: " + LinkService.friendly(e);
                Notifier.showUpdate(c, "Update failed", status, openApp(c, false), -1);
            }
        }, "omega-update").start();
    }

    /** Android's answer about the install (UpdateReceiver). */
    static void finished(Context c, Intent i) {
        int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        String label = i.getStringExtra("label");
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            // Android wants a tap on its own Install/Update screen.
            busy = false;
            Intent confirm = Build.VERSION.SDK_INT >= 33 ? i.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class) : (Intent) i.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm == null) { status = "Update failed: Android did not show its install screen."; return; }
            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            status = "Tap Update on Android's screen to finish.";
            if (MainActivity.visible) {
                try { c.startActivity(confirm); Notifier.cancelUpdate(c); return; } catch (Exception ignored) { }
            }
            PendingIntent tap = PendingIntent.getActivity(c, 23, confirm, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notifier.showUpdate(c, "Update downloaded", "Tap to install version " + label + ".", tap, -1);
        } else if (st == PackageInstaller.STATUS_SUCCESS) {
            busy = false;
            status = "";
            Notifier.cancelUpdate(c);      // Android restarts the app; BootReceiver reconnects it
        } else {
            busy = false;
            progress = -1;
            String m = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            status = st == PackageInstaller.STATUS_FAILURE_ABORTED ? "The update was cancelled." : "Update failed" + (m == null ? "." : ": " + m);
            Notifier.showUpdate(c, st == PackageInstaller.STATUS_FAILURE_ABORTED ? "Update cancelled" : "Update failed", status + " Open the app to try again.", openApp(c, false), -1);
        }
    }
}
