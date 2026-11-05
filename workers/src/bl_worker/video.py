"""Reading procedure videos with ffmpeg, an optional system dependency (decisions.md,
"procedure videos"). Without it a video still plays and is found by name: it gets no poster
and no transcript, and the page says why."""

from __future__ import annotations

import io
import logging
import shutil
import subprocess
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from bl_worker.extract import ExtractionFailed
from bl_worker.previews import Preview, to_webp

log = logging.getLogger(__name__)

POSTER_AT_S = (1.0, 0.0)
POSTER_TIMEOUT_S = 60
# A 500 MB video is a few minutes long; its sound is decoded far faster than real time.
AUDIO_TIMEOUT_S = 600
# What the transcriber hears: mono speech-band AAC, about 22 MB an hour.
AUDIO_MIME = "audio/aac"


class NeedsFfmpeg(ExtractionFailed):
    """This worker has no ffmpeg, so it can't take the sound out of a video."""


class NoSound(ExtractionFailed):
    """The video has no audio track."""


@dataclass(frozen=True)
class Ffmpeg:
    """The ffmpeg binary, or None when the host doesn't have one."""

    path: str | None

    @classmethod
    def find(cls, name: str) -> Ffmpeg:
        path = shutil.which(name)
        if path is None:
            log.warning("no ffmpeg at %r: videos get no poster and no transcript", name)
        return cls(path)


@contextmanager
def _on_disk(data: bytes) -> Iterator[Path]:
    # MP4s from phones often keep their index at the end, so ffmpeg needs a file it can seek.
    with tempfile.TemporaryDirectory(prefix="bl-video-") as tmp:
        path = Path(tmp) / "video"
        path.write_bytes(data)
        yield path


def _run(ffmpeg: str, args: list[str], timeout: int) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        [ffmpeg, "-nostdin", "-v", "error", *args],
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def poster(ffmpeg: Ffmpeg, data: bytes) -> Preview | None:
    """One frame, a second in (or the first frame of a shorter clip), as a WebP. None when
    there's no ffmpeg or the frame can't be read: a missing poster never fails the file."""
    if ffmpeg.path is None:
        return None
    try:
        with _on_disk(data) as video:
            for at in POSTER_AT_S:
                out = _run(
                    ffmpeg.path,
                    [
                        "-ss",
                        str(at),
                        "-i",
                        str(video),
                        "-frames:v",
                        "1",
                        "-f",
                        "image2pipe",
                        "-c:v",
                        "png",
                        "-",
                    ],
                    POSTER_TIMEOUT_S,
                )
                if out.returncode == 0 and out.stdout:
                    with Image.open(io.BytesIO(out.stdout)) as img:
                        img.load()
                        return to_webp(img)
    except (OSError, subprocess.TimeoutExpired, Image.UnidentifiedImageError) as e:
        log.info("no poster: %s", e)
    return None


def audio_track(ffmpeg: Ffmpeg, data: bytes) -> bytes:
    """The video's first audio track as AAC. Raises NeedsFfmpeg, NoSound, or ExtractionFailed
    when ffmpeg can't decode it."""
    if ffmpeg.path is None:
        raise NeedsFfmpeg("This worker can't read a video's sound (ffmpeg isn't installed).")
    with _on_disk(data) as video:
        try:
            out = _run(
                ffmpeg.path,
                [
                    "-i",
                    str(video),
                    "-map",
                    "0:a:0",
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "48k",
                    "-f",
                    "adts",
                    "-",
                ],
                AUDIO_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired as e:
            raise ExtractionFailed("Reading this video's sound took too long.") from e
    if out.returncode == 0 and out.stdout:
        return out.stdout
    stderr = out.stderr.decode(errors="replace")
    if "matches no streams" in stderr or out.returncode == 0:
        raise NoSound("This video has no sound to transcribe.")
    log.info("ffmpeg couldn't read audio: %s", stderr[-500:])
    raise ExtractionFailed("We couldn't read the sound in this video.")
