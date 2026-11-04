import pytest
from fastapi.testclient import TestClient

from bl_worker.embed import HashEmbedder
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
