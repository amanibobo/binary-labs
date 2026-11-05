"""Copies the local object store (PREVIEW_DIR) into the R2 bucket under the same keys.

    uv run python scripts/copy_store_to_r2.py

Safe to rerun: a key already in R2 with the same size is skipped. Nothing local is deleted.
"""

from __future__ import annotations

import sys

from bl_worker.config import load_settings
from bl_worker.previews import R2PreviewStore


def main() -> int:
    s = load_settings()
    if not (s.r2_account_id and s.r2_access_key_id and s.r2_secret_access_key):
        print("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set in .env")
        return 1
    store = R2PreviewStore(
        s.r2_account_id, s.r2_access_key_id, s.r2_secret_access_key.get_secret_value(), s.r2_bucket
    )
    root = s.preview_dir
    copied = skipped = 0
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        key = path.relative_to(root).as_posix()
        size = path.stat().st_size
        try:
            if store._s3.head_object(Bucket=store.bucket, Key=key)["ContentLength"] == size:
                skipped += 1
                continue
        except store._s3.exceptions.ClientError:
            pass
        # Uploaded files are served through presigned links that set their real type, so only
        # previews need one stored.
        kind = "image/webp" if key.endswith(".webp") else "application/octet-stream"
        store._s3.put_object(Bucket=store.bucket, Key=key, Body=path.read_bytes(), ContentType=kind)
        copied += 1
    print(f"copied {copied}, already there {skipped}, from {root}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
