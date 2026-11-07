from __future__ import annotations

from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]


def test_schema_tiene_la_tabla_y_columnas_del_contrato():
    text = (API_DIR / "schema.sql").read_text(encoding="utf-8")

    assert "CREATE TABLE IF NOT EXISTS users" in text
    assert "id INT NOT NULL AUTO_INCREMENT" in text
    assert "email VARCHAR(255) NOT NULL" in text
    assert "password_hash VARCHAR(255) NOT NULL" in text
    assert "created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP" in text
    assert "UNIQUE KEY uq_users_email (email)" in text


def test_schema_se_divide_en_una_sentencia(api_module):
    statements = api_module._schema_statements()

    assert len(statements) == 1
    assert statements[0].startswith("CREATE TABLE IF NOT EXISTS users")


def test_schema_es_idempotente_en_mysql(app, api_module, using_mysql):
    if not using_mysql:
        pytest.skip("requiere TEST_MYSQL=1 y docker-compose")

    api_module.ensure_schema(app, force=True)
    api_module.ensure_schema(app, force=True)
