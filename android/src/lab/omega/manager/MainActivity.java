package lab.omega.manager;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.ProgressBar;
import android.widget.Switch;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

/** Pair with Omega Manager, see the connection and the running timers, and fix what would stop alerts arriving. */
public final class MainActivity extends Activity {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private Prefs prefs;
    private LinearLayout pairCard, pairedCard, timerList, fixCard;
    private TextView stateText, stateDetail, pairedText;
    private View stateDot;
    private EditText urlField, codeField;
    private Button pairBtn;
    private String lastTimers = "";
    static volatile boolean visible;                 // the updater shows Android's install screen only over this
    private Switch autoSwitch;
    private TextView verText, updText;
    private ProgressBar updBar;
    private Button installBtn, allowBtn;
    private boolean installAfterAllow;

    private final Runnable tick = new Runnable() {
        @Override public void run() { refresh(); ui.postDelayed(this, 1000); }
    };

    private int dp(float v) { return Math.round(v * getResources().getDisplayMetrics().density); }
    private int col(int id) { return getColor(id); }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        prefs = new Prefs(this);
        Notifier.channels(this);
        build();
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        handle(getIntent());
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        handle(i);
    }

    /** From an "Update available" / "Update ready" notification: install it (asks to allow installs first if needed). */
    private void handle(Intent i) {
        if (i == null || !i.getBooleanExtra("install", false)) return;
        i.removeExtra("install");
        installUpdate();
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
        LinkService.start(this);
        // Back from "Install unknown apps": carry on with the update the user asked for.
        if (installAfterAllow && Updater.allowed(this)) { installAfterAllow = false; Updater.install(this, true); }
        ui.post(tick);
    }
    @Override protected void onPause() { visible = false; ui.removeCallbacks(tick); super.onPause(); }

    // ---------- layout ----------
    private void build() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(18), dp(24), dp(18), dp(28));

        LinearLayout head = new LinearLayout(this);
        head.setGravity(Gravity.CENTER_VERTICAL);
        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.ic_omega);
        head.addView(logo, new LinearLayout.LayoutParams(dp(44), dp(44)));
        LinearLayout titles = new LinearLayout(this);
        titles.setOrientation(LinearLayout.VERTICAL);
        titles.setPadding(dp(12), 0, 0, 0);
        titles.addView(text("Omega Manager", 24, R.color.text, true));
        titles.addView(text("Timer alerts from your PC", 14, R.color.muted, false));
        head.addView(titles);
        root.addView(head);

        // Connection
        LinearLayout conn = card("Connection");
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        stateDot = new View(this);
        row.addView(stateDot, new LinearLayout.LayoutParams(dp(12), dp(12)));
        stateText = text("", 17, R.color.text, true);
        stateText.setPadding(dp(10), 0, 0, 0);
        row.addView(stateText);
        conn.addView(row);
        stateDetail = text("", 13, R.color.muted, false);
        stateDetail.setPadding(0, dp(6), 0, 0);
        conn.addView(stateDetail);
        root.addView(conn);

        // Pairing
        pairCard = card("Pair with your PC");
        pairCard.addView(text("1. Turn on Tailscale on this phone.\n2. On the PC, open Omega Manager > My timers > Phone alerts and press New code.\n3. Type the code here.", 14, R.color.muted, false));
        pairCard.addView(label("PC address"));
        urlField = field(prefs.url(), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        pairCard.addView(urlField);
        pairCard.addView(label("Pairing code"));
        codeField = field("", InputType.TYPE_CLASS_NUMBER);
        codeField.setHint("123 456");
        codeField.setTextSize(26);
        codeField.setLetterSpacing(0.2f);
        codeField.setGravity(Gravity.CENTER);
        codeField.setImeOptions(EditorInfo.IME_ACTION_GO);
        codeField.setOnEditorActionListener((v, id, e) -> { pair(); return true; });
        pairCard.addView(codeField);
        pairBtn = button("Pair", true, v -> pair());
        pairCard.addView(pairBtn);
        root.addView(pairCard);

        // Paired
        pairedCard = card("Paired");
        pairedText = text("", 14, R.color.muted, false);
        pairedCard.addView(pairedText);
        LinearLayout btns = new LinearLayout(this);
        btns.addView(button("Send a test alert", true, v -> test()), new LinearLayout.LayoutParams(0, dp(48), 1));
        View gap = new View(this);
        btns.addView(gap, new LinearLayout.LayoutParams(dp(10), 1));
        btns.addView(button("Unpair", false, v -> unpair()), new LinearLayout.LayoutParams(0, dp(48), 1));
        btns.setPadding(0, dp(12), 0, 0);
        pairedCard.addView(btns);
        root.addView(pairedCard);

        // App updates
        LinearLayout uc = card("App updates");
        autoSwitch = new Switch(this);
        autoSwitch.setText("Auto updates");
        autoSwitch.setTextSize(17);
        autoSwitch.setTypeface(Typeface.DEFAULT_BOLD);
        autoSwitch.setTextColor(col(R.color.text));
        autoSwitch.setChecked(prefs.autoUpdate());
        autoSwitch.setThumbTintList(new ColorStateList(new int[][]{{android.R.attr.state_checked}, {}}, new int[]{col(R.color.accent), col(R.color.faint)}));
        autoSwitch.setTrackTintList(new ColorStateList(new int[][]{{android.R.attr.state_checked}, {}}, new int[]{col(R.color.accent), col(R.color.line)}));
        autoSwitch.setOnCheckedChangeListener((v, on) -> {
            prefs.autoUpdate(on);
            toast(on ? "Auto updates on: new versions from your PC install by themselves." : "Auto updates off: you'll get a notification to install new versions.");
            if (on) Updater.autoTurnedOn(this);
            refresh();
        });
        uc.addView(autoSwitch, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(44)));
        TextView how = text("When Omega Manager on your PC has a newer version of this app, the phone downloads and installs it by itself. Turn off to be asked first.", 13, R.color.muted, false);
        how.setPadding(0, dp(2), 0, dp(8));
        uc.addView(how);
        verText = text("", 14, R.color.text, false);
        uc.addView(verText);
        updText = text("", 14, R.color.muted, false);
        updText.setPadding(0, dp(6), 0, 0);
        uc.addView(updText);
        updBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        updBar.setMax(100);
        updBar.setProgressTintList(ColorStateList.valueOf(col(R.color.accent)));
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(10));
        blp.topMargin = dp(8);
        uc.addView(updBar, blp);
        allowBtn = button("Allow installing updates", false, v -> askToAllow());
        uc.addView(allowBtn);
        installBtn = button("Install update", true, v -> installUpdate());
        uc.addView(installBtn);
        root.addView(uc);

        // Running timers
        LinearLayout tc = card("Running timers");
        timerList = new LinearLayout(this);
        timerList.setOrientation(LinearLayout.VERTICAL);
        tc.addView(timerList);
        root.addView(tc);

        // Reliability
        fixCard = card("Make sure alerts arrive");
        root.addView(fixCard);

        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(col(R.color.bg));
        sv.setFillViewport(true);
        sv.addView(root);
        setContentView(sv);
    }

    private LinearLayout card(String title) {
        LinearLayout c = new LinearLayout(this);
        c.setOrientation(LinearLayout.VERTICAL);
        c.setPadding(dp(16), dp(14), dp(16), dp(16));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(col(R.color.card));
        bg.setCornerRadius(dp(16));
        bg.setStroke(dp(1), col(R.color.line));
        c.setBackground(bg);
        TextView h = text(title.toUpperCase(), 12, R.color.muted, true);
        h.setLetterSpacing(0.08f);
        h.setPadding(0, 0, 0, dp(8));
        c.addView(h);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(16);
        c.setLayoutParams(lp);
        return c;
    }

    private TextView text(String s, float sp, int colorId, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(col(colorId));
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setLineSpacing(0, 1.15f);
        return t;
    }

    private TextView label(String s) {
        TextView t = text(s, 13, R.color.muted, true);
        t.setPadding(0, dp(14), 0, dp(4));
        return t;
    }

    private EditText field(String value, int type) {
        EditText e = new EditText(this);
        e.setText(value);
        e.setInputType(type);
        e.setSingleLine(true);
        e.setTextColor(col(R.color.text));
        e.setHintTextColor(col(R.color.faint));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(col(R.color.bg));
        bg.setCornerRadius(dp(10));
        bg.setStroke(dp(1), col(R.color.line));
        e.setBackground(bg);
        e.setPadding(dp(12), dp(10), dp(12), dp(10));
        return e;
    }

    private Button button(String label, boolean main, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(15);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setTextColor(main ? col(R.color.on_accent) : col(R.color.accent));
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(12));
        if (main) bg.setColor(col(R.color.accent)); else { bg.setColor(0); bg.setStroke(dp(1), col(R.color.accent)); }
        b.setBackground(bg);
        b.setStateListAnimator(null);
        b.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50));
        lp.topMargin = dp(14);
        b.setLayoutParams(lp);
        return b;
    }

    // ---------- live state ----------
    private void refresh() {
        boolean paired = prefs.paired();
        pairCard.setVisibility(paired ? View.GONE : View.VISIBLE);
        pairedCard.setVisibility(paired ? View.VISIBLE : View.GONE);
        String s = LinkService.state;
        int dot;
        String title;
        if (!paired) { title = "Not paired"; dot = R.color.faint; }
        else if ("connected".equals(s)) { title = "Connected to " + LinkService.server; dot = R.color.ok; }
        else if ("connecting".equals(s)) { title = "Connecting…"; dot = R.color.accent; }
        else { title = "Not connected"; dot = R.color.red; }
        stateText.setText(title);
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.OVAL);
        d.setColor(col(dot));
        stateDot.setBackground(d);
        String det = !paired ? ("unpaired".equals(s) && !LinkService.detail.isEmpty() ? LinkService.detail : "Pair this phone to get timer alerts.")
                : "connected".equals(s) ? "Alerts arrive even with the screen off. Keep Tailscale connected."
                : LinkService.detail.isEmpty() ? "Retrying in the background." : LinkService.detail + " Retrying in the background.";
        stateDetail.setText(det);
        pairedText.setText("This phone gets alerts from " + (prefs.server().isEmpty() ? "your PC" : prefs.server()) + " at\n" + prefs.url());
        renderTimers();
        renderFixes();
        renderUpdate();
    }

    private void renderUpdate() {
        JSONObject a = Updater.newer(this);
        verText.setText("This phone: version " + Updater.installedName(this) + ", build " + Updater.installed(this)
                + (a != null ? "\nOn your PC: version " + Updater.label(a) : Updater.latest != null ? "  ·  up to date" : ""));
        String st = Updater.status;
        updText.setText(st);
        updText.setVisibility(st.isEmpty() ? View.GONE : View.VISIBLE);
        int pct = Updater.progress;
        updBar.setVisibility(Updater.busy ? View.VISIBLE : View.GONE);
        updBar.setIndeterminate(pct < 0);
        if (pct >= 0) updBar.setProgress(pct);
        boolean allowed = Updater.allowed(this);
        // Auto updates need the one-time "install unknown apps" permission, so ask for it up front.
        allowBtn.setVisibility(!allowed && (prefs.autoUpdate() || a != null) ? View.VISIBLE : View.GONE);
        installBtn.setVisibility(a != null && !Updater.busy ? View.VISIBLE : View.GONE);
        installBtn.setText(a != null ? "Install version " + Updater.label(a) : "Install update");
    }

    private void askToAllow() {
        toast("Turn on \"Allow from this source\" for Omega Manager, then come back.");
        startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
    }

    private void installUpdate() {
        if (Updater.newer(this) == null) { toast("This phone already has the newest version from your PC."); return; }
        if (!Updater.allowed(this)) { installAfterAllow = true; askToAllow(); return; }
        Updater.install(this, true);
        refresh();
    }

    private void renderTimers() {
        JSONArray t = LinkService.timers;
        String key = t.toString();
        long now = System.currentTimeMillis() - LinkService.clockOffset;
        if (!key.equals(lastTimers)) {
            lastTimers = key;
            timerList.removeAllViews();
            if (t.length() == 0) timerList.addView(text("connected".equals(LinkService.state) ? "No timers running on the PC." : "Shown when connected.", 14, R.color.faint, false));
            for (int i = 0; i < t.length(); i++) {
                JSONObject o = t.optJSONObject(i);
                LinearLayout r = new LinearLayout(this);
                r.setOrientation(LinearLayout.VERTICAL);
                r.setPadding(0, dp(8), 0, dp(8));
                LinearLayout top = new LinearLayout(this);
                top.setGravity(Gravity.CENTER_VERTICAL);
                TextView name = text(o.optString("title"), 16, R.color.text, true);
                top.addView(name, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
                TextView left = text("", 22, R.color.accent, true);
                left.setTypeface(Typeface.create(Typeface.MONOSPACE, Typeface.BOLD));
                left.setTag("left");
                top.addView(left);
                r.addView(top);
                String msg = o.optString("message");
                if (!msg.isEmpty()) r.addView(text(msg, 13, R.color.muted, false));
                r.setTag(o);
                timerList.addView(r);
            }
        }
        for (int i = 0; i < timerList.getChildCount(); i++) {
            View r = timerList.getChildAt(i);
            if (!(r.getTag() instanceof JSONObject)) continue;
            JSONObject o = (JSONObject) r.getTag();
            TextView left = r.findViewWithTag("left");
            boolean paused = "paused".equals(o.optString("state"));
            long ms = paused ? o.optLong("leftMs") : Math.max(0, o.optLong("dueAt") - now);
            left.setText(paused ? "paused" : formatLeft(ms));
        }
    }

    static String formatLeft(long ms) {
        long s = (Math.max(0, ms) + 999) / 1000;
        long h = s / 3600, m = (s % 3600) / 60, sec = s % 60;
        return h > 0 ? String.format("%d:%02d:%02d", h, m, sec) : String.format("%d:%02d", m, sec);
    }

    private void renderFixes() {
        fixCard.removeViews(1, fixCard.getChildCount() - 1);
        int n = 0;
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            fix("Notifications are off for this app.", "Allow notifications", v -> requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1)); n++;
        }
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 34 && !nm.canUseFullScreenIntent()) {
            fix("Full-screen red alerts are off (needed to light up the screen like an alarm).", "Allow full-screen alerts",
                    v -> startActivity(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getPackageName())))); n++;
        }
        PowerManager pm = getSystemService(PowerManager.class);
        if (!pm.isIgnoringBatteryOptimizations(getPackageName())) {
            fix("Android may pause the app in the background to save battery, and alerts would come late.", "Let it run in the background",
                    v -> startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())))); n++;
        }
        if (n == 0) fixCard.addView(text("All set: notifications, full-screen alerts and background running are allowed.", 14, R.color.ok, false));
    }

    private void fix(String why, String action, View.OnClickListener l) {
        TextView t = text(why, 14, R.color.text, false);
        t.setPadding(0, dp(6), 0, 0);
        fixCard.addView(t);
        Button b = button(action, false, l);
        ((LinearLayout.LayoutParams) b.getLayoutParams()).topMargin = dp(8);
        fixCard.addView(b);
    }

    // ---------- actions ----------
    private void pair() {
        final String url = LinkClient.normalize(urlField.getText().toString());
        if (url.isEmpty()) { toast("Type your PC's address. Omega Manager shows it in My timers > Phone alerts."); return; }
        final String code = codeField.getText().toString().replaceAll("\\D", "");
        if (code.length() != 6) { toast("Type the 6-digit code shown in Omega Manager."); return; }
        pairBtn.setEnabled(false);
        pairBtn.setText("Pairing…");
        String dn = Settings.Global.getString(getContentResolver(), Settings.Global.DEVICE_NAME);
        final String name = dn != null && !dn.isEmpty() ? dn : Build.MANUFACTURER + " " + Build.MODEL;
        new Thread(() -> {
            String err = null, token = null, server = "";
            try {
                String r = new LinkClient(url, null).post("/api/pair", "{\"code\":" + LinkClient.quote(code) + ",\"name\":" + LinkClient.quote(name) + "}");
                JSONObject j = new JSONObject(r);
                token = j.getString("token");
                server = j.optString("server");
            } catch (Exception e) { err = LinkService.friendly(e); }
            final String fe = err, ft = token, fs = server;
            ui.post(() -> {
                pairBtn.setEnabled(true);
                pairBtn.setText("Pair");
                if (fe != null) { toast(fe); return; }
                prefs.paired(url, ft, fs);
                codeField.setText("");
                LinkService.state = "connecting";
                LinkService.start(this);
                toast("Paired with " + fs + ".");
                refresh();
            });
        }, "omega-pair").start();
    }

    private void test() {
        new Thread(() -> {
            try {
                String r = prefs.client().post("/api/test", "{}");
                if (r.contains("\"delivered\":0")) post("The PC got the request, but this phone is not connected yet. Wait for \"Connected\".");
            } catch (Exception e) { post("Could not reach Omega Manager: " + LinkService.friendly(e)); }
        }, "omega-test").start();
    }

    private void unpair() {
        final LinkClient c = prefs.client();
        new Thread(() -> { try { c.post("/api/unpair", "{}"); } catch (Exception ignored) { } }, "omega-unpair").start();
        prefs.unpair();
        LinkService.stop(this);
        LinkService.state = "unpaired";
        LinkService.detail = "";
        LinkService.timers = new JSONArray();
        refresh();
    }

    private void post(String msg) { ui.post(() -> toast(msg)); }
    private void toast(String msg) { Toast.makeText(this, msg, Toast.LENGTH_LONG).show(); }
}
