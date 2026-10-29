package lab.omega.manager;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.net.HttpURLConnection;

/**
 * Runs the phone app's own network code (LinkClient + SseReader, unchanged) against the PC's phone link.
 * Used by test/phone-java.test.js:  java ProtocolCheck <base url> <pair code>
 * Prints one line per step; on the first alert it dismisses it from the "phone" and exits.
 */
public final class ProtocolCheck {
    public static void main(String[] args) throws Exception {
        final PrintStream out = new PrintStream(System.out, true, "UTF-8");
        String r = new LinkClient(args[0], null).post("/api/pair", "{\"code\":" + LinkClient.quote(args[1]) + ",\"name\":" + LinkClient.quote("Java \"check\" phone") + "}");
        String token = LinkClient.field(r, "token");
        out.println("PAIRED " + (token != null && token.length() >= 40));
        try {
            new LinkClient(args[0], null).post("/api/pair", "{\"code\":" + LinkClient.quote(args[1]) + "}");
            out.println("REUSED-CODE accepted");
        } catch (LinkClient.LinkException e) {
            out.println("REUSED-CODE " + e.status);
        }
        final LinkClient client = new LinkClient(args[0], token);
        client.appVersion = 7;
        // The app update download: the same call the Updater makes, into memory here.
        ByteArrayOutputStream apk = new ByteArrayOutputStream();
        final int[] last = {-1};
        String sha = client.download("/omega-manager.apk", apk, 0, pct -> last[0] = pct);
        out.println("DOWNLOAD " + apk.size() + " " + sha + " " + last[0]);
        try {
            client.download("/omega-manager.apk", new ByteArrayOutputStream(), 3, null);
            out.println("SIZE-CHECK missed");
        } catch (java.io.IOException e) {
            out.println("SIZE-CHECK " + e.getMessage());
        }
        HttpURLConnection c = client.openEvents(30000);
        try {
            new SseReader(c.getInputStream()).run((event, data) -> {
                out.println("EVENT " + event + " " + data);
                if (event.equals("alert")) {
                    out.println("MESSAGE " + LinkClient.field(data, "message"));
                    client.post("/api/alerts/" + LinkClient.field(data, "id") + "/dismiss", "{\"minutes\":0}");
                    out.println("DISMISSED");
                    System.exit(0);
                }
            }, null);
        } finally {
            c.disconnect();
        }
    }
}
