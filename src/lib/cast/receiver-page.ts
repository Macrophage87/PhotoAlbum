/**
 * The page a television opens when the phone app casts a slideshow to it.
 *
 * Google's built-in player shows a picture or plays a song, never both, so the album brings a page of its own. It
 * shows the photograph or plays the clip it is told to, with its caption, a small map of where it was taken and a
 * title card when the day changes, and plays music underneath. It holds nothing of the album's: every picture,
 * clip and song is an address a phone hands it, signed by the album for a few hours (see `lib/cast/link`). It will
 * only fetch such an address from this album, whoever is talking to it, because anything on the same Wi-Fi can
 * talk to a television.
 *
 * Messages arrive on the album's own channel (`CAST_NAMESPACE`) as JSON. Everything but `type` and `url` is optional,
 * so an older app's shorter messages still work:
 *   { type: "photo", url, id, title, day, place, people: [name], lat, lng, card, show, thumb, next, video, seconds }
 *       show this picture. `card` is the day to announce first, sent when the day changes; `next` is the picture
 *       likely to follow, fetched ahead so the change is quick; `video` is the clip to play, `url` being its still;
 *       `seconds` is how long the picture will stay, which sets how slowly it drifts.
 *   { type: "playing", on, seconds, from }      a phone says it is (or has stopped) moving the slideshow on by itself
 *   { type: "hello" }                           a phone that has just connected asks what is going on
 *   { type: "music", songs: [url], shuffle? }   play these, round and round; an empty list stops the music
 *   { type: "musicPause" } / { type: "musicPlay" } / { type: "musicNext" }
 *   { type: "volume", level }                   0 to 1, for the music only
 * It tells every phone connected:
 *   { type: "state", id, title, day, place, thumb, url, show, playing, driver, seconds, phones }   whenever any of it
 *       changes, so several phones can hold the remote at once and each shows what is really on the screen; `phones`
 *       is how many are connected, so one that leaves knows whether to end the show or leave it to the others
 *   { type: "clipEnded", id }                   a clip has played to its end
 *   { type: "music", index, playing, count }    whenever the music changes
 */
export const CAST_NAMESPACE = "urn:x-cast:com.cieply.album";

/** The only addresses the page will fetch: a slide's signed picture or clip, or a signed song, on this album. */
export const CAST_ADDRESS = /^\/api\/(?:photos\/[A-Za-z0-9_-]+\/(?:preview|video)|music\/[A-Za-z0-9_-]+)\?[A-Za-z0-9_=&.%-]+$/;

/** A slide's small picture, which the page never fetches but passes from one phone to the others. */
export const CAST_THUMB = /^\/api\/photos\/[A-Za-z0-9_-]+\/thumb\?v=\d+$/;

const DEFAULT_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

