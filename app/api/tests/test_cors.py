from __future__ import annotations

ALLOWED_ORIGIN = "http://localhost:5500"
DISALLOWED_ORIGIN = "http://evil.example.com"


def test_health_devuelve_cors_para_origen_permitido(client):
    response = client.get("/api/health", headers={"Origin": ALLOWED_ORIGIN})

    assert response.status_code == 200
    assert (
        response.headers.get("Access-Control-Allow-Origin") == ALLOWED_ORIGIN
    )
    assert "Origin" in response.headers.get("Vary", "")


def test_health_no_devuelve_cors_para_origen_no_permitido(client):
    response = client.get("/api/health", headers={"Origin": DISALLOWED_ORIGIN})

    assert response.headers.get("Access-Control-Allow-Origin") is None


def test_preflight_de_documentos(client):
    response = client.options(
        "/api/documents",
        headers={
            "Origin": ALLOWED_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Authorization, Content-Type",
        },
    )

    assert response.status_code == 200
    assert (
        response.headers.get("Access-Control-Allow-Origin") == ALLOWED_ORIGIN
    )
    assert "Authorization" in response.headers.get(
        "Access-Control-Allow-Headers", ""
    )
    assert "POST" in response.headers.get("Access-Control-Allow-Methods", "")


def test_401_tambien_lleva_cors(client):
    response = client.get(
        "/api/documents", headers={"Origin": ALLOWED_ORIGIN}
    )

    assert response.status_code == 401
    assert (
        response.headers.get("Access-Control-Allow-Origin") == ALLOWED_ORIGIN
    )
