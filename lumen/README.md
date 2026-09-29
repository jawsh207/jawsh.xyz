# Lumen — a Material You Nostr client

A static, installable web app (PWA). No build step.

## Run it
Any static HTTPS host works (GitHub Pages, Netlify, Cloudflare Pages, Vercel):

    npx serve .          # local test on http://localhost:3000

Service workers and installation require HTTPS (or localhost). On Android Chrome,
open the site and choose **Install app** from the menu, or use Settings → Install Lumen.

## Features
- Home (people you follow), Explore (global), Messages, Activity (replies, likes, boosts, zaps), Wallet
- Search: people and posts (NIP-50 via relay.nostr.band / search.nos.today), #hashtags, and direct jumps from npub, note/nevent links or name@domain (NIP-05)
- Private messages: NIP-17 gift-wrapped DMs (send + receive, 1:1 and groups), reads older NIP-04 DMs, publish inbox relays (kind 10050)
- Photo and video uploads in the composer: Blossom (default: blossom.primal.net) or NIP-96 (nostr.build), or a custom server; posts carry imeta tags
- Post, reply, quote, boost (kind 6), like (kind 7), follow/unfollow, edit profile
- Zaps (NIP-57) via Lightning address or LNURL, with counts on every post
- Nostr Wallet Connect (NIP-47): balance, one-tap zaps, pay invoice, create invoice
- Sign-in: Amber quick sign-in (NIP-55), remote signer (NIP-46: nostrconnect:// link/QR or bunker:// link, works with Amber and nsec.app), NIP-07 extension, nsec, read-only npub, new account
- QR codes for invoices (receive, and zaps without a connected wallet) and for remote-signer pairing
- Material 3: nav bar, top app bar, extended FAB, sheets, dialogs, snackbars, ripples
- Tonal palette generated from a seed color (swatches, custom color, or the device accent when the browser exposes it), light/dark/system

## Notes
- **Amber** works through `nostrsigner:` links. Amber signs and redirects back to
  `…/?amber=<result>`; Lumen saves what it was doing first, so a post, like or zap
  resumes after the round trip. Tip: in Amber, allow Lumen to auto-sign reactions to cut down on prompts.
  If Android reopens the callback in a Chrome tab instead of the installed app, enable
  "Open supported links" for Lumen in Android app settings.
- **Which Amber mode?** Quick sign-in redirects to Amber for every signature and can't decrypt,
  so Messages need Amber connected as a remote signer (NIP-46). Settings → Connect remote signer
  switches over. Remote signing goes through a relay; Amber shows a notification or auto-approves.
- **Uploads with Amber quick sign-in** keep the file in IndexedDB during the round trip and reopen
  the composer when you come back. One file per round trip.
- Decrypted messages are cached in IndexedDB on the device and cleared when you sign out.
- **Material You wallpaper colors** aren't exposed to web apps. Lumen uses the CSS
  `AccentColor` system color where the browser supports it, otherwise the seed you pick.
- nsec and the NWC secret are stored in localStorage on this device. Prefer Amber on Android.
- Libraries load from jsDelivr (nostr-tools 2.7.2, @scure/base 1.1.6, qrcode-generator 1.4.4) and are cached by the service worker.
