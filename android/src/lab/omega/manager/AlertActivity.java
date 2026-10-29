package lab.omega.manager;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

/** The full-screen red alert (also over the lock screen), like an alarm clock. */
public final class AlertActivity extends Activity {
    private static AlertActivity showing;
    private String bootId = "", alertId = "";

    /** Closes the alert screen if it shows this alert (it was dismissed on the PC or from the notification). */
    static void closeIf(String bootId, String alertId) {
        final AlertActivity a = showing;
        if (a != null && a.bootId.equals(bootId) && a.alertId.equals(alertId)) a.runOnUiThread(a::finish);
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true); }
        else getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        show(getIntent());
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        show(i);
    }

    @Override protected void onResume() { super.onResume(); showing = this; }
    @Override protected void onPause() { if (showing == this) showing = null; super.onPause(); }

    private int dp(float v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private void show(Intent i) {
        JSONObject a;
        try { a = new JSONObject(i.getStringExtra("alert")); } catch (Exception e) { finish(); return; }
        bootId = i.getStringExtra("boot") == null ? "" : i.getStringExtra("boot");
        alertId = a.optString("id");
        final int nid = Notifier.idFor(bootId, alertId);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(dp(28), dp(56), dp(28), dp(32));
        col.setGravity(Gravity.CENTER_HORIZONTAL);

        TextView kind = text((a.optBoolean("preview") ? "TEST ALERT" : "TIMER DONE") + "  ·  " + Notifier.hm(a.optLong("firedAt", System.currentTimeMillis())), 14, 0xFFFFE1DE, true);
        kind.setLetterSpacing(0.12f);
        col.addView(kind);

        // The user's pixel-art Ω (Omega.png, turned into a vector by build.mjs) on a white disc so it stands out on red.
        ImageView omega = new ImageView(this);
        omega.setImageResource(R.drawable.ic_omega);
        int pad = dp(14);
        omega.setPadding(pad, pad, pad, pad);
        GradientDrawable disc = new GradientDrawable();
        disc.setShape(GradientDrawable.OVAL);
        disc.setColor(Color.WHITE);
        omega.setBackground(disc);
        LinearLayout.LayoutParams olp = new LinearLayout.LayoutParams(dp(112), dp(112));
        olp.topMargin = dp(22);
        olp.bottomMargin = dp(10);
        col.addView(omega, olp);

        TextView title = text(a.optString("title", "Timer"), 34, Color.WHITE, true);
        title.setPadding(0, dp(4), 0, dp(10));
        col.addView(title);

        String msg = a.optString("message", "");
        if (!msg.isEmpty()) col.addView(text(msg, 22, Color.WHITE, false));
        if (a.optBoolean("late")) {
            TextView late = text("It was due at " + Notifier.hm(a.optLong("dueAt")) + ", while the PC app was closed.", 15, 0xFFFFE1DE, false);
            late.setPadding(0, dp(12), 0, 0);
            col.addView(late);
        }

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.VERTICAL);
        buttons.setPadding(0, dp(40), 0, 0);
        if (a.optBoolean("canSnooze")) {
            JSONArray sn = a.optJSONArray("snooze");
            for (int k = 0; sn != null && k < sn.length() && k < 2; k++) {
                final int m = sn.optInt(k);
                buttons.addView(button("Snooze " + m + " min", false, v -> act(nid, "snooze", m)));
            }
        }
        buttons.addView(button("Dismiss", true, v -> act(nid, "dismiss", 0)));
        col.addView(buttons, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        ScrollView sv = new ScrollView(this);
        sv.setFillViewport(true);
        sv.setBackgroundColor(Notifier.RED);
        sv.addView(col);
        setContentView(sv);
    }

    private TextView text(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private Button button(String label, boolean main, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(18);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setTextColor(main ? Notifier.RED : Color.WHITE);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(14));
        if (main) bg.setColor(Color.WHITE); else { bg.setColor(0x00000000); bg.setStroke(dp(2), 0xCCFFFFFF); }
        b.setBackground(bg);
        b.setStateListAnimator(null);
        b.setOnClickListener(l);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(60));
        lp.topMargin = dp(12);
        b.setLayoutParams(lp);
        return b;
    }

    private void act(int nid, String action, int minutes) {
        getSystemService(NotificationManager.class).cancel(nid);
        ActionReceiver.send(getApplicationContext(), alertId, action, minutes, null);
        finish();
    }
}
