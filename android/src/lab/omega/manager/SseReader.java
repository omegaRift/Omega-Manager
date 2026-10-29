package lab.omega.manager;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;

/** Reads a Server-Sent Events stream ("event: x" / "data: {...}" blocks). Plain Java so it is tested on the PC. */
public final class SseReader {
    public interface Handler { void onEvent(String event, String data) throws Exception; }

    private final BufferedReader in;

    public SseReader(InputStream stream) throws IOException {
        in = new BufferedReader(new InputStreamReader(stream, "UTF-8"));
    }

    /** Reads until the stream ends. Every line (including ": ping" comments) calls onActivity. */
    public void run(Handler handler, Runnable onActivity) throws Exception {
        String event = null;
        StringBuilder data = null;
        String line;
        while ((line = in.readLine()) != null) {
            if (onActivity != null) onActivity.run();
            if (line.isEmpty()) {
                if (data != null) handler.onEvent(event == null ? "message" : event, data.toString());
                event = null;
                data = null;
                continue;
            }
            if (line.startsWith(":")) continue;
            int c = line.indexOf(':');
            String field = c < 0 ? line : line.substring(0, c);
            String value = c < 0 ? "" : line.substring(c + 1);
            if (value.startsWith(" ")) value = value.substring(1);
            if (field.equals("event")) event = value;
            else if (field.equals("data")) {
                if (data == null) data = new StringBuilder(value);
                else data.append('\n').append(value);
            }
        }
    }
}
