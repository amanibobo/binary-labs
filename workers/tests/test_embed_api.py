import httpx
import pytest
from fastapi.testclient import TestClient

from bl_worker.embed import DIM, QWEN, EmbedServiceError, HashEmbedder, RemoteEmbedder
from bl_worker.embed_api import create_app

KEY = "test-key-123"


@pytest.fixture
def client():
    loads = []

    def load():
        loads.append(1)
        return HashEmbedder()

    with TestClient(create_app(KEY, load)) as c:
        c.loads = loads
        yield c


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong"}, {"Authorization": KEY}])
def test_embed_without_the_key_is_401(client, headers):
    resp = client.post("/embed", json={"text": "P450 gel"}, headers=headers)
    assert resp.status_code == 401
    assert "embedding" not in resp.json()


def test_embed_with_the_key_returns_a_1024_vector_and_the_model(client):
    resp = client.post(
        "/embed", json={"text": "P450 gel"}, headers={"Authorization": f"Bearer {KEY}"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["model"] == "hash-1024"
    assert body["embedding"] == HashEmbedder().embed_query("P450 gel")
    assert len(body["embedding"]) == 1024


def test_model_loads_once_and_healthz_needs_no_key(client):
    for _ in range(3):
        client.post("/embed", json={"text": "x"}, headers={"Authorization": f"Bearer {KEY}"})
    assert client.get("/healthz").json() == {"status": "ok", "model": "hash-1024"}
    assert client.loads == [1]


def test_empty_text_is_rejected(client):
    resp = client.post("/embed", json={"text": ""}, headers={"Authorization": f"Bearer {KEY}"})
    assert resp.status_code == 422


def test_documents_embed_without_the_query_prompt(client):
    texts = ["P450 gel lane 3", "imidazole elution"]
    resp = client.post(
        "/embed/documents", json={"texts": texts}, headers={"Authorization": f"Bearer {KEY}"}
    )
    assert resp.status_code == 200
    assert resp.json() == {
        "embeddings": HashEmbedder().embed_documents(texts),
        "model": "hash-1024",
    }


@pytest.mark.parametrize("texts", [[], ["x"] * 65])
def test_documents_batch_is_bounded(client, texts):
    resp = client.post(
        "/embed/documents", json={"texts": texts}, headers={"Authorization": f"Bearer {KEY}"}
    )
    assert resp.status_code == 422


def test_documents_need_the_key(client):
    assert client.post("/embed/documents", json={"texts": ["x"]}).status_code == 401


def test_remote_embedder_matches_the_in_process_one(client):
    remote = RemoteEmbedder("http://testserver/embed", KEY, "hash-1024", client=client)
    texts = [f"chunk {i} of a plate reader export" for i in range(70)]
    assert remote.embed_documents(texts) == HashEmbedder().embed_documents(texts)
    assert remote.embed_query("P450 gel") == HashEmbedder().embed_query("P450 gel")


def test_remote_embedder_refuses_another_model(client):
    remote = RemoteEmbedder("http://testserver/embed", KEY, QWEN, client=client)
    with pytest.raises(EmbedServiceError, match="hash-1024"):
        remote.embed_documents(["x"])


def mock_client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_remote_embedder_waits_out_a_cold_or_busy_service():
    answers = iter([503, 502, 200])
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers["authorization"])
        status = next(answers)
        if status != 200:
            return httpx.Response(status)
        return httpx.Response(200, json={"embeddings": [[0.0] * DIM], "model": QWEN})

    remote = RemoteEmbedder(
        "https://embed.example/embed", "k", client=mock_client(handler), backoff_s=0
    )
    assert remote.embed_documents(["x"]) == [[0.0] * DIM]
    assert seen == ["Bearer k"] * 3


def test_remote_embedder_fails_the_job_on_a_wrong_key():
    remote = RemoteEmbedder(
        "https://embed.example/embed",
        "k",
        client=mock_client(lambda _r: httpx.Response(401)),
        backoff_s=0,
    )
    with pytest.raises(EmbedServiceError, match="401"):
        remote.embed_documents(["x"])


def test_remote_embedder_gives_up_after_its_tries():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        raise httpx.ConnectError("refused", request=request)

    remote = RemoteEmbedder(
        "https://embed.example/embed", "k", client=mock_client(handler), backoff_s=0
    )
    with pytest.raises(EmbedServiceError, match="ConnectError"):
        remote.embed_documents(["x"])
    assert len(calls) == RemoteEmbedder.TRIES
