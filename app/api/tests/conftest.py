"""Fixtures de las pruebas de la API (A6).

Las pruebas son herméticas por defecto: DynamoDB/S3 con ``moto`` y MySQL con
un adaptador SQLite en memoria. Con ``TEST_MYSQL=1`` la misma suite usa el
MySQL real de docker-compose (se trunca ``users`` entre pruebas).
"""

from __future__ import annotations

import importlib.util
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any, Dict, Optional

import boto3
import pymysql
import pytest
from moto import mock_aws

API_DIR = Path(__file__).resolve().parents[1]
USE_MYSQL = os.environ.get("TEST_MYSQL") == "1"

# Variables ficticias antes de importar app.py. En modo MySQL se respetan las
# variables DB_* que haya exportado el desarrollador.
os.environ.setdefault("DOCS_BUCKET", "test-docs-bucket")
os.environ.setdefault("DDB_TABLE", "documents")
os.environ.setdefault("DB_HOST", "127.0.0.1")
os.environ.setdefault("DB_NAME", "docuprocess")
os.environ.setdefault("DB_USER", "docuadmin")
os.environ.setdefault("DB_PASSWORD", "test-password")
os.environ.setdefault("JWT_SECRET", "test-secret-0123456789abcdefghij")
os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault(
    "CORS_ALLOWED_ORIGINS", "http://localhost:5500,http://127.0.0.1:5500"
)
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")
os.environ.setdefault("AWS_SESSION_TOKEN", "testing")
os.environ.pop("DDB_ENDPOINT_URL", None)

if USE_MYSQL:
    os.environ.setdefault("DB_PORT", "3306")
else:
    # Puerto cerrado: el intento de esquema del import falla rápido y las
    # pruebas usan el adaptador SQLite.
    os.environ["DB_PORT"] = "1"


def _load_api_module():
    spec = importlib.util.spec_from_file_location(
        "docuprocess_api", API_DIR / "app.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


api = _load_api_module()


# ---------------------------------------------------------------------------
# Adaptador MySQL -> SQLite (solo pruebas)
# ---------------------------------------------------------------------------


class SQLiteCursor:
    def __init__(self, cursor: sqlite3.Cursor) -> None:
        self._cursor = cursor
        self.lastrowid: Optional[int] = None

    def __enter__(self) -> "SQLiteCursor":
        return self

    def __exit__(self, exc_type, exc, traceback) -> bool:
        self._cursor.close()
        return False

    def execute(self, sql: str, params: Any = None) -> "SQLiteCursor":
        translated = sql.replace("%s", "?")
        try:
            if params is None:
                self._cursor.execute(translated)
            else:
                self._cursor.execute(translated, params)
        except sqlite3.IntegrityError as exc:
            # Mismo código que MySQL para que create_user lo traduzca a 409.
            raise pymysql.err.IntegrityError(1062, str(exc)) from exc
        self.lastrowid = self._cursor.lastrowid
        return self

    def fetchone(self) -> Optional[Dict[str, Any]]:
        row = self._cursor.fetchone()
        return dict(row) if row is not None else None

    def fetchall(self):
        return [dict(row) for row in self._cursor.fetchall()]


class SQLiteConnection:
    """Conexión SQLite persistente durante una prueba."""

    def __init__(self) -> None:
        self._connection = sqlite3.connect(":memory:", check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute(
            """
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        self._connection.commit()

    def cursor(self) -> SQLiteCursor:
        return SQLiteCursor(self._connection.cursor())

    def close(self) -> None:
        # La conexión vive hasta que termina la prueba.
        pass

    def destroy(self) -> None:
        self._connection.close()


def _mark_schema_ready(app=None) -> None:
    if app is None:
        app = api.current_app._get_current_object()
    api.get_runtime(app).schema_ready = True


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def api_module():
    return api


@pytest.fixture(scope="session")
def using_mysql() -> bool:
    return USE_MYSQL


@pytest.fixture
def aws(monkeypatch):
    """DynamoDB Local y S3 simulados con la tabla/GSI del contrato C1."""

    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "testing")

    with mock_aws():
        ddb = boto3.client("dynamodb", region_name="us-east-1")
        ddb.create_table(
            TableName="documents",
            BillingMode="PAY_PER_REQUEST",
            AttributeDefinitions=[
                {"AttributeName": "documentId", "AttributeType": "S"},
                {"AttributeName": "userId", "AttributeType": "S"},
                {"AttributeName": "status", "AttributeType": "S"},
                {"AttributeName": "createdAt", "AttributeType": "S"},
            ],
            KeySchema=[{"AttributeName": "documentId", "KeyType": "HASH"}],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": "userId-createdAt",
                    "KeySchema": [
                        {"AttributeName": "userId", "KeyType": "HASH"},
                        {"AttributeName": "createdAt", "KeyType": "RANGE"},
                    ],
                    "Projection": {"ProjectionType": "ALL"},
                },
                {
                    "IndexName": "status-createdAt",
                    "KeySchema": [
                        {"AttributeName": "status", "KeyType": "HASH"},
                        {"AttributeName": "createdAt", "KeyType": "RANGE"},
                    ],
                    "Projection": {"ProjectionType": "ALL"},
                },
            ],
        )
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket="test-docs-bucket")
        yield


@pytest.fixture
def app(aws, monkeypatch):
    if USE_MYSQL:
        application = api.create_app()
        api.ensure_schema(application, force=True)
        connection = api.get_db_connection(application)
        try:
            with connection.cursor() as cursor:
                cursor.execute("TRUNCATE TABLE users")
        finally:
            connection.close()
        application.config.update(TESTING=True)
        yield application
        return

    connection = SQLiteConnection()

    def fake_get_db_connection(app=None):
        return connection

    monkeypatch.setattr(api, "get_db_connection", fake_get_db_connection)
    monkeypatch.setattr(
        api,
        "ensure_schema",
        lambda app=None, force=False: _mark_schema_ready(app),
    )

    application = api.create_app()
    application.config.update(TESTING=True)
    yield application
    connection.destroy()


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def register_and_login(client):
    """Registra e inicia sesión; devuelve (headers, userId, token)."""

    def _do(
        email: str = "user@example.com",
        password: str = "password123",
    ):
        registered = client.post(
            "/api/auth/register",
            json={"email": email, "password": password},
        )
        assert registered.status_code == 201, registered.get_json()
        logged_in = client.post(
            "/api/auth/login",
            json={"email": email, "password": password},
        )
        assert logged_in.status_code == 200, logged_in.get_json()
        token = logged_in.get_json()["token"]
        return (
            {"Authorization": "Bearer " + token},
            registered.get_json()["id"],
            token,
        )

    return _do
