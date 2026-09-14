# TokElements for Spotify

**Put the song you are playing on your TikTok LIVE overlay, and let your viewers request the next one.**

[![Install the script](https://img.shields.io/badge/Install-the%20script-1DB954?style=for-the-badge)](https://raw.githubusercontent.com/tokelements/tokelements-spotify/main/tokelements-spotify.user.js)
[![TokElements](https://img.shields.io/badge/TokElements-tokelements.com-FF3158?style=for-the-badge)](https://tokelements.com)

[![Version](https://img.shields.io/badge/version-0.6.0-22232D?style=flat-square)](tokelements-spotify.user.js)
[![License](https://img.shields.io/badge/license-MIT-22232D?style=flat-square)](LICENSE)
[![Works with](https://img.shields.io/badge/works%20with-OBS%20·%20Streamlabs%20·%20TikTok%20LIVE%20Studio-22232D?style=flat-square)](https://tokelements.com)

This is a userscript for [**TokElements**](https://tokelements.com), the live streaming tool that turns
a TikTok LIVE broadcast into overlays for OBS. It reads the Spotify web player you already have open
and sends the current track to your overlay, so a now playing widget can show it on stream. In the
other direction it takes song requests from your viewers and puts them in your Spotify queue.

There is no Spotify app to register, no client id, no OAuth screen and no password. The script works
with the session you are already logged into, in your own browser.

---

## What you get on stream

- **A now playing widget** — cover art, title, artist and a progress bar that ticks along with the
  song. Three designs, all editable as HTML, CSS and JavaScript in the TokElements editor.
- **An up next widget** — the current song plus what is queued behind it, read straight out of the
  player rather than through a rate-limited API.
- **Viewer song requests** — a chat command like `!song bad guy` costs the viewer loyalty points and
  drops the track into your Spotify queue. The pending wishlist shows on your overlay with the cover,
  the title and who asked.
- **A skip command** — priced in points, so skipping the current track is something viewers spend on
  rather than something they spam.

## How it works

Three parts, each doing only what it must.

**Your browser** runs this script on `open.spotify.com`. It reads what the player is showing and
sends the title, artist, cover address, position and play state to your TokElements account, roughly
once a second while anything changes.

**TokElements** holds that in memory for a minute at a time and hands it to the widgets on your
overlay. Nothing about it is written to a database.

**Your overlay** is a single browser source in OBS. The widgets on it subscribe to the track and
render it however you designed them.

A song request travels the other way: the widget on your overlay asks TokElements, TokElements leaves
the request for this script, and the script searches Spotify and queues the track on the player you
are logged into. Your Spotify login never leaves your browser, and our servers never talk to Spotify.

## Install

**1. Get a userscript manager.** Tampermonkey is the one this is tested against.

| Browser | Get Tampermonkey |
| --- | --- |
| Chrome | [Chrome Web Store](https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo) |
| Edge | [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) |
| Firefox | [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/) |
| Opera | [Opera Add-ons](https://addons.opera.com/en/extensions/details/tampermonkey-beta/) |
| Safari | [Mac App Store](https://apps.apple.com/us/app/tampermonkey-classic/id1482490089?mt=12) |

**2. [Install the script](https://raw.githubusercontent.com/tokelements/tokelements-spotify/main/tokelements-spotify.user.js).**
Tampermonkey opens its own install screen. Nothing lands in your browser until you confirm there.

**3. Open `open.spotify.com`** in the same browser and log in.

**4. Open the Spotify page in your TokElements studio** and press **Connect Spotify in this browser**.
The script picks the pairing up by itself — there is nothing to type.

**5. Play a track.** It appears in the studio within a second, and on your overlay with it.

### Another browser, or another computer

The player and TokElements do not have to be in the same browser. On the TokElements Spotify page,
copy the pairing code. Then on the machine running Spotify, open the Tampermonkey menu while
`open.spotify.com` is in front and use **TokElements: set URL**, followed by
**TokElements: set pairing code**.

## The panel in the corner

The Spotify tab shows a small status panel at the bottom right: whether it is paired, whether
TokElements is reachable, whether you are signed in to Spotify, what is playing, and the result of
the last song request or skip. Red means something needs you, amber means it is waiting, green means
it is sending.

## What is sent, and what is kept

Only what a now playing widget needs: title, artist, the address of the cover image, position,
length, play state, the tracks queued behind the current one, and whether anybody is signed in to
the player.

None of it is written to a database. It is held in memory and expires by itself — the current track
after 45 seconds, the marker saying your browser is still connected after two minutes, and the
pairing code after 60 days or the moment you disconnect.

Your Spotify login never reaches TokElements. We hold no Spotify tokens, and our servers never call
Spotify: every request is made by your own browser, as you. The detail is in the
[TokElements privacy policy](https://tokelements.com/legal/privacy).

## Does it need Spotify Premium?

For the overlay, no. For song requests, usually not either: the script queues through the player's
own queue, the same way the **Add to queue** button in the web player does, and that works on free
accounts. Spotify's public interface is the one that requires Premium, and the script only falls back
to it. If Spotify does refuse a request, the studio tells you and requests stop instead of failing
quietly — and the viewer's points are refunded.

## When something stops working

**The overlay shows nothing.** Check that `open.spotify.com` is open in the same browser, that
Tampermonkey is enabled for it, and that the studio page says connected. The script needs that tab to
stay open; it does not run in the background on its own.

**Song requests do nothing.** Play something in that tab once. The script learns where to send a
queue command only after the player has started a track.

**Nothing plays and the panel is red.** You are signed out of Spotify in that tab. Log in and it
picks up on its own.

**It worked yesterday and stopped today.** Spotify changes its web player without notice, and this
script reads that player. Update to the newest version first, then
[open an issue](https://github.com/tokelements/tokelements-spotify/issues) with your browser, the
version from the top of the script, and what you saw.

## Updating

Tampermonkey checks for a new version on its own and installs it. To update now instead of waiting,
the Tampermonkey menu on the Spotify tab has **TokElements: check for updates**, and the TokElements
Spotify page names the version running in your browser and offers the newer one when there is one.

## Uninstall

Open the Tampermonkey dashboard, find **TokElements for Spotify**, and delete it. Nothing stays
behind in your browser, and the pairing on the TokElements side expires by itself.

---

## About TokElements

[TokElements](https://tokelements.com) turns a TikTok LIVE broadcast into overlays for OBS. Gifts,
likes, follows and chat arrive as live events and drive whatever widgets you put on screen: alerts,
goals, leaderboards, games, counters. You can write widgets yourself in HTML, CSS and JavaScript, or
describe one in a sentence and have the assistant build it.

- **Website** — [tokelements.com](https://tokelements.com)
- **Widget documentation** — [tokelements.com/docs](https://tokelements.com/docs)
- **Widget kits other creators published** — [tokelements.com/kits](https://tokelements.com/kits)
- **SoundCloud instead of Spotify** — [tokelements-soundcloud](https://github.com/tokelements/tokelements-soundcloud)

Not affiliated with Spotify. Spotify is a trademark of Spotify AB.

MIT licensed. See [LICENSE](LICENSE).
