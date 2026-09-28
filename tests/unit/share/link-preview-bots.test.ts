import { describe, expect, it } from "vitest";
import { shouldServeStreamingMetadata } from "next/dist/server/lib/streaming-metadata";
import nextConfig from "../../../next.config";

// Next keeps only the configured pattern's source (loadConfig turns the RegExp into a string), then decides with this.
const streamed = (ua: string) => shouldServeStreamingMetadata(ua, nextConfig.htmlLimitedBots!.source);

describe("which fetchers get a page's og tags in <head>", () => {
  it("serves them in <head> to link-preview fetchers Next does not know", () => {
    for (const ua of [
      "http.rb/5.1.1 (Mastodon/4.2.10; +https://mastodon.social/) Bot",
      "Pleroma 2.6.2; https://pleroma.example <admin@pleroma.example>",
      "Akkoma 3.13.2; https://akkoma.example <admin@akkoma.example>",
      "Misskey/2024.5.0 (https://misskey.example)",
      "Iframely/1.3.1 (+https://iframely.com/docs/about)",
      "Mozilla/5.0 (compatible; Embedly/0.2; +http://support.embed.ly/)",
      "Mozilla/5.0 (compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app)",
      "Synapse/1.110.0 (bot; +https://github.com/matrix-org/synapse)",
      "Mozilla/5.0 (compatible; Pinterestbot/1.0; +http://www.pinterest.com/bot.html)",
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.119 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "curl/8.5.0",
      "Wget/1.21.4",
    ]) expect(streamed(ua), ua).toBe(false);
  });

  it("still serves Next's own list that way", () => {
    for (const ua of [
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "Twitterbot/1.0",
      "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
      "WhatsApp/2.23.20.0",
      "Mediapartners-Google",
    ]) expect(streamed(ua), ua).toBe(false);
  });

  it("streams them to ordinary browsers", () => {
    for (const ua of [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
    ]) expect(streamed(ua), ua).toBe(true);
  });
});
