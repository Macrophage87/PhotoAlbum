-- Expired sign-in links are swept out by expiry, on every request and daily.
CREATE INDEX "MagicLinkToken_expiresAt_idx" ON "MagicLinkToken"("expiresAt");
