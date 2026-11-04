import secrets
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from bl_worker.embed import Embedder


class EmbedRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


class EmbedResponse(BaseModel):
    embedding: list[float]
    model: str


def create_app(api_key: str, load_embedder: Callable[[], Embedder]) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.embedder = load_embedder()
        yield

    app = FastAPI(lifespan=lifespan)
    bearer = HTTPBearer(auto_error=False)

    def require_key(
        creds: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    ) -> None:
        if creds is None or not secrets.compare_digest(creds.credentials, api_key):
            raise HTTPException(401, "missing or wrong API key")

    @app.get("/healthz")
    def healthz(request: Request) -> dict[str, str]:
        return {"status": "ok", "model": request.app.state.embedder.model_name}

    # A plain def runs in FastAPI's thread pool, so encoding doesn't block the event loop.
    @app.post("/embed", dependencies=[Depends(require_key)])
    def embed(body: EmbedRequest, request: Request) -> EmbedResponse:
        embedder: Embedder = request.app.state.embedder
        return EmbedResponse(embedding=embedder.embed_query(body.text), model=embedder.model_name)

    return app
