/**
 * Set beside a share cookie when a link is first opened, with the same attributes but readable by the page: if the
 * browser kept this one it kept the other, so the page can tell whether reloading will show the album or only ask
 * again. Not under SHARE_COOKIE_PREFIX, which would read it as a share token.
 */
export const SHARE_OPENED_COOKIE = "album_share_opened";
