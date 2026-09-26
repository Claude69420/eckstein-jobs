"""Regenerates tests/fixtures/prices.enc.json from prices.plain.json with the TEST ONLY key.

    python tests/fixtures/make_prices_fixture.py

The key below is a public, made-up TEST key (bytes 0..31). It is NOT the real PRICE_KEY and must never be
used for real data. The amounts in prices.plain.json are made up too. tests/prices.test.js decrypts the
output with WebCrypto, which proves the Python (cryptography AESGCM) and browser formats agree.
"""
import base64, json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent))
import sync_jobs  # noqa: E402

TEST_ONLY_KEY_B64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="   # TEST ONLY: bytes(range(32))
TEST_IV = bytes(range(0xA0, 0xAC))                                    # fixed so the fixture is reproducible
TEST_AT = "2026-09-26T17:05:01Z"

if __name__ == "__main__":
    plain = json.loads((HERE / "prices.plain.json").read_text(encoding="utf-8"))
    key = sync_jobs.parse_price_key(TEST_ONLY_KEY_B64)
    doc = sync_jobs.encrypt_prices(plain, key, iv=TEST_IV, at=TEST_AT)
    (HERE / "prices.enc.json").write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
    assert sync_jobs.decrypt_prices(doc, key) == plain
    print("wrote prices.enc.json (%d jobs)" % len(plain))
