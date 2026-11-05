"""Checks the R2 bucket the way the app uses it, under a throwaway prefix it cleans up.

    uv run python scripts/check_r2.py [--origin http://localhost:3000]

Read and write, byte ranges, multipart (video uploads), the CORS rule a browser PUT needs, and
the lifecycle rule that clears abandoned multipart uploads. Prints one line per check; exits 1
if any fail.
"""

from __future__ import annotations

import argparse
import sys
import urllib.request
import uuid

from bl_worker.config import load_settings
from bl_worker.previews import R2PreviewStore


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--origin", default="http://localhost:3000")
    args = parser.parse_args()

    s = load_settings()
    if not (s.r2_account_id and s.r2_access_key_id and s.r2_secret_access_key):
        print("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set in .env")
        return 1
    store = R2PreviewStore(
        s.r2_account_id, s.r2_access_key_id, s.r2_secret_access_key.get_secret_value(), s.r2_bucket
    )
    s3 = store._s3
    prefix = f"_check/{uuid.uuid4()}/"
    results: list[tuple[str, bool, str]] = []

    def check(name: str, fn) -> None:
        try:
            detail = fn() or ""
            results.append((name, True, detail))
        except Exception as e:
            results.append((name, False, f"{type(e).__name__}: {e}"))

    data = bytes(range(256)) * 64

    def put_get() -> str:
        store.put(prefix + "a", data)
        got = store.get(prefix + "a")
        assert got == data, "read back different bytes"
        assert store.get(prefix + "missing") is None, "a missing key didn't read as missing"
        return f"{len(data)} bytes"

    def byte_range() -> str:
        part = s3.get_object(Bucket=store.bucket, Key=prefix + "a", Range="bytes=10-19")
        assert part["Body"].read() == data[10:20], "wrong bytes for the range"
        return part.get("ContentRange", "")

    def multipart() -> str:
        key = prefix + "video"
        up = s3.create_multipart_upload(Bucket=store.bucket, Key=key)
        chunk = b"x" * (5 * 1024 * 1024)
        etags = [
            s3.upload_part(
                Bucket=store.bucket, Key=key, UploadId=up["UploadId"], PartNumber=n, Body=chunk
            )["ETag"]
            for n in (1, 2)
        ]
        s3.complete_multipart_upload(
            Bucket=store.bucket,
            Key=key,
            UploadId=up["UploadId"],
            MultipartUpload={
                "Parts": [{"ETag": e, "PartNumber": i + 1} for i, e in enumerate(etags)]
            },
        )
        size = s3.head_object(Bucket=store.bucket, Key=key)["ContentLength"]
        assert size == 2 * len(chunk), f"joined object is {size} bytes"
        return f"{size} bytes in 2 parts"

    def browser_put() -> str:
        url = s3.generate_presigned_url(
            "put_object", Params={"Bucket": store.bucket, "Key": prefix + "browser"}, ExpiresIn=300
        )
        pre = urllib.request.Request(
            url,
            method="OPTIONS",
            headers={"Origin": args.origin, "Access-Control-Request-Method": "PUT"},
        )
        with urllib.request.urlopen(pre) as r:
            allowed = r.headers.get("Access-Control-Allow-Origin")
            exposed = (r.headers.get("Access-Control-Expose-Headers") or "").lower()
        assert allowed in (args.origin, "*"), f"CORS doesn't allow {args.origin} (got {allowed!r})"
        put = urllib.request.Request(
            url, data=b"hello", method="PUT", headers={"Origin": args.origin}
        )
        with urllib.request.urlopen(put) as r:
            exposed = exposed or (r.headers.get("Access-Control-Expose-Headers") or "").lower()
            etag = r.headers.get("ETag")
        assert etag, "the PUT returned no ETag"
        assert "etag" in exposed, "CORS rule doesn't expose ETag; video uploads can't finish"
        return f"origin {allowed}, ETag exposed"

    def lifecycle() -> str:
        rules = s3.get_bucket_lifecycle_configuration(Bucket=store.bucket).get("Rules", [])
        aborts = [
            r
            for r in rules
            if r.get("Status") == "Enabled" and r.get("AbortIncompleteMultipartUpload")
        ]
        assert aborts, "no enabled rule aborts incomplete multipart uploads"
        days = aborts[0]["AbortIncompleteMultipartUpload"].get("DaysAfterInitiation")
        return f"aborts after {days} day(s)"

    def cleanup() -> str:
        return f"{store.delete_prefix(prefix)} objects removed"

    check("read and write", put_get)
    check("byte ranges", byte_range)
    check("multipart upload", multipart)
    check("browser upload (CORS)", browser_put)
    check("abandoned upload cleanup (lifecycle)", lifecycle)
    check("delete a prefix", cleanup)

    for name, ok, detail in results:
        print(f"{'ok  ' if ok else 'FAIL'} {name}{': ' + detail if detail else ''}")
    return 0 if all(ok for _, ok, _ in results) else 1


if __name__ == "__main__":
    sys.exit(main())
