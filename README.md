# Omega Manager

A Windows desktop app with two sections (switch at the top):
- **My timers**: your own countdowns and alarms. When one is done, a red notification pops up in the
  bottom-right corner with the message you wrote.
- **Automations**: clicking, scrolling and typing. You pick a viewport (the entire screen or one window),
  place steps on a live preview, let a local AI find the text boxes, and run the steps by hand or on timers.

It was called Screen Autopilot before. Its saved data stays in `%APPDATA%\screen-autopilot`, so nothing
was lost in the rename. The moon button in the top bar switches night mode on and off (Settings > Look
can also follow Windows).

Open it with **Omega Manager.bat** (the first run installs Electron), or the **Omega Manager** desktop
shortcut, which starts it without a console window. The icon is your pixel-art **Omega.png** (in this folder); after
changing it, run `node assets/make-icon.mjs` to rebuild `assets/icon.ico` for the shortcut and taskbar.

## My timers
- **Countdown** (hours, minutes, seconds, or a quick button) or **At a time** (a time of day, optionally
  every day). Give it a name and the **notification message**, then **Start timer**.
  **Preview notification** shows the red notification right away with what you typed.
- Running timers count down on cards. Pause, resume, restart or delete them; change a card's message
  at any time.
- The red notification stays on top until you press **Dismiss**, **Snooze 5 min** or **Snooze 10 min**.
  It never takes the keyboard focus, chimes three times (untick "Play a sound" for silence), and
  several stack up. Timers keep running when the window is closed to the tray.
- A timer that was due while Omega Manager was closed rings as soon as it opens, and says when it was due.

## Alerts on your Android phone
The Omega Manager Android app shows the same alerts on your phone: a red notification with Dismiss and
Snooze, and a full-screen red alarm screen (also over the lock screen). Dismiss or snooze on either side and
the other one closes too. The phone only talks to this PC over your Tailscale network.

1. Build the app once: `npm run android` → `android/dist/omega-manager.apk` (needs the Android SDK, see below).
2. Tailscale serve publishes the phone link inside your tailnet only (set up once):
   `tailscale serve --bg --https=8444 http://127.0.0.1:5191`
