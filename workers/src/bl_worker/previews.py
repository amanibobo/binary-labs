from __future__ import annotations

import io
import shutil
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from PIL import Image, ImageOps

from bl_worker.config import Settings
from bl_worker.domain import FileKind

LONGEST_SIDE = 640
# PDFium is not thread-safe and worker jobs run in threads.
_PDFIUM_LOCK = threading.Lock()


@dataclass(frozen=True)
class Preview:
    webp: bytes
    width: int
    height: int


class PreviewFailed(Exception):
    """The file's bytes can't be rendered; the location fails, not the job."""


class PreviewStore(Protocol):
    def put(self, key: str, data: bytes) -> None: ...

    def get(self, key: str) -> bytes | None: ...

    def delete_prefix(self, prefix: str) -> int:
        """Deletes every object under the prefix; returns how many it deleted."""
        ...


def lab_prefix(lab_id: object) -> str:
    return f"{lab_id}/"


def preview_key(lab_id: object, sha256: str) -> str:
    return f"{lab_prefix(lab_id)}{sha256}.webp"


class LocalPreviewStore:
    def __init__(self, root: Path) -> None:
        self.root = root

    def put(self, key: str, data: bytes) -> None:
        path = self.root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)

    def get(self, key: str) -> bytes | None:
        path = self.root / key
        return path.read_bytes() if path.is_file() else None

    def delete_prefix(self, prefix: str) -> int:
        folder = self.root / prefix
        if not folder.is_dir():
            return 0
        count = sum(1 for p in folder.rglob("*") if p.is_file())
        shutil.rmtree(folder)
        return count


class R2PreviewStore:
    def __init__(self, account_id: str, access_key_id: str, secret: str, bucket: str) -> None:
        import boto3

        self.bucket = bucket
        self._s3 = boto3.client(
            "s3",
            endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret,
            region_name="auto",
        )

    def put(self, key: str, data: bytes) -> None:
        self._s3.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType="image/webp")

    def get(self, key: str) -> bytes | None:
        try:
            return self._s3.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except self._s3.exceptions.NoSuchKey:
            return None

    def delete_prefix(self, prefix: str) -> int:
        count = 0
        pages = self._s3.get_paginator("list_objects_v2").paginate(
            Bucket=self.bucket, Prefix=prefix
        )
        for page in pages:
            # A listing page holds at most 1000 keys, the most one delete_objects call takes.
            keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
            if not keys:
                continue
            resp = self._s3.delete_objects(
                Bucket=self.bucket, Delete={"Objects": keys, "Quiet": True}
            )
            if resp.get("Errors"):
                raise RuntimeError(f"{len(resp['Errors'])} previews under {prefix} weren't deleted")
            count += len(keys)
        return count


def build_preview_store(settings: Settings) -> PreviewStore:
    if settings.preview_store == "local":
        return LocalPreviewStore(settings.preview_dir)
    if not (settings.r2_account_id and settings.r2_access_key_id and settings.r2_secret_access_key):
        raise ValueError(
            "PREVIEW_STORE=r2 needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY"
        )
    return R2PreviewStore(
        settings.r2_account_id,
        settings.r2_access_key_id,
        settings.r2_secret_access_key.get_secret_value(),
        settings.r2_bucket,
    )


def _to_webp(img: Image.Image) -> Preview:
    img = ImageOps.exif_transpose(img)
    img.thumbnail((LONGEST_SIDE, LONGEST_SIDE))
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
    out = io.BytesIO()
    img.save(out, "WEBP", quality=80)
    return Preview(out.getvalue(), img.width, img.height)


def render_image(data: bytes) -> Preview:
    with Image.open(io.BytesIO(data)) as img:
        img.load()
        return _to_webp(img)


def render_pdf_first_page(data: bytes) -> Preview:
    import pypdfium2 as pdfium

    with _PDFIUM_LOCK:
        pdf = pdfium.PdfDocument(data)
        try:
            page = pdf[0]
            width, height = page.get_size()
            image = page.render(scale=LONGEST_SIDE / max(width, height)).to_pil()
        finally:
            pdf.close()
    return _to_webp(image)


RENDERERS: dict[FileKind, Callable[[bytes], Preview]] = {
    FileKind.IMAGE: render_image,
    FileKind.PDF: render_pdf_first_page,
}


def render_preview(kind: FileKind, data: bytes) -> Preview | None:
    renderer = RENDERERS.get(kind)
    if renderer is None:
        return None
    try:
        return renderer(data)
    except Exception as e:
        raise PreviewFailed(f"preview: {type(e).__name__}: {e}") from e
