-- A second, looser limit on notes per wider network (an IPv6 /48), as sign-in has: a hash, never the address.
ALTER TABLE "VisitorNote" ADD COLUMN "networkHash" TEXT;
CREATE INDEX "VisitorNote_networkHash_createdAt_idx" ON "VisitorNote"("networkHash", "createdAt");
