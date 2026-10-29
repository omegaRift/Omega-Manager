package lab.omega.manager;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Talks to Omega Manager's phone link (see lib/phone-link.js on the PC). Plain Java so it is tested on the PC. */
public final class LinkClient {

    /** An answer from Omega Manager that was not OK, with its plain-words reason. */
    public static final class LinkException extends IOException {
        public final int status;
        public LinkException(int status, String message) { super(message); this.status = status; }
    }

    public final String base;
    private final String token;
    /** This app's version code, sent so the PC can show whether the phone is up to date (0 = don't send). */
    public long appVersion;

    /** Download progress, 0..100. */
    public interface Progress { void on(int percent); }

    public LinkClient(String base, String token) {
        this.base = normalize(base);
        this.token = token;
    }

    /** "desktop.ts.net:8444/" -> "https://desktop.ts.net:8444" */
    public static String normalize(String url) {
        String u = url == null ? "" : url.trim();
        if (u.isEmpty()) return "";
        if (!u.matches("(?i)^https?://.*")) u = "https://" + u;
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        return u;
    }

    private HttpURLConnection open(String path, String method) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(15000);
        c.setReadTimeout(20000);
        c.setUseCaches(false);
        if (token != null) c.setRequestProperty("Authorization", "Bearer " + token);
        if (appVersion > 0) c.setRequestProperty("X-Omega-App-Version", Long.toString(appVersion));
        return c;
    }

    /** Copies a file from the PC into out and returns its SHA-256 (hex). expected = its size in bytes, or 0 if unknown. */
    public String download(String path, OutputStream out, long expected, Progress progress) throws IOException {
        HttpURLConnection c = open(path, "GET");
        c.setReadTimeout(30000);
        try {
            int code = c.getResponseCode();
            if (code != 200) throw new LinkException(code, errorOf(readAll(c.getErrorStream()), code));
            long total = expected > 0 ? expected : c.getContentLengthLong();
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[65536];
            long got = 0;
            int n, last = -1;
            InputStream in = c.getInputStream();
            try {
                while ((n = in.read(buf)) > 0) {
                    if (total > 0 && got + n > total) throw new IOException("The download is bigger than the PC said.");
                    out.write(buf, 0, n);
                    md.update(buf, 0, n);
                    got += n;
                    int pct = total > 0 ? (int) (got * 100 / total) : -1;
                    if (progress != null && pct != last) { last = pct; progress.on(pct); }
                }
            } finally { in.close(); }
            if (total > 0 && got != total) throw new IOException("The download stopped early (" + got + " of " + total + " bytes).");
            StringBuilder hex = new StringBuilder();
            for (byte b : md.digest()) hex.append(String.format("%02x", b & 0xff));
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IOException(e);
        } finally {
            c.disconnect();
        }
    }

    public String get(String path) throws IOException {
        return finish(open(path, "GET"));
    }

    public String post(String path, String json) throws IOException {
        HttpURLConnection c = open(path, "POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        byte[] body = (json == null ? "{}" : json).getBytes("UTF-8");
        c.setFixedLengthStreamingMode(body.length);
        OutputStream out = c.getOutputStream();
        try { out.write(body); } finally { out.close(); }
        return finish(c);
    }

    /** Opens the live event stream. The caller reads it with SseReader and disconnects when done. */
    public HttpURLConnection openEvents(int readTimeoutMs) throws IOException {
        HttpURLConnection c = open("/api/events", "GET");
        c.setRequestProperty("Accept", "text/event-stream");
        c.setReadTimeout(readTimeoutMs);
        int code = c.getResponseCode();
        if (code != 200) {
            String body = readAll(c.getErrorStream());
            c.disconnect();
            throw new LinkException(code, errorOf(body, code));
        }
        return c;
    }

    private static String finish(HttpURLConnection c) throws IOException {
        try {
            int code = c.getResponseCode();
            if (code >= 200 && code < 300) return readAll(c.getInputStream());
            throw new LinkException(code, errorOf(readAll(c.getErrorStream()), code));
        } finally {
            c.disconnect();
        }
    }

    static String readAll(InputStream in) throws IOException {
        if (in == null) return "";
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        } finally { in.close(); }
    }

    static String errorOf(String body, int code) {
        String e = field(body, "error");
        if (e != null) return e;
        if (code == 404) return "This address is not Omega Manager's phone link.";
        return "Omega Manager answered with error " + code + ".";
    }

    private static final Pattern STR = Pattern.compile("\"%s\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");

    /** A string field from a small JSON object (enough for {"ok":false,"error":"..."}). */
    public static String field(String json, String name) {
        if (json == null) return null;
        Matcher m = Pattern.compile(String.format(STR.pattern(), Pattern.quote(name))).matcher(json);
        if (!m.find()) return null;
        return unescape(m.group(1));
    }

    static String unescape(String s) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch != '\\' || i + 1 >= s.length()) { b.append(ch); continue; }
            char n = s.charAt(++i);
            switch (n) {
                case 'n': b.append('\n'); break;
                case 't': b.append('\t'); break;
                case 'r': b.append('\r'); break;
                case 'u':
                    if (i + 4 < s.length()) { b.append((char) Integer.parseInt(s.substring(i + 1, i + 5), 16)); i += 4; }
                    break;
                default: b.append(n);
            }
        }
        return b.toString();
    }

    public static String quote(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch == '"' || ch == '\\') b.append('\\').append(ch);
            else if (ch < 0x20) b.append(String.format("\\u%04x", (int) ch));
            else b.append(ch);
        }
        return b.append('"').toString();
    }
}
