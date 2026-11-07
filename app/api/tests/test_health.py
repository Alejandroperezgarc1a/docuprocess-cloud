from __future__ import annotations

from botocore.exceptions import ClientError


def test_health_no_toca_mysql(api_module, client, monkeypatch):
    def mysql_caido(app=None):
        raise RuntimeError("MySQL apagado")

    monkeypatch.setattr(api_module, "get_db_connection", mysql_caido)

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.get_json() == {"status": "ok"}


def test_health_deep_ok(client):
    response = client.get("/api/health?deep=1")

    assert response.status_code == 200
    assert response.get_json() == {
        "status": "ok",
        "checks": {"mysql": "ok", "dynamodb": "ok"},
    }


def test_health_deep_mysql_caido(api_module, client, monkeypatch):
    def mysql_caido(app=None):
        raise RuntimeError("MySQL apagado")

    monkeypatch.setattr(api_module, "get_db_connection", mysql_caido)

    response = client.get("/api/health?deep=1")

    assert response.status_code == 503
    body = response.get_json()
    assert body["error"] == "unhealthy"
    assert body["checks"] == {"mysql": "error", "dynamodb": "ok"}


def test_health_deep_dynamodb_caido(api_module, client, monkeypatch):
    def dynamodb_caido(app=None):
        raise ClientError(
            {"Error": {"Code": "ResourceNotFoundException", "Message": "no"}},
            "GetItem",
        )

    monkeypatch.setattr(api_module, "get_ddb", dynamodb_caido)

    response = client.get("/api/health?deep=1")

    assert response.status_code == 503
    assert response.get_json()["checks"] == {
        "mysql": "ok",
        "dynamodb": "error",
    }
