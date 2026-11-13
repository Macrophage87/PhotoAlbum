# Keeping originals in S3 and Glacier Instant Retrieval (storage Option 2)

The originals are nearly all of the album's disk, and the server's disk (EBS) costs about 20 times as much per
gigabyte as Glacier Instant Retrieval. Option 2 moves each original to S3 once it has been processed, keeps the newest
90 days of it in S3 Standard, and lets S3 move the rest to Glacier Instant Retrieval. Thumbnails, medium images,
transcoded clips and visitor copies stay on the server, so browsing the album never touches S3.

Nothing here is switched on by deploying the code: `STORAGE_DRIVER=local` (the default) behaves exactly as before.

## How it works

| When | What happens |
|---|---|
| Upload | Exactly as today: the original is written to the server's disk and processed from there. |
| A day after the item was last processed | The hourly `offload-originals` job uploads the original to `s3://<bucket>/<prefix>photos/<id>/…`, checks that S3 holds every byte, records it in the `OriginalCopy` table, then deletes the disk's copy. |
| 90 days after it reached S3 | S3's lifecycle rule moves it to Glacier Instant Retrieval. The album does not notice: reads are the same and just as fast. |
| Someone downloads an original, or a scan is opened | Streamed straight from S3. |
| Work that needs the file (re-render after an edit, visitor copy, re-transcode, "Reset to camera date") | A copy is fetched back to the disk first. The hourly job deletes it again a day later. |
| An item is deleted for good | Deleted from the disk and from S3. The bucket keeps the old version for 30 days, so it can still be recovered. |

An original already older than 90 days when it first goes up (the existing album's backlog) is written straight to
Glacier Instant Retrieval, rather than spending 90 days in Standard first. The job moves 300 originals an hour, oldest
first; a 500 GB album of phone photos takes a few days to move, while the album keeps working normally.

The job refuses to run unless the media folder's install marker matches the database (see DEPLOY.md, "The install
marker"), and it never deletes a disk copy until S3 is seen to hold the same number of bytes. The upload itself is
checksummed by the AWS SDK.

## Setting it up

All of this is done once, by someone with admin rights on the AWS account. Steps 1 and 2 cost nothing until the
album starts using the bucket.

### 1. Create the bucket and the access policy

From a machine with the AWS CLI signed in to the account, in the album server's region:

```bash
# The name of the role the album's EC2 instance runs as (its instance profile):
aws ec2 describe-instances --instance-ids i-XXXXXXXX \
  --query 'Reservations[0].Instances[0].IamInstanceProfile.Arn' --output text
aws iam get-instance-profile --instance-profile-name <profile name from the ARN> \
  --query 'InstanceProfile.Roles[0].RoleName' --output text

aws cloudformation deploy \
  --template-file infra/option2-tiered-originals/template.yaml \
  --stack-name album-originals \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides InstanceRoleName=<role name>

aws cloudformation describe-stacks --stack-name album-originals --query 'Stacks[0].Outputs'
```

If the instance has no role yet, create one in the console (EC2 → the instance → Actions → Security → Modify IAM
role), then deploy with its name.

The template makes:

- a private, encrypted, versioned bucket, kept even if the stack is deleted;
- the lifecycle rules: Standard → Glacier Instant Retrieval after 90 days (objects over 128 KB only, since Glacier IR
  bills anything smaller as 128 KB), old versions removed after 30 days, half-finished uploads cleaned up after 7;
- a policy letting the server read, write and delete originals, but not purge old versions or change the bucket.
  Someone who broke into the server could hide originals, not destroy them.

### 2. Let the album's containers use the instance role

The app runs in Docker, one network hop further from the instance metadata service than the instance itself. With
IMDSv2 (the default on new instances) the SDK can only reach it if the hop limit is at least 2:

```bash
aws ec2 modify-instance-metadata-options --instance-id i-XXXXXXXX \
  --http-endpoint enabled --http-tokens required --http-put-response-hop-limit 2
```

### 3. Turn it on

In `.env` on the server (for each install that should use it):

```bash
STORAGE_DRIVER=tiered
ORIGINALS_S3_BUCKET=<BucketName output>
ORIGINALS_S3_PREFIX=live/        # staging/ for the staging install; never the same for two installs
AWS_REGION=<Region output>
```

Then `bash deploy/update.sh` as usual (or `docker compose up -d`). The prefix is required: a staging install whose
database is a copy of live's would otherwise delete live's originals when it deleted a photo.

Check it is working an hour or so later (the job runs at 35 past each hour, and only on items processed a day ago or
more, so a fresh install may show nothing on its first runs):

```bash
docker compose logs app worker 2>/dev/null | grep '\[offload\]'
docker compose exec db psql -U photoalbum -c 'SELECT count(*), pg_size_pretty(sum(bytes)) FROM "OriginalCopy";'
aws s3 ls s3://<bucket>/live/photos/ --recursive --summarize | tail -2
```

### 4. Shrink the server's disk (where the saving comes from)

EBS volumes cannot be made smaller in place. The disk the originals freed is still paid for until the media moves
to a smaller volume. Once `OriginalCopy` covers the album, follow [MOVE-MEDIA.md](MOVE-MEDIA.md) to move the media
folder (now mostly renditions and transcoded clips, much smaller than the originals) onto a new, smaller EBS volume, then delete the
old one. Until then, Option 2 mainly means never having to buy a bigger disk.

## Backups

The nightly `photos-*.tgz` from DEPLOY.md §9 now holds renditions and recent originals only. The originals in S3 are
protected by S3's own durability and by versioning (30 days to undo a delete), not by that backup. For a copy
that survives the AWS account itself being lost or compromised, use storage Option 1 (a Glacier Deep Archive copy in
another region, with deletion locked), pointed at this bucket as well as the disk.

## Turning it off again

Set `STORAGE_DRIVER=local` only after bringing every original back to the disk, or the album will show items
whose originals it cannot find:

```bash
aws s3 sync s3://<bucket>/live/photos/ "$(docker volume inspect photoalbum_photos --format '{{ .Mountpoint }}')/photos/"
sudo chown -R 1000:1000 "$(docker volume inspect photoalbum_photos --format '{{ .Mountpoint }}')/photos"
```

Reading the Glacier Instant Retrieval ones back costs about $0.03 per GB (about $15 for 500 GB), once.

## What it costs to run

Roughly, for a 500 GB album, at US East list prices: about $2–4 a month for the originals (most in Glacier IR), plus
about $0.03 per GB whenever an older original is read back. Uploads cost a few cents per thousand files, and data between S3 and a server in the
same region is free. See the storage options PDF for the full comparison.