3. On the phone, with Tailscale connected, open `https://<your-pc>.<your-tailnet>.ts.net:8444` (My timers →
   Phone alerts shows this PC's exact address) and install
   the app (allow "install unknown apps" for the browser).
4. In Omega Manager: **My timers → Phone alerts → New code**. Type the 6-digit code into the phone app.
5. On the phone allow notifications and full-screen alerts, and set battery use to **Unrestricted** so the
   connection stays open.

**Updating the phone app.** After a change to the app, run `npm run android`. Omega Manager tells every connected
phone about the new build within about 20 seconds (`android/dist/omega-manager.json` describes it: version,
size, sha256). On the phone, **App updates → Auto updates** decides what happens:
- **On** (the default): the phone downloads it, checks the size and sha256, and installs it by itself. Android 12
  and newer lets an app update itself without asking; if Android still wants a tap, a "Tap to install"
  notification appears. It needs the one-time "Allow from this source" permission (the app shows a button for it).
- **Off**: an "Update available" notification and an **Install version …** button on the main screen.

The Phone alerts window on the PC shows each phone's app as *App up to date*, *Update waiting*, or *Update by
hand once* (an app from before updates existed: install the new one on that phone from the address above once).

How it works: `lib/phone-link.js` is a small HTTP server on 127.0.0.1:5191 (`AP_PHONE_PORT` changes it,
`off` disables it). The phone pairs with a one-time code (5 minutes, 5 tries) and gets a token; only a hash
of the token is saved. Alerts and the timer list arrive over Server-Sent Events. The app keeps one connection
in a foreground service and reconnects by itself when the network comes back.

Building the APK (`android/build.mjs`) uses the Android SDK tools directly, no Gradle: aapt2 → javac → d8 →
zipalign → apksigner. It needs a JDK and the SDK with `build-tools;35.0.1` and `platforms;android-35`
(`%LOCALAPPDATA%\Android\Sdk`, or `ANDROID_HOME`). The icons are made from `Omega.png`. The signing key is
`android/keystore/omega-sideload.jks`: keep it, because an app signed with a new key can't update the old one
(you'd have to uninstall it on the phone first). Its password is in `android/keystore/password.txt`; the whole
`keystore/` folder is git-ignored. The app's starting address comes from `tailscale status` at build time
(or `OMEGA_PC_URL`), so it is not in the source.

## Using it (Automations)
1. **New task**, then choose a screen or a window. Window steps are stored relative to the window,
   so they still land right after the window moves or is resized.
2. **Find inputs** marks text boxes, dropdowns, checkboxes and buttons on the preview:
   - *with AI*: your local Ollama vision model (default `qwen3.5:9b`, ~7-10 s). Works on anything visible.
   - *with Windows accessibility*: instant and exact for normal Windows apps (window viewports only).
   Click a found input to add a click or a typing step for it.
3. Or pick a tool (**Click, Double, Right, Type, Scroll**; keys V C D R T S) and click the preview.
   **Key press**, **Type** (into whatever has focus) and **Wait** need no spot. Drag pins to move them.
4. Optional per step: **Find it with AI on every run**. The AI looks for the element again before
   each run, so the step still works if the layout changes. It is slower.
5. **Timers** tab: *Every N seconds/minutes/hours* (optionally only N times), *Daily at HH:MM* on chosen
   days, or *Once at* a date and time. Timers run while the app is open, including from the tray.
   Only one task runs at a time; tasks that come due meanwhile wait their turn.
6. **Rehearse** shows where each step would go without clicking. **Run now** counts down 3 s first.

Typed text can use `{date}`, `{time}`, `{datetime}`, `{run}` (the run number) and `{loop}` (the loop round).

## Groups, If / Else, Loops and Stop
The **Logic** buttons under the steps add cards that hold other steps:
- **Group**: a named box of steps. Fold it away, or skip it with everything inside.
- **If / Else**: runs its *Then* steps when a check is true, otherwise its *Otherwise* steps.
- **Loop**: repeats its steps a number of times, or *while* / *until* a check is true
  (checked before each round, with a "most rounds" safety limit).
- **Stop**: leaves the loop it is in, or ends the whole task. Put it inside an If.

Checks: *the AI sees…* (describe it), *the colour at a spot is…* (pick the spot on the preview; tolerance 0–255),
*a window is open…* (part of its title or program), *the time is between…* (may cross midnight).
Tick "Reverse it" for NOT. **Test now** shows the answer straight away.

Drag a card by its ⠿ handle to move it before or after another card, into an empty list, or to the
top of an open container. New steps go after the selected step, inside a selected Group/If/Loop, or
into an empty list you clicked. Rehearsal runs each loop at most 3 rounds.

## When the window is closed
When you choose a window, Omega Manager notes how its program was started (the program, its
arguments, and the app id for Store apps). If that window is closed later:
- The preview shows **Open <program> again**. It starts the program, waits for its window, and the
  task follows the new window.
- Tick **Open the window if it is closed** (next to the task's options) and every run, including timer
  runs, opens it first. With the option off, the run stops and says the window is not open.
- **How to open it…** shows and edits those settings: program (with Browse…), arguments, Windows app id,
  and how many seconds to wait after the window appears so it can finish loading.

## Safety
- **Ctrl+Alt+X** stops a running task from any app. The tray menu can stop a task or pause all timers.
- Moving the mouse during a run stops it (safety stop; can be turned off in Settings).
- The app minimizes itself during a real run so its own window never catches the clicks.
- Windows does not let a normal app send input to an app running as administrator. To automate one
  of those, run Omega Manager as administrator too.

## How it works
- `main.js`: Electron main process (capture, preview stream, runs, timers, tray, hotkey).
- `helper/native.ps1`: one hidden PowerShell process that lists windows, reads how a window's program was
  started (`procinfo`), and sends input with `SendInput`.
  `AP_DRY_INPUT=1` makes it report input instead of sending it.
- `helper/uia.ps1`: Windows UI Automation reader for "Find inputs with Windows accessibility".
- `lib/`: pure logic (`schedule.js` timers, `runner.js` steps, `detect.js` AI answers, `geometry.js`,
  `keys.js`, `launch.js` opening a closed window, `reminders.js` My timers) with unit tests.
- `ui/timers.js` is the My timers page; `ui/alert.html` + `alert.js` is the red notification window.
- Data: `%APPDATA%\screen-autopilot\autopilot.json`.

## Tests
- `npm test`: unit tests, plus the real helper in dry mode.
- `npm run smoke`: the real app with a hidden window and the dry helper. It never moves your mouse or types.
  It checks the live preview, AI detection on `test/fixtures/form-1280.png`, placing and dragging steps,
  the exact pixels a run would click, the safety stop, Ctrl+Alt+X, timers, logic cards, and opening a closed
  window again (a fake program; nothing real is started). Use `AP_SMOKE_NO_AI=1` to skip Ollama.
  It also pairs a pretend phone and checks it gets an alert and can dismiss it.
- `test/phone-java.test.js` compiles the Android app's own network code (`LinkClient.java`, `SseReader.java`)
  and runs it against the phone link (skipped without a JDK).