const SCRIPT = String.raw`
(function () {
  var NS = "__NS__";
  var OK = __OK__;
  var THUMB = __THUMB__;
  var TILES = "__TILES__";
  var $ = function (id) { return document.getElementById(id); };
  var layers = [$("a"), $("b")];
  var top = 0;
  var clip = $("clip");
  var caption = $("caption"), capTitle = $("cap-title"), capWhere = $("cap-where"), capWho = $("cap-who");
  var card = $("card"), cardDay = $("card-day"), cardShow = $("card-show");
  var map = $("map"), mapTiles = $("map-tiles");
  var idle = $("idle");
  var audio = $("music");
  var songs = [];
  var at = 0;
  var context = cast.framework.CastReceiverContext.getInstance();
  var state = { id: null, title: "", day: "", place: "", thumb: "", url: "", show: "", playing: false, driver: null, seconds: 10 };
  var driverSender = null;
  var turn = 0;
  var pans = 0;
  var lastCard = "";
  var musicHeld = false;

  function good(url) { return typeof url === "string" && OK.test(url); }
  function text(x, most) { return typeof x === "string" ? x.slice(0, most || 200) : ""; }
  function say(message) { try { context.sendCustomMessage(NS, undefined, message); } catch (e) {} }

  function tell() {
    say({ type: "music", index: songs.length ? at : -1, playing: songs.length > 0 && !audio.paused, count: songs.length });
  }
  function tellState() {
    say({ type: "state", id: state.id, title: state.title, day: state.day, place: state.place, thumb: state.thumb, url: state.url, show: state.show, playing: state.playing, driver: state.driver, seconds: state.seconds, phones: context.getSenders().length });
  }

  function names(list) {
    var who = (Array.isArray(list) ? list : []).map(function (n) { return text(n, 60); }).filter(Boolean).slice(0, 12);
    if (!who.length) return "";
    if (who.length === 1) return "With " + who[0];
    return "With " + who.slice(0, -1).join(", ") + " and " + who[who.length - 1];
  }

  // A patch of map tiles centred on the place, with a pin in the middle.
  function drawMap(lat, lng) {
    lat = Number(lat); lng = Number(lng);
    if (!TILES || !isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 85 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) { map.style.opacity = 0; return; }
    var zoom = 10, n = Math.pow(2, zoom), size = 256;
    var x = ((lng + 180) / 360) * n;
    var rad = (lat * Math.PI) / 180;
    var y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
    var cx = Math.floor(x), cy = Math.floor(y);
    while (mapTiles.firstChild) mapTiles.removeChild(mapTiles.firstChild);
    for (var j = -1; j <= 1; j++) for (var i = -1; i <= 1; i++) {
      var ty = cy + j;
      if (ty < 0 || ty >= n) continue;
      var tx = (((cx + i) % n) + n) % n;
      var img = document.createElement("img");
      img.alt = "";
      img.src = TILES.replace("{z}", zoom).replace("{x}", tx).replace("{y}", ty);
      img.style.left = (i * size - (x - cx) * size) + "px";
      img.style.top = (j * size - (y - cy) * size) + "px";
      mapTiles.appendChild(img);
    }
    map.style.opacity = 1;
  }

  function stopClip() {
    if (!clip.getAttribute("src")) return;
    clip.pause();
    clip.removeAttribute("src");
    clip.load();
    clip.style.opacity = 0;
    if (musicHeld) { musicHeld = false; var p = audio.play(); if (p && p.catch) p.catch(function () {}); }
  }

  function showPhoto(m, senderId) {
    if (!good(m.url)) return;
    var mine = ++turn;
    var next = layers[1 - top];
    var announce = text(m.card, 80);
    var wait = 0;
    if (announce && announce !== lastCard) {
      cardDay.textContent = announce;
      cardShow.textContent = text(m.show, 80);
      card.style.opacity = 1;
      wait = 2800;
    }
    lastCard = announce || lastCard;

    state.id = text(m.id, 64) || null;
    state.title = text(m.title); state.day = text(m.day, 80); state.place = text(m.place); state.show = text(m.show, 80);
    state.thumb = typeof m.thumb === "string" && THUMB.test(m.thumb) ? m.thumb : "";
    state.url = m.url;
    var seconds = Number(m.seconds);
    if (seconds >= 2 && seconds <= 600) state.seconds = seconds;
    tellState();

    var began = Date.now();
    var pre = new Image();
    pre.onload = function () {
      setTimeout(function () {
        // A newer picture was asked for while this one was on its way.
        if (mine !== turn) return;
        stopClip();
        next.style.animation = "none";
        next.src = m.url;
        // Reading a size makes the browser take "none" before the new drift is set, so the drift starts over.
        void next.offsetWidth;
        next.style.animation = (pans++ % 2 ? "drift-a " : "drift-b ") + Math.max(8, state.seconds + 3) + "s ease-out forwards";
        next.style.opacity = 1;
        layers[top].style.opacity = 0;
        top = 1 - top;
        idle.style.display = "none";
        card.style.opacity = 0;

        capTitle.textContent = state.title;
        capWhere.textContent = [state.day, state.place].filter(Boolean).join(" · ");
        capWho.textContent = names(m.people);
        caption.style.opacity = capTitle.textContent || capWhere.textContent || capWho.textContent ? 1 : 0;
        drawMap(m.lat, m.lng);

        if (good(m.video)) {
          clip.src = m.video;
          clip.style.opacity = 1;
          if (songs.length && !audio.paused) { musicHeld = true; audio.pause(); }
          var p = clip.play();
          if (p && p.catch) p.catch(function () {});
        }
        if (good(m.next)) { var ahead = new Image(); ahead.src = m.next; }
      }, Math.max(0, wait - (Date.now() - began)));
    };
    pre.onerror = function () { if (mine === turn) card.style.opacity = 0; };
    pre.src = m.url;
  }

  clip.addEventListener("ended", function () {
    if (musicHeld) { musicHeld = false; var p = audio.play(); if (p && p.catch) p.catch(function () {}); }
    say({ type: "clipEnded", id: state.id });
  });
  clip.addEventListener("error", function () { if (clip.getAttribute("src")) { clip.style.opacity = 0; say({ type: "clipEnded", id: state.id }); } });

  function play(i) {
    if (!songs.length) { audio.pause(); audio.removeAttribute("src"); musicHeld = false; tell(); return; }
    at = ((i % songs.length) + songs.length) % songs.length;
    audio.src = songs[at];
    // A clip that is playing keeps the floor; the music comes back when it ends.
    if (clip.getAttribute("src") && !clip.ended) { musicHeld = true; tell(); return; }
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
    if (m.type === "photo") showPhoto(m, event.senderId);
    else if (m.type === "playing") {
      state.playing = Boolean(m.on);
      state.driver = state.playing ? text(m.from, 64) || null : null;
      driverSender = state.playing ? event.senderId : null;
      var s = Number(m.seconds);
      if (s >= 2 && s <= 600) state.seconds = s;
      tellState();
    }
    else if (m.type === "hello") { tellState(); tell(); }
    else if (m.type === "music") setMusic(m);
    else if (m.type === "musicPause") { musicHeld = false; audio.pause(); }
    else if (m.type === "musicPlay") { if (songs.length) { var p = audio.play(); if (p && p.catch) p.catch(function () {}); } }
    else if (m.type === "musicNext") play(at + 1);
    else if (m.type === "volume") { var v = Number(m.level); if (v >= 0 && v <= 1) audio.volume = v; }
  });

  // A phone that walks out of the house cannot say stop. With nobody connected for ten minutes the page closes,
  // so the music does not go round all night; a phone whose Wi-Fi only blinked is back long before that.
  var leaving = null;
  function watchSenders(event) {
    var none = context.getSenders().length === 0;
    if (none && !leaving) leaving = setTimeout(function () { context.stop(); }, 10 * 60 * 1000);
    if (!none && leaving) { clearTimeout(leaving); leaving = null; }
    // The phone that was moving the slideshow on has gone: say so, so another can take over.
    if (event && event.type === cast.framework.system.EventType.SENDER_DISCONNECTED && driverSender && event.senderId === driverSender) {
      state.playing = false; state.driver = null; driverSender = null;
    }
    tellState();
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

/** The script alone, with the album's own values in it. Exported so a test can check it is sound JavaScript. */
export function receiverScript(): string {
  // The map's tiles come from wherever the album's own maps get theirs; only a plain https template is passed on.
  const template = process.env.NEXT_PUBLIC_TILE_URL || DEFAULT_TILES;
  const tiles = /^https:\/\/[A-Za-z0-9.{}\/_?=&%-]+$/.test(template) ? template : "";
  return SCRIPT.replace("__NS__", () => CAST_NAMESPACE)
    .replace("__OK__", () => CAST_ADDRESS.toString())
    .replace("__THUMB__", () => CAST_THUMB.toString())
    .replace("__TILES__", () => tiles);
}

/** The whole page, as text. It is the same for everybody and says nothing about the album but its name. */
export function receiverPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Family Album</title>
<meta name="robots" content="noindex">
<style>
html,body{margin:0;height:100%;background:#000;color:#fff;font-family:"Atkinson Hyperlegible",Arial,Helvetica,sans-serif;overflow:hidden}
img.slide,#clip{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0;transition:opacity 1.2s ease}
#clip{background:#000}
@keyframes drift-a{from{transform:scale(1) translate(0,0)}to{transform:scale(1.07) translate(-1.2%,-.8%)}}
@keyframes drift-b{from{transform:scale(1.07) translate(1.2%,.8%)}to{transform:scale(1) translate(0,0)}}
#caption{position:absolute;left:4vw;bottom:5vh;max-width:64vw;padding:.6vw 1.1vw;background:rgba(0,0,0,.55);border-radius:.6vw;opacity:0;transition:opacity 1.2s ease}
#cap-title{font-size:2.6vw;line-height:1.25;font-weight:bold}
#cap-where,#cap-who{font-size:1.9vw;line-height:1.3;color:#e6ebf2}
#cap-title:empty,#cap-where:empty,#cap-who:empty{display:none}
#map{position:absolute;right:4vw;bottom:5vh;width:17vw;height:17vw;border-radius:.8vw;overflow:hidden;border:.2vw solid rgba(255,255,255,.85);background:#223;opacity:0;transition:opacity 1.2s ease}
#map-tiles{position:absolute;left:50%;top:50%}
#map-tiles img{position:absolute;width:256px;height:256px;max-width:none}
#map-pin{position:absolute;left:50%;top:50%;width:1.4vw;height:1.4vw;margin:-.7vw 0 0 -.7vw;border-radius:50%;background:#e07a2f;border:.25vw solid #fff;box-sizing:border-box}
#map-credit{position:absolute;right:0;bottom:0;font-size:.75vw;padding:0 .3vw;background:rgba(255,255,255,.8);color:#222}
#card{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;background:rgba(8,12,20,.92);opacity:0;transition:opacity .8s ease}
#card-day{font-size:5vw;font-weight:bold;padding:0 6vw}
#card-show{font-size:2.4vw;color:#cfd6e0;margin-top:1.2vw}
#idle{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:4vw;color:#cfd6e0}
</style>
</head>
<body>
<div id="idle">Family Album</div>
<img id="a" class="slide" alt="">
<img id="b" class="slide" alt="">
<video id="clip" playsinline></video>
<div id="map"><div id="map-tiles"></div><div id="map-pin"></div><div id="map-credit">© OpenStreetMap</div></div>
<div id="caption"><div id="cap-title"></div><div id="cap-where"></div><div id="cap-who"></div></div>
<div id="card"><div id="card-day"></div><div id="card-show"></div></div>
<audio id="music" preload="auto"></audio>
<script src="https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js"></script>
<script>${receiverScript()}</script>
</body>
</html>
`;
}
