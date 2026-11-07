from __future__ import annotations

import pytest


BASE_ENV = {
    "DOCS_BUCKET": "test-docs-bucket",
    "DDB_TABLE": "documents",
    "DB_HOST": "127.0.0.1",
    "DB_PORT": "3306",
    "DB_NAME": "docuprocess",
    "DB_USER": "docuadmin",
    "DB_PASSWORD": "test-password",
    "JWT_SECRET": "x" * 32,
    "AWS_REGION": "us-east-1",
}


def env_without(name: str):
    env = dict(BASE_ENV)
    env.pop(name, None)
    return env


def test_falla_si_falta_una_obligatoria(api_module):
    with pytest.raises(RuntimeError, match="DB_HOST"):
        api_module.load_config(env_without("DB_HOST"))


def test_falla_si_docs_bucket_esta_vacio(api_module):
    env = dict(BASE_ENV)
    env["DOCS_BUCKET"] = "   "
    with pytest.raises(RuntimeError, match="DOCS_BUCKET"):
        api_module.load_config(env)


def test_falla_si_jwt_secret_es_corto(api_module):
    env = dict(BASE_ENV)
    env["JWT_SECRET"] = "corto"
    with pytest.raises(RuntimeError, match="JWT_SECRET"):
        api_module.load_config(env)


def test_db_port_por_defecto(api_module):
    env = env_without("DB_PORT")
    config = api_module.load_config(env)
    assert config.db_port == 3306


def test_db_port_invalido(api_module):
    env = dict(BASE_ENV)
    env["DB_PORT"] = "no-es-puerto"
    with pytest.raises(RuntimeError, match="DB_PORT"):
        api_module.load_config(env)


def test_opcionales_y_cors(api_module):
    env = dict(BASE_ENV)
    env["DDB_ENDPOINT_URL"] = "http://localhost:8001"
    env["CORS_ALLOWED_ORIGINS"] = (
        " http://localhost:5500 , http://127.0.0.1:5500 , "
    )
    config = api_module.load_config(env)
    assert config.ddb_endpoint_url == "http://localhost:8001"
    assert config.cors_allowed_origins == (
        "http://localhost:5500",
        "http://127.0.0.1:5500",
    )


def test_endpoint_dynamodb_es_opcional(api_module):
    config = api_module.load_config(env_without("DDB_ENDPOINT_URL"))
    assert config.ddb_endpoint_url is None
