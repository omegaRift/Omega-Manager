package lab.omega.manager;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Reconnects after the phone restarts or the app is updated. */
public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        String a = i.getAction();
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) {
            // An update finished: say so briefly, then reconnect (the PC then sees the new version).
            Notifier.showUpdate(c, "Omega Manager updated", "Now on version " + Updater.installedName(c) + ", build " + Updater.installed(c) + ".", Updater.openApp(c, false), -1);
        }
        if (Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) LinkService.start(c);
    }
}
