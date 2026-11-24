/**
 * The page a television opens when the phone app casts a slideshow to it.
 *
 * Google's built-in player shows a picture or plays a song, never both, so the album brings a page of its own: it
 * shows the photograph it is told to and plays the music it is told to, at the same time. It holds nothing of the
 * album's: every picture and song is an address the phone hands it, signed by the album for a few hours (see
 * `lib/cast/link`). It will only fetch such an address from this album, whoever is talking to it, because anything
 * on the same Wi-Fi can talk to a television.
 *
 * Messages arrive on the album's own channel (`CAST_NAMESPACE`) as JSON:
 *   { type: "photo", url, title?, place? }      show this picture
 *   { type: "music", songs: [url], shuffle? }   play these, round and round; an empty list stops the music
 *   { type: "musicPause" } / { type: "musicPlay" } / { type: "musicNext" }
 *   { type: "volume", level }                   0 to 1, for the music only
 * and it answers everyone connected with { type: "music", index, playing, count } whenever the music changes.
 */
export const CAST_NAMESPACE = "urn:x-cast:com.cieply.album";

/** The only addresses the page will fetch: a slide's signed picture, or a signed song, on this album. */
export const CAST_ADDRESS = /^\/api\/(?:photos\/[A-Za-z0-9_-]+\/preview|music\/[A-Za-z0-9_-]+)\?[A-Za-z0-9_=&.%-]+$/;

const SCRIPT = String.raw`
(function () {
  var NS = "__NS__";
  var OK = __OK__;
  var layers = [document.getElementById("a"), document.getElementById("b")];
  var top = 0;
  var caption = document.getElementById("caption");
  var idle = document.getElementById("idle");
  var audio = document.getElementById("music");
  var songs = [];
  var at = 0;
  var context = cast.framework.CastReceiverContext.getInstance();

  function good(url) { return typeof url === "string" && OK.test(url); }

  function tell() {
    try { context.sendCustomMessage(NS, undefined, { type: "music", index: songs.length ? at : -1, playing: songs.length > 0 && !audio.paused, count: songs.length }); } catch (e) {}
  }

  function showPhoto(m) {
    if (!good(m.url)) return;
    var next = layers[1 - top];
    var pre = new Image();
    pre.onload = function () {
      next.src = m.url;
      next.style.opacity = 1;
      layers[top].style.opacity = 0;
      top = 1 - top;
      idle.style.display = "none";
      var words = [m.title, m.place].filter(function (x) { return typeof x === "string" && x; }).join(" · ");
      caption.textContent = words.slice(0, 200);
      caption.style.opacity = words ? 1 : 0;
    };
    pre.src = m.url;
  }

  function play(i) {
    if (!songs.length) { audio.pause(); audio.removeAttribute("src"); tell(); return; }
    at = ((i % songs.length) + songs.length) % songs.length;
    audio.src = songs[at];
    var p = audio.play();
    if (p && p.catch) p.catch(function () {});
  }

  function setMusic(m) {
    var list = (Array.isArray(m.songs) ? m.songs : []).filter(good).slice(0, 500);
    if (m.shuffle) {
      for (var i = list.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = list[i]; list[i] = list[j]; list[j] = t; }
    }
    songs = list;
    play(0);
  }

  audio.addEventListener("ended", function () { play(at + 1); });
  // A song that will not play (its address ran out, the file is gone) is passed over, but one bad song alone must not spin.
  audio.addEventListener("error", function () { if (songs.length > 1) setTimeout(function () { play(at + 1); }, 1500); else tell(); });
  audio.addEventListener("playing", tell);
  audio.addEventListener("pause", tell);

  context.addCustomMessageListener(NS, function (event) {
    var m = event && event.data;
    if (!m || typeof m !== "object") return;
    if (m.type === "photo") showPhoto(m);
    else if (m.type === "music") setMusic(m);
    else if (m.type === "musicPause") audio.pause();
    else if (m.type === "musicPlay") { if (songs.length) { var p = audio.play(); if (p && p.catch) p.catch(function () {}); } }
    else if (m.type === "musicNext") play(at + 1);
    else if (m.type === "volume") { var v = Number(m.level); if (v >= 0 && v <= 1) audio.volume = v; }
  });

  // A phone that walks out of the house cannot say stop. With nobody connected for ten minutes the page closes,
  // so the music does not go round all night; a phone whose Wi-Fi only blinked is back long before that.
  var leaving = null;
  function watchSenders() {
    var none = context.getSenders().length === 0;
    if (none && !leaving) leaving = setTimeout(function () { context.stop(); }, 10 * 60 * 1000);
    if (!none && leaving) { clearTimeout(leaving); leaving = null; }
  }
  context.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED, watchSenders);
  context.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED, watchSenders);

  var options = new cast.framework.CastReceiverOptions();
  // A slideshow is watched for an evening without the television being asked anything; it must not give up after five minutes.
  options.disableIdleTimeout = true;
  // The page shows and plays things itself, so Google's own player is not loaded.
  options.skipPlayersLoad = true;
  options.customNamespaces = {};
  options.customNamespaces[NS] = cast.framework.system.MessageType.JSON;
  context.start(options);
})();
`;

/** The whole page, as text. It is the same for everybody and says nothing about the album but its name. */
export function receiverPage(): string {
  const script = SCRIPT.replace("__NS__", () => CAST_NAMESPACE).replace("__OK__", () => CAST_ADDRESS.toString());
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Family Album</title>
<meta name="robots" content="noindex">
<style>
html,body{margin:0;height:100%;background:#000;color:#fff;font-family:"Atkinson Hyperlegible",Arial,Helvetica,sans-serif;overflow:hidden}
img.slide{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0;transition:opacity .8s ease}
#caption{position:absolute;left:4vw;bottom:5vh;max-width:80vw;font-size:2.6vw;line-height:1.25;padding:.3em .6em;background:rgba(0,0,0,.55);border-radius:.3em;opacity:0;transition:opacity .8s ease}
#idle{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:4vw;color:#cfd6e0}
</style>
</head>
<body>
<div id="idle">Family Album</div>
<img id="a" class="slide" alt="">
<img id="b" class="slide" alt="">
<div id="caption"></div>
<audio id="music" preload="auto"></audio>
<script src="https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js"></script>
<script>${script}</script>
</body>
</html>
`;
}
