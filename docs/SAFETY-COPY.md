# The safety copy in Glacier Deep Archive

Every night the album's server sends a copy of every photo, clip and scan, and a dump of the database, to Amazon S3
Glacier Deep Archive in another AWS region. Nothing changes for anyone using the album: the server keeps working
exactly as before, and the copy sits there for the day the server, its disk or the account is lost.

What is in the repository:

| File | What it is |
|---|---|
| [`infra/aws/safety-copy/safety-copy.yaml`](../infra/aws/safety-copy/safety-copy.yaml) | CloudFormation: the bucket, its lock and clean-up rules, and the server's permission to write to it |
| [`deploy/safety-copy.sh`](../deploy/safety-copy.sh) | The nightly job, run by cron on the server |
| [`deploy/safety-copy-restore.sh`](../deploy/safety-copy-restore.sh) | Getting everything back after a disaster |

This is separate from the local dumps of [DEPLOY.md §9](DEPLOY.md#9-backups), which are on the same disk as the
album and good for undoing a mistake quickly. Keep both.

## How it protects the photos

- **Another region.** The album's server runs on EC2. The bucket goes in a different region, so a regional outage
  cannot take both.
- **Locked.** S3 Object Lock keeps every version the job writes for 90 days (`LockDays`), whatever happens on the
  server. The server's role may add files and mark them deleted, but it is explicitly denied deleting a stored
  version, shortening a lock, reading files back out of the archive, or changing the bucket's settings. Someone who
  broke into the server could not erase the copy.
- **Versioned.** A photo the album deletes gets a delete marker in the copy; the file itself stays for 180 days
  (`KeepDeletedDays`) and then goes, so the copy does not keep a removed or forgotten photo for ever. A
  database dump is kept for 90 days (`DatabaseDumpDays`), then 180 more underneath a delete marker.
- **Checked before it mirrors.** The job refuses to run against a folder without the album's `.album-install-id`,
  and if the media suddenly has many fewer files than the night before (more than 10% and more than 100 files) it
  copies what is there but marks nothing deleted, and fails, so an unmounted drive is noticed instead of mirrored.
- **Encrypted** at rest (SSE-S3), reachable only over HTTPS, never public.

What is **not** in it: `.env`, and with it `FORGET_KEY`. Keep those where DEPLOY.md says, apart from the album.

## What it costs

Approximate US list prices for a 500 GB album of about 125,000 photos (a 4 MB phone photo, with its two web copies,
is three files):

| | Cost |
|---|---|
| Keeping the copy | about **$0.50 a month** ($1 per TB) |
| Each new photo | about $0.0002 once (three uploads at $0.05 per 1,000), then $0.000004 a month |
| Sending the existing library the first time | about **$30 once**: $10 to move 500 GB between regions, $19 for ~375,000 uploads |
| A full recovery (Bulk, within 48 hours) | about $25: $1.25 to restore 500 GB, $9 in requests, $10 to move it back |
| A full recovery (Standard, within 12 hours) | about $60 |

Deep Archive charges for at least 180 days per file, so a photo deleted soon after it was copied still costs
180 days of storage: a fraction of a cent.

The first copy of a big library takes a few hours; the job holds a lock so the next night's run waits its turn.

## Setting it up

You need an AWS login allowed to create CloudFormation stacks, S3 buckets and IAM roles, and the AWS CLI on your own
computer (or CloudShell in the console).

**1. Pick the region.** Any region other than the server's: see the server's region in the EC2 console. For a server
in `us-east-1`, `us-west-2` is a good choice.

**2. Does the server have a role?** In the EC2 console, select the instance; **IAM Role** is on the Security tab.
Note its name. If it is empty, leave `WriterRoleName` out below and the stack makes one.

**3. Create the stack** in the backup region:

```bash
aws cloudformation deploy \
  --region us-west-2 \
  --stack-name photoalbum-safety-copy \
  --template-file infra/aws/safety-copy/safety-copy.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides WriterRoleName=the-role-from-step-2
aws cloudformation describe-stacks --region us-west-2 --stack-name photoalbum-safety-copy --query 'Stacks[0].Outputs'
```

The other parameters (`LockMode`, `LockDays`, `KeepDeletedDays`, `DatabaseDumpDays`, `BucketName`) have sensible
defaults; the template explains each. `LockMode=COMPLIANCE` makes the lock binding even on the account's root user,
and cannot be loosened afterwards: start with the default `GOVERNANCE`.

If the stack made the role (no `WriterRoleName`), attach it: EC2 console, the instance, **Actions → Security →
Modify IAM role**, choose the `InstanceProfile` from the outputs.

**4. Configure the server.** As root on the server, write `/etc/photoalbum-safety-copy.env` with the outputs:

```bash
sudo install -m 600 /dev/null /etc/photoalbum-safety-copy.env
sudo tee /etc/photoalbum-safety-copy.env > /dev/null <<'EOF'
APP_DIR=/cieply/sites/cieply.com/PhotoAlbum-live
SAFETY_COPY_BUCKET=the-BucketName-output
SAFETY_COPY_REGION=us-west-2
EOF
```

**5. Run it once by hand** and watch it (the first run sends the whole library):

```bash
sudo /cieply/sites/cieply.com/PhotoAlbum-live/deploy/safety-copy.sh
```

It ends with `== … done ==`. If AWS refuses it, the instance has no role yet or is not using it: check step 2 or 3.

**6. Run it every night:**

```bash
echo '15 4 * * * root /cieply/sites/cieply.com/PhotoAlbum-live/deploy/safety-copy.sh >> /var/log/photoalbum-safety-copy.log 2>&1' \
  | sudo tee /etc/cron.d/photoalbum-safety-copy
```

4:15 is after the local backup of DEPLOY.md §9. Only the live instance needs a copy; staging's data is a rehearsal.

## Checking on it

```bash
sudo tail -n 20 /var/log/photoalbum-safety-copy.log
aws s3 cp s3://the-bucket/PhotoAlbum-live/last-success.json - --region us-west-2
```

`last-success.json` says when the last run finished and how many files and bytes it covered. To be told when the
job stops, set `SAFETY_COPY_PING_URL` in the config file to a dead-man's-switch check (healthchecks.io, Cronitor,
or an UptimeRobot heartbeat): the job fetches it after every run that went through, and the service emails you
when a night is missed.

