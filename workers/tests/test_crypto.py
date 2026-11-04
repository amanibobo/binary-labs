import base64
import json

import pytest
from cryptography.exceptions import InvalidTag

from bl_worker.crypto import decrypt_token, encrypt_token
from bl_worker.db import REPO_DIR

VECTOR = json.loads((REPO_DIR / "db" / "test" / "token_vector.json").read_text())


def test_decrypts_the_shared_vector_the_web_app_also_checks():
    key = base64.b64decode(VECTOR["key_b64"])
    assert decrypt_token(key, bytes.fromhex(VECTOR["blob_hex"])) == VECTOR["plaintext"]


def test_round_trip_uses_a_fresh_nonce_each_time():
    key = bytes(32)
    a, b = encrypt_token(key, "sl.refresh"), encrypt_token(key, "sl.refresh")
    assert a[:12] != b[:12]
    assert len(a) == 12 + len("sl.refresh") + 16
    assert decrypt_token(key, a) == "sl.refresh"


def test_tampered_ciphertext_is_rejected():
    key = base64.b64decode(VECTOR["key_b64"])
    blob = bytearray(bytes.fromhex(VECTOR["blob_hex"]))
    blob[15] ^= 1
    with pytest.raises(InvalidTag):
        decrypt_token(key, bytes(blob))
