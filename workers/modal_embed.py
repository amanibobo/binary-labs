"""The embedding service on Modal: Qwen3-Embedding-0.6B on one L4 GPU, scaled to zero.

It serves embed_api.py, the same app as `bl serve-embed`: POST /embed for search queries (the
web app, with a 250 ms budget), POST /embed/documents for file chunks (the worker, with
EMBEDDER=remote), and GET /healthz. Both POSTs need `Authorization: Bearer $EMBED_API_KEY`,
read from the Modal secret `binary-embed`. docs/deploy.md has the steps; from workers/:

    uvx modal secret create binary-embed EMBED_API_KEY=<the web app's EMBED_API_KEY>
    uvx modal deploy modal_embed.py

The URL is https://<workspace>--binary-embed.modal.run; EMBED_URL is that plus /embed.

Choices (docs/decisions.md, "going online: hosts and how they fit"):
- L4: fp32 runs ~4x a T4 (30 against 8 TFLOPS), and the model stays in fp32 so vectors match
  the ones dev machines wrote.
- The weights are baked into the image, so a cold start loads 1.2 GB from local disk instead
  of downloading it.
- One container takes many requests at once; QwenEmbedder's lock gives the GPU one batch at
  a time, which keeps a query from waiting behind a cold second container.
- Five idle minutes before it scales to zero: a search session keeps it warm, and an idle
  hour costs nothing.
"""

from pathlib import Path

import modal

MODEL = "Qwen/Qwen3-Embedding-0.6B"
# Pinned so a new upload to the model repo can't change vectors under stored chunks.
REVISION = "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"
HF_HOME = "/models"
SRC = Path(__file__).parent / "src" / "bl_worker"


def download_weights() -> None:
    from huggingface_hub import snapshot_download

    snapshot_download(MODEL, revision=REVISION)


image = (
    modal.Image.debian_slim(python_version="3.12")
    # The versions in workers/uv.lock, so the service runs what the worker was tested with.
    .pip_install(
        "torch==2.15.0",
        "sentence-transformers==6.2.0",
        "transformers==5.22.1",
        "huggingface-hub==2.4.0",
        "fastapi==0.162.0",
        "pydantic==2.14.2",
    )
    .env({"HF_HOME": HF_HOME})
    .run_function(download_weights)
    .env({"HF_HUB_OFFLINE": "1"})
    # embed.py and embed_api.py import nothing else from bl_worker.
    .add_local_dir(SRC, remote_path="/root/bl_worker")
)

app = modal.App("binary-embed", image=image)


@app.cls(
    gpu="L4",
    scaledown_window=300,
    min_containers=0,
    # A first scan sends batches from four worker jobs at once; one GPU keeps up, and a cap
    # keeps a runaway client from fanning out to many.
    max_containers=2,
    timeout=600,
    secrets=[modal.Secret.from_name("binary-embed")],
)
@modal.concurrent(max_inputs=16)
class Embedder:
    @modal.enter()
    def load(self) -> None:
        import time

        from bl_worker.embed import QwenEmbedder

        started = time.monotonic()
        self.embedder = QwenEmbedder(MODEL)
        # Shows up in `modal app logs binary-embed`: the model's share of a cold start.
        print(f"loaded {MODEL} in {time.monotonic() - started:.1f}s")

    @modal.asgi_app(label="binary-embed")
    def web(self):
        import os

        from bl_worker.embed_api import create_app

        return create_app(os.environ["EMBED_API_KEY"], lambda: self.embedder)
