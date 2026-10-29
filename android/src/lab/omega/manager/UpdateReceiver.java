package lab.omega.manager;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Android's answer to an app update the Updater started. */
public final class UpdateReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) { Updater.finished(c, i); }
}
