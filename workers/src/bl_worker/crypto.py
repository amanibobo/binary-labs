from __future__ import annotations

import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

NONCE_BYTES = 12


def encrypt_token(key: bytes, plaintext: str) -> bytes:
    """Returns nonce(12) || ciphertext || tag(16), the layout the web app writes."""
    nonce = os.urandom(NONCE_BYTES)
    return nonce + AESGCM(key).encrypt(nonce, plaintext.encode(), None)


def decrypt_token(key: bytes, blob: bytes) -> str:
    return AESGCM(key).decrypt(blob[:NONCE_BYTES], blob[NONCE_BYTES:], None).decode()
