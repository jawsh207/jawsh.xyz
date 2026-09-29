# Nostr Material 3 PWA

An installable Android Material Design 3 Nostr Progressive Web App (PWA) with NWC and Amber (NIP-55/NIP-46) support.

## Included Files
- `index.html`: The main web application interface and Nostr client logic.
- `manifest.webmanifest`: Configuration for Android standalone PWA installation.
- `sw.js`: Service worker for offline asset caching.

## How to Run
1. Unzip the archive into a folder.
2. Run a local server from inside the directory:
   `python3 -m http.server 8080`
   or
   `npx serve .`
3. Open `http://localhost:8080` in Chrome on Android.
4. Tap the browser menu and select **Add to Home screen** / **Install app**.
