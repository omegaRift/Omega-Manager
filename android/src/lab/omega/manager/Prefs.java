package lab.omega.manager;

import android.content.Context;
import android.content.SharedPreferences;

/** Where this phone keeps the PC address and its pairing token. */
final class Prefs {
    private final SharedPreferences p;

    Prefs(Context c) { p = c.getSharedPreferences("omega", Context.MODE_PRIVATE); }

    /** The PC address; until pairing, the one build.mjs found for the PC that built this app. */
    String url() { return p.getString("url", Defaults.URL); }
    String token() { return p.getString("token", null); }
    String server() { return p.getString("server", ""); }
    boolean paired() { return token() != null; }

    void paired(String url, String token, String server) {
        p.edit().putString("url", url).putString("token", token).putString("server", server).apply();
    }
    void url(String url) { p.edit().putString("url", url).apply(); }
    void unpair() { p.edit().remove("token").remove("server").apply(); }

    /** Install new versions from the PC by themselves (on by default). */
    boolean autoUpdate() { return p.getBoolean("autoUpdate", true); }
    void autoUpdate(boolean on) { p.edit().putBoolean("autoUpdate", on).apply(); }

    LinkClient client() { return new LinkClient(url(), token()); }
}