If the log says the media shrank: look at whether the drive is mounted and the album looks right. If a lot really
was deleted, run once with `SAFETY_COPY_SHRINK_LIMIT=100` in front of the command.

## Getting everything back

Deep Archive files are not readable straight away. Each one is asked for, and S3 makes a readable copy within 48
hours (Bulk) or 12 hours (Standard). Run these on the new server, as a user with an admin's AWS credentials (the
server's own role is not allowed to restore), with `SAFETY_COPY_BUCKET`, `SAFETY_COPY_REGION` and
`SAFETY_COPY_PREFIX=PhotoAlbum-live` set:

```bash
deploy/safety-copy-restore.sh request              # RESTORE_TIER=Standard for 12 hours instead of 48
deploy/safety-copy-restore.sh status               # until "still waiting: 0"
deploy/safety-copy-restore.sh download /restore    # media into /restore/media, the newest dump beside it
```

Then follow DEPLOY.md §9, "To restore on a new server", with the dump from `/restore` and the media folder in place
of the tar file:

```bash
docker run --rm -v photoalbum_photos:/data -v /restore/media:/restore:ro alpine cp -a /restore/. /data/
```

and put `.env` back, with its `FORGET_KEY`, from wherever you keep it.

### Going back further than last night

The bucket keeps older versions, so a photo deleted or a database from weeks ago (within the times above) can be
brought back too. List what there is, restore that version, then fetch it:

```bash
aws s3api list-object-versions --bucket the-bucket --prefix db/PhotoAlbum-live/ --region us-west-2
aws s3api restore-object --bucket the-bucket --key KEY --version-id VERSION --region us-west-2 \
  --restore-request '{"Days":7,"GlacierJobParameters":{"Tier":"Bulk"}}'
aws s3api get-object --bucket the-bucket --key KEY --version-id VERSION --region us-west-2 out.file
```

The media and the database belong together; restore both from the same night (see MOVE-MEDIA.md, "Photos are there
but the album does not know them").

## Changing or removing it

Change a parameter with the same `aws cloudformation deploy` command. Deleting the stack removes the role and the
policy but **keeps the bucket and everything in it**, on purpose. Emptying it takes an admin who may bypass a
GOVERNANCE lock, after each version's lock has run out under COMPLIANCE.
