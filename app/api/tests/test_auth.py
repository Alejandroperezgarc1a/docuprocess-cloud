from __future__ import annotations

import time

import jwt
import pytest


def test_registro_guarda_hash_y_devuelve_201(client, app, api_module):
    response = client.post(
        "/api/auth/register",
        json={"email": "User@Example.COM", "password": "password123"},
    )

    assert response.status_code == 201
    body = response.get_json()
    assert body["email"] == "user@example.com"
    assert isinstance(body["id"], int)

    user = api_module.get_user_by_email("user@example.com", app)
    assert user is not None
    assert user["password_hash"] != "password123"
    assert user["password_hash"].startswith("$2")
    assert api_module.verify_password("password123", user["password_hash"])


def test_registro_email_duplicado_409(client):
    payload = {"email": "dup@example.com", "password": "password123"}

    assert client.post("/api/auth/register", json=payload).status_code == 201
    response = client.post("/api/auth/register", json=payload)

    assert response.status_code == 409
    assert response.get_json()["error"] == "email_exists"


def test_registro_email_invalido_400(client):
    response = client.post(
        "/api/auth/register",
        json={"email": "no-es-correo", "password": "password123"},
    )

    assert response.status_code == 400
    assert response.get_json()["error"] == "invalid_email"


def test_registro_password_corta_400(client):
    response = client.post(
        "/api/auth/register",
        json={"email": "corta@example.com", "password": "1234567"},
    )

    assert response.status_code == 400
    assert response.get_json()["error"] == "weak_password"


def test_registro_password_mayor_a_72_bytes_400(client):
    response = client.post(
        "/api/auth/register",
        json={"email": "larga@example.com", "password": "a" * 73},
    )

    assert response.status_code == 400
    assert response.get_json()["error"] == "weak_password"


def test_registro_json_invalido_400(client):
    response = client.post(
        "/api/auth/register",
        data="{",
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.get_json()["error"] == "invalid_request"


def test_registro_sin_content_type_json_400(client):
    response = client.post(
        "/api/auth/register",
        data='{"email":"x@example.com","password":"password123"}',
        content_type="text/plain",
    )

    assert response.status_code == 400
    assert response.get_json()["error"] == "invalid_request"


def test_login_correcto_devuelve_token_y_claims(client, app, api_module):
    client.post(
        "/api/auth/register",
        json={"email": "login@example.com", "password": "password123"},
    )

    response = client.post(
        "/api/auth/login",
        json={"email": "login@example.com", "password": "password123"},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["expiresIn"] == 3600
    assert isinstance(body["token"], str)

    secret = api_module.get_config(app).jwt_secret
    payload = jwt.decode(body["token"], secret, algorithms=["HS256"])
    assert payload["email"] == "login@example.com"
    assert isinstance(payload["sub"], str)
    assert payload["exp"] - payload["iat"] == 3600


def test_login_password_incorrecta_401(client):
    client.post(
        "/api/auth/register",
        json={"email": "wrong@example.com", "password": "password123"},
    )

    response = client.post(
        "/api/auth/login",
        json={"email": "wrong@example.com", "password": "otra-clave"},
    )

    assert response.status_code == 401
    assert response.get_json()["error"] == "invalid_credentials"


def test_login_usuario_inexistente_401(client):
    response = client.post(
        "/api/auth/login",
        json={"email": "nadie@example.com", "password": "password123"},
    )

    assert response.status_code == 401
    assert response.get_json()["error"] == "invalid_credentials"


def test_token_ausente_401(client):
    response = client.get("/api/documents")

    assert response.status_code == 401
    assert response.get_json()["error"] == "unauthorized"


def test_token_invalido_401(client):
    response = client.get(
        "/api/documents", headers={"Authorization": "Bearer no-es-un-jwt"}
    )

    assert response.status_code == 401
    assert response.get_json()["error"] == "unauthorized"


def test_token_con_firma_incorrecta_401(client):
    now = int(time.time())
    token = jwt.encode(
        {
            "sub": "1",
            "email": "x@example.com",
            "iat": now,
            "exp": now + 3600,
        },
        "y" * 32,
        algorithm="HS256",
    )

    response = client.get(
        "/api/documents", headers={"Authorization": "Bearer " + token}
    )

    assert response.status_code == 401


def test_token_vencido_401(client, app, api_module):
    now = int(time.time())
    secret = api_module.get_config(app).jwt_secret
    token = jwt.encode(
        {
            "sub": "1",
            "email": "x@example.com",
            "iat": now - 7200,
            "exp": now - 3600,
        },
        secret,
        algorithm="HS256",
    )

    response = client.get(
        "/api/documents", headers={"Authorization": "Bearer " + token}
    )

    assert response.status_code == 401
    assert response.get_json()["error"] == "unauthorized"


def test_token_sin_sub_401(client, app, api_module):
    now = int(time.time())
    secret = api_module.get_config(app).jwt_secret
    token = jwt.encode(
        {
            "email": "x@example.com",
            "iat": now,
            "exp": now + 3600,
        },
        secret,
        algorithm="HS256",
    )

    response = client.get(
        "/api/documents", headers={"Authorization": "Bearer " + token}
    )

    assert response.status_code == 401


@pytest.mark.parametrize(
    "header",
    ["", "Bearer", "Token abc", "Bearer   "],
)
def test_header_authorization_invalido_401(client, header):
    response = client.get("/api/documents", headers={"Authorization": header})

    assert response.status_code == 401
