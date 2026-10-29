package lab.omega.manager;

import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.util.HashSet;
import java.util.Set;

/**
 * Keeps one live connection to Omega Manager (over Tailscale) and turns its events into notifications.
 * Runs as a foreground service so Android keeps it, and its network, alive while the screen is off.
 */
public final class LinkService extends Service {
    // What the main screen shows. Written by the service thread, read once a second by MainActivity.
    static volatile String state = "off";          // off | connecting | connected | waiting | unpaired
    static volatile String detail = "";
    static volatile String server = "";
    static volatile JSONArray timers = new JSONArray();
    static volatile long clockOffset = 0;          // phone clock - PC clock

    private volatile boolean running;
    private volatile HttpURLConnection conn;
    private Thread worker;
    private final Object nap = new Object();
    private ConnectivityManager.NetworkCallback netCb;
    private String bootId = "";
    private final Set<String> shown = new HashSet<>();

    static void start(Context c) {
        if (!new Prefs(c).paired()) return;
        c.startForegroundService(new Intent(c, LinkService.class));
    }

    static void stop(Context c) { c.stopService(new Intent(c, LinkService.class)); }

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notifier.channels(this);
        if (Build.VERSION.SDK_INT >= 34) startForeground(Notifier.LINK_ID, Notifier.link(this, "Connecting…"), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(Notifier.LINK_ID, Notifier.link(this, "Connecting…"));
        if (worker == null || !worker.isAlive()) {
            running = true;
            worker = new Thread(this::loop, "omega-link");
            worker.start();
            watchNetwork();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        HttpURLConnection c = conn;
        if (c != null) c.disconnect();
        wake();
        if (netCb != null) try { getSystemService(ConnectivityManager.class).unregisterNetworkCallback(netCb); } catch (Exception ignored) { }
        state = new Prefs(this).paired() ? "off" : "unpaired";
        super.onDestroy();
    }

    // When a network comes back (Wi-Fi, mobile data, Tailscale), try again at once instead of waiting.
    private void watchNetwork() {
        netCb = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network n) { wake(); }
        };
        try { getSystemService(ConnectivityManager.class).registerDefaultNetworkCallback(netCb); } catch (Exception ignored) { }
    }

    private void wake() { synchronized (nap) { nap.notifyAll(); } }

    private void setState(String s, String d) {
        state = s;
        detail = d == null ? "" : d;
        String text;
        switch (s) {
            case "connected": text = "Connected to " + server + timersText(); break;
            case "connecting": text = "Connecting…"; break;
            default: text = "Not connected" + (detail.isEmpty() ? "" : ": " + detail);
        }
        getSystemService(NotificationManager.class).notify(Notifier.LINK_ID, Notifier.link(this, text));
    }

    private static String timersText() {
        int n = timers.length();
        return n == 0 ? "" : " · " + n + " timer" + (n == 1 ? "" : "s") + " running";
    }

    private void loop() {
        long backoff = 2000;
        while (running) {
            Prefs prefs = new Prefs(this);
            if (!prefs.paired()) { state = "unpaired"; stopSelf(); return; }
            long started = System.currentTimeMillis();
            try {
                setState("connecting", null);
                LinkClient client = prefs.client();
                client.appVersion = Updater.installed(this);               // the PC shows whether this phone is up to date
                HttpURLConnection c = client.openEvents(75000);           // the PC pings every 20 s
                conn = c;
                try {
                    new SseReader(c.getInputStream()).run(this::onEvent, null);
                } finally {
                    c.disconnect();
                    conn = null;
                }
                if (running) setState("waiting", "The PC closed the connection.");
            } catch (LinkClient.LinkException e) {
                if (e.status == 401) {
                    prefs.unpair();
                    setState("unpaired", e.getMessage());
                    stopSelf();
                    return;
                }
                setState("waiting", e.getMessage());
            } catch (Exception e) {
                if (!running) return;
                setState("waiting", friendly(e));
            }
            if (System.currentTimeMillis() - started > 30000) backoff = 2000;
            synchronized (nap) { try { nap.wait(backoff); } catch (InterruptedException ignored) { } }
            backoff = Math.min(60000, backoff * 2);
        }
    }

    static String friendly(Exception e) {
        String m = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        if (e instanceof java.net.UnknownHostException) return "Can't find the PC. Is Tailscale on?";
        if (e instanceof java.net.SocketTimeoutException) return "The PC did not answer. Is Omega Manager running?";
        if (e instanceof java.net.ConnectException) return "Can't connect to the PC. Is Omega Manager running?";
        return m;
    }

    private void onEvent(String event, String data) throws Exception {
        JSONObject j = new JSONObject(data);
        switch (event) {
            case "hello": {
                String boot = j.optString("bootId");
                if (!boot.equals(bootId)) { clearShown(); bootId = boot; }   // the PC restarted: its old alerts are gone
                server = j.optString("server");
                clockOffset = System.currentTimeMillis() - j.optLong("now", System.currentTimeMillis());
                timers = j.optJSONArray("timers") == null ? new JSONArray() : j.optJSONArray("timers");
                // Alerts still ringing on the PC: show the ones this phone has not shown yet, drop the rest.
                Set<String> open = new HashSet<>();
                JSONArray alerts = j.optJSONArray("alerts");
                for (int i = 0; alerts != null && i < alerts.length(); i++) {
                    JSONObject a = alerts.getJSONObject(i);
                    open.add(a.optString("id"));
                    if (!shown.contains(a.optString("id"))) alert(a);
                }
                for (String id : new HashSet<>(shown)) if (!open.contains(id)) { Notifier.cancelAlert(this, bootId, id); shown.remove(id); }
                setState("connected", null);
                Updater.offer(this, j.optJSONObject("app"));
                break;
            }
            case "app": Updater.offer(this, j); break;      // the app was rebuilt on the PC
            case "alert": alert(j); break;
            case "alert-closed": {
                String id = j.optString("id");
                Notifier.cancelAlert(this, bootId, id);
                shown.remove(id);
                break;
            }
            case "timers": {
                clockOffset = System.currentTimeMillis() - j.optLong("now", System.currentTimeMillis());
                timers = j.optJSONArray("timers") == null ? new JSONArray() : j.optJSONArray("timers");
                setState("connected", null);
                break;
            }
            default: break;
        }
    }

    private void alert(JSONObject a) {
        shown.add(a.optString("id"));
        PowerManager.WakeLock wl = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "omega:alert");
        wl.acquire(10000);
        try { Notifier.showAlert(this, a, bootId); } finally { wl.release(); }
    }

    private void clearShown() {
        for (String id : shown) Notifier.cancelAlert(this, bootId, id);
        shown.clear();
    }
}
