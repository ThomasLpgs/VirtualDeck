<p align="center">
  <img src="src/assets/icon.png" width="96" alt="" />
</p>

<h1 align="center">VirtualDeck</h1>

<p align="center">
  A virtual Stream Deck for Windows.<br />
  A hotkey opens a grid of buttons under your mouse: one click switches your OBS scene, plays an animation, plays a sound or opens a program.
</p>

<p align="center">
  <b>English</b> · <a href="README.fr.md">Français</a>
</p>

<p align="center">
  <img src="docs/demo.gif" alt="Demo: one click on the deck switches the scene in OBS" width="860" />
  <br />
  <sub>Higher-quality video: <a href="docs/demo.mp4">docs/demo.mp4</a></sub>
</p>

---

## Features

- **A grid that opens where you are**: `Ctrl + Shift + Space` (customizable) shows it under the mouse, on top of games in windowed fullscreen. `Esc` or a click outside closes it. Keys `1` to `9` trigger the buttons from the keyboard.
- **Controls OBS Studio and Streamlabs Desktop**: scenes, sources and animations, muted audio, clips, streaming and recording.
- **Live status on the buttons**: LIVE badge on the scene on air, "LIVE 1:02:03" and "REC 12:03" (or "PAUSED") timers on the Stream and Record buttons, "MUTED" on muted audio. Everything also follows what you do directly in OBS.
- **Multi-actions**: one button chains several actions, with an optional wait before each one (for example "Break": Break scene, then music, then webcam hidden).
- **Pages**: up to 10 grids, each with its own name ("Sounds", "Scenes"…) and its own number of columns and rows. They open inside the deck or in a bubble coming out of the button, above the deck (your choice in Settings).
- **Your phone as a deck**: scan a QR code and your phone becomes a touch Stream Deck, over your home Wi-Fi, with no app to install and nothing opened to the internet.
- **Per-button hotkey**: trigger any button from anywhere, without opening the deck (F13 to F24 keys work on their own).
- **Vertical format (TikTok, Shorts…)** with the [Aitum Vertical](https://github.com/Aitum/obs-vertical-canvas) plugin: scenes, sources, streaming, recording and clips in horizontal, vertical or both at once.
- **Sounds** (mp3, wav, ogg…) with volume control; a second click stops the sound.
- **Media keys**: play / pause, next or previous track, Windows volume, for Spotify, YouTube, Deezer…
- **PC-wide microphone**: one button mutes every microphone at once, for Discord, OBS, Teams and games together. It shows "MUTED" while they are off.
- **Keyboard shortcuts**: a button presses a key combination for you (Ctrl + C, Win + Shift + S, the Discord or Teams mic…).
- **Ready-made text**: a button pastes a message into the chat (and sends it if you want): "Thanks for the follow!", "Back in 5 minutes"…
- **Template library**: ready-made decks (stream, chat messages, Discord, music, Windows shortcuts, browser, Teams, Zoom) added in one click on a new page.
- **Open** a program, a file or a link (`https://`, `spotify:`, `steam://`, `discord://`…).
- **Philips Hue lights**: turn your lights on or off, change their color or start a scene, through your home Hue bridge (no Hue account).
- **Govee lights**: turn your Govee lights on or off or change their color, directly over your home network (no Govee account).
- **Customization**: over 2,000 icons, emojis or your own images, 10 colors or a custom color, grid up to 8 × 6. The deck can be moved and resized (60% to 160%).
- **Export / import** of your whole setup (sounds and images included), to move to a new PC or share your deck.
- **One-click updates**: a pill in the editor tells you when a new version is out; one click downloads it, installs it and restarts VirtualDeck.
- **6 languages**: English, French, Spanish, German, Italian, Portuguese (or automatic, based on Windows).
- Runs quietly in the notification area and can start with Windows.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/deck.png" alt="The deck" /><br /><sub>The deck, opened with the hotkey</sub></td>
    <td width="50%"><img src="docs/screenshots/editor-buttons.png" alt="Button editor" /><br /><sub>Editor: appearance and action of each button</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/editor-connection.png" alt="Connecting to OBS" /><br /><sub>Connecting to OBS or Streamlabs, with a step-by-step guide</sub></td>
    <td><img src="docs/screenshots/editor-settings.png" alt="Settings" /><br /><sub>Settings: language, hotkey, deck size, pages, backup</sub></td>
  </tr>
</table>

## Installation

No need for Node.js or npm: the installer contains everything.

1. Go to the [latest release](https://github.com/ThomasLpgs/VirtualDeck/releases/latest) and download `VirtualDeck-Setup-x.y.z.exe` from the **Assets** section.
2. Run it and follow the installer. Windows SmartScreen may show "Windows protected your PC" because the app isn't signed by a known publisher: click **More info**, then **Run anyway**.
3. VirtualDeck opens on the editor. After that, it lives in the notification area (next to the clock).

To update, click **Install update** at the top of the editor (or in the menu of the icon next to the clock): VirtualDeck downloads the new version, checks that the file is intact, installs it and restarts. You can also run the new installer yourself. Either way, your buttons, your settings and the taskbar pin are kept.

## Getting started

### 1. Connect OBS

In the **Connection** tab of VirtualDeck:

1. In OBS (version 28 or later), open **Tools → WebSocket Server Settings** and tick **Enable WebSocket server** (port `4455`).
2. Click **Show Connect Info** and copy the password.
3. Paste it into VirtualDeck and click **Connect**. The dot turns green.

For **Streamlabs Desktop**: **Settings → Remote Control**, click the QR code then **Show details**, and copy the **API Token**.

### 2. Create your buttons

In the **Buttons** tab, click a slot, then choose:

| Action | What the button does |
| --- | --- |
| **Scene** | Switches to the chosen scene (the list comes straight from OBS). With Aitum Vertical: a horizontal and/or a vertical scene, switched together. |
| **Source / animation** | *Animation*: shows the source, waits for its duration, then hides it (ideal for a transparent `.webm` video). *Toggle*, *Show*, *Hide*: control its visibility. With Aitum Vertical: the same animation in horizontal and vertical. |
| **Mute** | Mutes or unmutes an audio source (mic, music…). The button shows "MUTED" in red while it is muted. |
| **Clip** | Saves the last seconds to a video file (OBS replay buffer, to start in OBS). In vertical with Aitum's Backtrack. |
| **Record** | Starts or stops recording, with the timer on the button. |
| **Stream** | Starts or stops the stream, with the timer on the button. |
| **Sound** | Plays an audio file, or stops it if it is playing. |
| **Open** | Launches a program, a file or a link. **Use the app's icon** puts the program's icon (Spotify, OBS…) on the button. |
| **Media** | Play / pause, next or previous track, stop, Windows volume (+, − or mute). Works with most players, even in the background. Also: mute the microphone of the whole PC (toggle, mute or unmute), like the mute button of Windows' sound settings. |
| **Keyboard shortcut** | Presses a key combination for you, in the window you opened the deck over. Record it from the keyboard; the Ctrl, Alt, Shift and Win buttons add the keys Windows keeps for itself (Win + …). |
| **Text** | Pastes a ready-made text into the window you opened the deck over, and presses Enter if you choose. Your clipboard is put back right after. |
| **Hue lights** | Turns on, off or toggles a light, a room, a zone or all lights, with the brightness and color you want; or starts a Hue scene. Link the bridge in **Settings › Connected lights**. |
| **Govee lights** | Turns on, off or toggles one Govee light or all of them, with the brightness and color you want. "LAN Control" must be turned on for the light in the Govee Home app. |
| **Page** | Goes to the next, previous or a specific page, without closing the deck. |
| **Multi** | Runs several of these actions in order, with an optional wait before each one. If a step fails, the next ones still run. |

No idea where to start? The **Templates** tab offers ready-made decks: **Add** puts one on a new page (or on the first one while the deck is empty), without touching your buttons. With OBS or Streamlabs connected, the *Stream essentials* template picks up your scenes and microphone by itself.

Made a mistake? `Ctrl + Z` undoes the last change to buttons and pages (even a deleted page), and `Ctrl + Y` redoes it. After a deletion, a banner also offers **Undo**.

At the bottom of each button's settings, **Hotkey** gives it a key combination that triggers it from anywhere.

Drag and drop buttons to reorder them. To move a button to another page, drop it on the page's tab (it takes the first free spot), or hold it over the tab for half a second to open the page and drop it where you want. Add pages with **+** above the preview, and name them in the **Name** field under the preview. Everything is saved automatically.

### 3. Use the deck

Press `Ctrl + Shift + Space` anywhere (or the key chosen in **Settings**: F13 to F24 keys of programmable mice and keyboards work too), then click a button.

- **Change page**: ‹ › arrows at the top of the deck, ← → keyboard keys, or a **Page** button.
- **Move** the deck by dragging its top bar: it then reopens in the same place. **Resize** it from the bottom-right corner.
- In **Settings › Opening pages**, *Deck on top* opens pages in a bubble coming out of the button: clicking the button or the deck again closes it.

### 4. Your phone as a deck (optional)

1. **Settings › Phone**: turn on *Use my phone as a deck*, then **Show QR code**.
2. Scan it with the phone's camera (same Wi-Fi as the PC). Add the page to the home screen to open it like an app.
3. If Windows asks for permission for VirtualDeck, allow it for your home network's type (Private or Public, shown in **Settings › Network & internet**): that is what lets your phone connect. The phone deck stays protected by its own key, the one in the QR code.

Change pages with the arrows or by swiping. The LIVE / REC / MUTED badges update live.

**Allowed phones** (1 by default, up to 3 or no limit): the first devices that scan the QR code take the places; the next ones are refused, even with the QR code.

Security: the server only exists while the option is on and only listens on the local network (nothing on the router, nothing on the internet). Every press is signed with a secret key passed through the QR code: a device on the Wi-Fi that didn't scan it can't trigger anything, even by replaying a request. **New QR code** disconnects every phone. Avoid showing the QR code on stream: even though it only works from your Wi-Fi, better keep it to yourself.

### 5. Philips Hue lights (optional)

1. **Settings › Connected lights**: turn on **Philips Hue**, then **Find the bridge** and **Link**. If the bridge doesn't show up, enter its IP address (Hue app › Settings › Hue Bridges).
2. Press the big round button in the middle of the bridge within 30 seconds.
3. Create a **Hue lights** button and pick the light or room, or a scene.

Everything goes through your home network: no Hue account, nothing to open on the router. The link with the bridge is encrypted and VirtualDeck checks every time that it really is your bridge answering. If the router gives the bridge a new address, VirtualDeck finds it by itself.

### 6. Govee lights (optional)

Hue and Govee stay off until you turn them on: without connected lights, VirtualDeck sends no request to any light or bridge.

1. In the **Govee Home** app, open your light › **Settings** and turn on **LAN Control**.
2. **Settings › Connected lights**: turn on **Govee**.
3. In VirtualDeck, create a **Govee lights** button: the lights on the network show up by themselves. Pick one, or all of them.

Everything goes through your home network: no Govee account, no internet, nothing to open on the router or in the firewall. VirtualDeck only listens for the lights' answers while a key is pressed. Govee scenes aren't available locally, only power, brightness and color.

### 7. Vertical format with Aitum Vertical (optional)

If the [Aitum Vertical](https://github.com/Aitum/obs-vertical-canvas) plugin is installed in OBS, VirtualDeck detects it by itself:

- **Scene** and **Source / animation** offer vertical fields in addition to the horizontal ones; each filled field acts on its format, both at once if both are filled.
- **Stream**, **Record** and **Clip** have an **Output** choice: *Horizontal* (OBS), *Vertical* (Aitum) or *Both*.
- Sources of vertical scenes require OBS 32 or later.

If the plugin is no longer detected, the horizontal part keeps working and the deck flags the affected buttons.

## Backup and moving to a new PC

**Settings → Export my setup** creates a `.vdeck` file with your buttons, their sounds and their images. On the other PC: **Import a setup**. Connection passwords and tokens are never exported.

## Development

Requirements: Node.js and Windows.

```bash
npm install
npm start          # runs the app in development mode
npm run dist       # builds the installer into release/
npm test           # runs the automated tests (also run by GitHub on every push)
```

Code layout:

```
src/
├── main.js          main process: windows, global hotkey, notification icon
├── config.js        config read/write (secrets encrypted with safeStorage)
├── actions.js       runs the button actions
├── obs.js           OBS WebSocket v5 client
├── streamlabs.js    Streamlabs Remote Control client
├── backup.js        export / import
├── updates.js       checks for new versions (GitHub Releases)
├── i18n.js          translations for the main process
├── i18n/*.json      one file per language
├── deck/            the grid (transparent window)
├── editor/          the editor
└── shared/          code shared by both windows
test/                automated tests (node:test, with a fake OBS)
```

Adding a language: copy `src/i18n/en.json` to `src/i18n/<code>.json`, translate the values, then add the code to `LANGUAGES` (`src/i18n.js`). A missing key falls back to English.
