"""API REST de DocuProcess Cloud (tarea A6).

Autenticación con MySQL + bcrypt + JWT y gestión de documentos con DynamoDB
y URLs prefirmadas de S3. Toda la configuración se lee de variables de
entorno; no hay secretos en el código.

Producción (desde ``app/api``, con el venv de A4)::

    gunicorn --workers 2 --bind 0.0.0.0:8000 \\
        --access-logfile - --error-logfile - app:app
"""

from __future__ import annotations

import logging
import os
import re
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal
from functools import wraps
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

import bcrypt
import boto3
import jwt
import pymysql
from boto3.dynamodb.types import TypeDeserializer, TypeSerializer
from botocore.config import Config as BotoConfig
from botocore.exceptions import BotoCoreError, ClientError
from flask import Flask, Response, current_app, g, jsonify, request
from flask.json.provider import DefaultJSONProvider
from pymysql.cursors import DictCursor
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge

# ---------------------------------------------------------------------------
# Constantes del contrato C1
# ---------------------------------------------------------------------------

REQUIRED_ENV = (
    "DOCS_BUCKET",
    "DDB_TABLE",
    "DB_HOST",
    "DB_NAME",
    "DB_USER",
    "DB_PASSWORD",
    "JWT_SECRET",
    "AWS_REGION",
)

ALLOWED_CONTENT_TYPES = frozenset(
    {
        "application/pdf",
        "image/png",
        "image/jpeg",
        "text/plain",
    }
)

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
API_MAX_BODY_BYTES = 64 * 1024
JWT_TTL_SECONDS = 3600
PRESIGN_EXPIRES_SECONDS = 900
DOCUMENT_LIST_LIMIT = 50
BCRYPT_ROUNDS = 12
GSI_NAME = "userId-createdAt"
S3_UPLOAD_PREFIX = "uploads"

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")

_LOGGING_CONFIGURED = False
_DESERIALIZER = TypeDeserializer()
_SERIALIZER = TypeSerializer()


# ---------------------------------------------------------------------------
# Configuración
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Config:
    docs_bucket: str
    ddb_table: str
    db_host: str
    db_port: int
    db_name: str
    db_user: str
    db_password: str
    jwt_secret: str
    aws_region: str
    ddb_endpoint_url: Optional[str]
    cors_allowed_origins: Tuple[str, ...]


@dataclass
class Runtime:
    config: Config
    schema_ready: bool = False
    schema_lock: threading.Lock = field(default_factory=threading.Lock)
    ddb_client: Any = None
    s3_client: Any = None
    client_lock: threading.Lock = field(default_factory=threading.Lock)


def load_config(environ: Optional[Mapping[str, str]] = None) -> Config:
    """Lee y valida las variables del contrato C1.

    Falla al arrancar si falta una obligatoria. No imprime valores para no
    filtrar secretos en los logs de systemd/journald.
    """

    source = os.environ if environ is None else environ
    values: Dict[str, str] = {}
    missing: List[str] = []

    for name in REQUIRED_ENV:
        raw = source.get(name)
        if raw is None or str(raw).strip() == "":
            missing.append(name)
        else:
            values[name] = str(raw)

    if missing:
        raise RuntimeError(
            "Faltan variables de entorno obligatorias: " + ", ".join(sorted(missing))
        )

    secret = values["JWT_SECRET"]
    if len(secret) < 32:
        raise RuntimeError("JWT_SECRET debe tener al menos 32 caracteres")

    port_raw = (source.get("DB_PORT") or "3306").strip()
    try:
        db_port = int(port_raw)
    except ValueError as exc:
        raise RuntimeError("DB_PORT debe ser un numero entero") from exc
    if not 1 <= db_port <= 65535:
        raise RuntimeError("DB_PORT debe estar entre 1 y 65535")

    endpoint = (source.get("DDB_ENDPOINT_URL") or "").strip() or None
    cors_raw = source.get("CORS_ALLOWED_ORIGINS") or ""
    cors_origins = tuple(
        origin.strip() for origin in cors_raw.split(",") if origin.strip()
    )

    return Config(
        docs_bucket=values["DOCS_BUCKET"].strip(),
        ddb_table=values["DDB_TABLE"].strip(),
        db_host=values["DB_HOST"].strip(),
        db_port=db_port,
        db_name=values["DB_NAME"].strip(),
        db_user=values["DB_USER"].strip(),
        db_password=values["DB_PASSWORD"],
        jwt_secret=secret,
        aws_region=values["AWS_REGION"].strip(),
        ddb_endpoint_url=endpoint,
        cors_allowed_origins=cors_origins,
    )


def get_runtime(app: Optional[Flask] = None) -> Runtime:
    if app is None:
        app = current_app._get_current_object()
    return app.extensions["docuprocess_runtime"]


def get_config(app: Optional[Flask] = None) -> Config:
    return get_runtime(app).config


# ---------------------------------------------------------------------------
# Serialización JSON (DynamoDB devuelve Decimal)
# ---------------------------------------------------------------------------


def _json_default(value: Any) -> Any:
    if isinstance(value, Decimal):
        if value == value.to_integral_value():
            return int(value)
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    raise TypeError(f"Tipo no serializable: {type(value)!r}")


class ApiJSONProvider(DefaultJSONProvider):
    default = staticmethod(_json_default)


def normalize_value(value: Any) -> Any:
    """Convierte Decimal (y estructuras anidadas) a tipos JSON."""

    if isinstance(value, Decimal):
        return _json_default(value)
    if isinstance(value, dict):
        return {key: normalize_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [normalize_value(item) for item in value]
    return value


def to_ddb_item(item: Mapping[str, Any]) -> Dict[str, Any]:
    return {key: _SERIALIZER.serialize(value) for key, value in item.items()}


def from_ddb_item(item: Mapping[str, Any]) -> Dict[str, Any]:
    return {key: _DESERIALIZER.deserialize(value) for key, value in item.items()}


# ---------------------------------------------------------------------------
# Utilidades generales
# ---------------------------------------------------------------------------


def configure_logging() -> None:
    global _LOGGING_CONFIGURED
    if _LOGGING_CONFIGURED:
        return

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    if not any(isinstance(handler, logging.StreamHandler) for handler in root.handlers):
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
        )
        root.addHandler(handler)

    for noisy in ("boto3", "botocore", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    _LOGGING_CONFIGURED = True


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_timestamp(moment: Optional[datetime] = None) -> str:
    moment = moment or utc_now()
    return (
        moment.astimezone(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def error_response(code: str, message: str, status: int) -> Response:
    response = jsonify({"error": code, "message": message})
    response.status_code = status
    if status == 401:
        response.headers["WWW-Authenticate"] = "Bearer"
    return response


def _json_body() -> Tuple[Optional[Dict[str, Any]], Optional[Response]]:
    if not request.is_json:
        return None, error_response(
            "invalid_request", "Content-Type debe ser application/json.", 400
        )
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return None, error_response(
            "invalid_request", "El cuerpo debe ser un objeto JSON.", 400
        )
    return payload, None


def validate_email(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    email = value.strip().lower()
    if not email or len(email) > 255 or not EMAIL_RE.match(email):
        return None
    return email


def validate_password(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return "La contrasena debe ser texto."
    if len(value) < 8:
        return "La contrasena debe tener al menos 8 caracteres."
    if len(value.encode("utf-8")) > 72:
        return "La contrasena no puede superar 72 bytes."
    return None


def hash_password(password: str) -> str:
    return bcrypt.hashpw(
        password.encode("utf-8"), bcrypt.gensalt(rounds=BCRYPT_ROUNDS)
    ).decode("ascii")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(
            password.encode("utf-8"), password_hash.encode("utf-8")
        )
    except (TypeError, ValueError):
        return False


def sanitize_filename(value: Any) -> Optional[str]:
    """Quita rutas, caracteres de control y limita a 200 caracteres."""

    if not isinstance(value, str):
        return None

    name = value.replace("\\", "/").rsplit("/", 1)[-1]
    name = CONTROL_CHARS_RE.sub("", name).strip().strip(".")
    if not name:
        return None

    if len(name) > 200:
        stem, dot, extension = name.rpartition(".")
        if dot and extension and len(extension) <= 20:
            keep = 200 - len(extension) - 1
            name = stem[:keep] + "." + extension
        else:
            name = name[:200]
    return name


def validate_content_type(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    content_type = value.strip().lower()
    return content_type if content_type in ALLOWED_CONTENT_TYPES else None


def validate_size(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 1 or value > MAX_UPLOAD_BYTES:
        return None
    return value


# ---------------------------------------------------------------------------
# MySQL
# ---------------------------------------------------------------------------


class EmailAlreadyExists(Exception):
    pass


def get_db_connection(app: Optional[Flask] = None) -> Any:
    cfg = get_config(app)
    return pymysql.connect(
        host=cfg.db_host,
        port=cfg.db_port,
        user=cfg.db_user,
        password=cfg.db_password,
        database=cfg.db_name,
        charset="utf8mb4",
        cursorclass=DictCursor,
        autocommit=True,
        connect_timeout=3,
        read_timeout=5,
        write_timeout=5,
    )


@contextmanager
def db_connection(app: Optional[Flask] = None):
    connection = get_db_connection(app)
    try:
        yield connection
    finally:
        connection.close()


@contextmanager
def db_cursor(app: Optional[Flask] = None):
    with db_connection(app) as connection:
        with connection.cursor() as cursor:
            yield cursor


def _schema_statements() -> List[str]:
    path = Path(__file__).with_name("schema.sql")
    raw = path.read_text(encoding="utf-8")
    lines = [
        line
        for line in raw.splitlines()
        if line.strip() and not line.strip().startswith("--")
    ]
    return [statement.strip() for statement in "\n".join(lines).split(";") if statement.strip()]


def ensure_schema(app: Optional[Flask] = None, force: bool = False) -> None:
    """Aplica schema.sql de forma idempotente."""

    if app is None:
        app = current_app._get_current_object()
    runtime = get_runtime(app)

    if runtime.schema_ready and not force:
        return

    with runtime.schema_lock:
        if runtime.schema_ready and not force:
            return
        statements = _schema_statements()
        with db_cursor(app) as cursor:
            for statement in statements:
                cursor.execute(statement)
        runtime.schema_ready = True
        app.logger.info("schema.sql aplicado; tabla users lista")


def ensure_schema_or_error(app: Flask) -> Optional[Response]:
    try:
        ensure_schema(app)
    except Exception as exc:  # MySQL apagado o sin permisos
        app.logger.error("No se pudo preparar el esquema de MySQL: %s", exc)
        return error_response(
            "database_unavailable", "Base de datos no disponible.", 503
        )
    return None


def _mark_schema_missing(exc: BaseException, app: Flask) -> None:
    if (
        isinstance(exc, pymysql.err.ProgrammingError)
        and exc.args
        and exc.args[0] == 1146
    ):
        get_runtime(app).schema_ready = False


def create_user(email: str, password_hash: str, app: Optional[Flask] = None) -> int:
    try:
        with db_cursor(app) as cursor:
            cursor.execute(
                "INSERT INTO users (email, password_hash) VALUES (%s, %s)",
                (email, password_hash),
            )
            user_id = cursor.lastrowid
        return int(user_id)
    except pymysql.err.IntegrityError as exc:
        if exc.args and exc.args[0] == 1062:
            raise EmailAlreadyExists("email duplicado") from exc
        raise


def get_user_by_email(email: str, app: Optional[Flask] = None) -> Optional[Dict[str, Any]]:
    with db_cursor(app) as cursor:
        cursor.execute(
            "SELECT id, email, password_hash FROM users WHERE email = %s",
            (email,),
        )
        return cursor.fetchone()


# ---------------------------------------------------------------------------
# AWS
# ---------------------------------------------------------------------------


def get_ddb(app: Optional[Flask] = None) -> Any:
    app = app or current_app._get_current_object()
    runtime = get_runtime(app)
    if runtime.ddb_client is None:
        with runtime.client_lock:
            if runtime.ddb_client is None:
                kwargs: Dict[str, Any] = {
                    "region_name": runtime.config.aws_region,
                    "config": BotoConfig(
                        connect_timeout=2,
                        read_timeout=5,
                        retries={"max_attempts": 2, "mode": "standard"},
                    ),
                }
                if runtime.config.ddb_endpoint_url:
                    kwargs["endpoint_url"] = runtime.config.ddb_endpoint_url
                runtime.ddb_client = boto3.client("dynamodb", **kwargs)
    return runtime.ddb_client


def get_s3(app: Optional[Flask] = None) -> Any:
    app = app or current_app._get_current_object()
    runtime = get_runtime(app)
    if runtime.s3_client is None:
        with runtime.client_lock:
            if runtime.s3_client is None:
                runtime.s3_client = boto3.client(
                    "s3",
                    region_name=runtime.config.aws_region,
                    config=BotoConfig(
                        connect_timeout=2,
                        read_timeout=5,
                        retries={"max_attempts": 2, "mode": "standard"},
                        signature_version="s3v4",
                    ),
                )
    return runtime.s3_client


# ---------------------------------------------------------------------------
# Autenticación
# ---------------------------------------------------------------------------


def require_auth(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        app = current_app._get_current_object()
        cfg = get_config(app)
        header = request.headers.get("Authorization", "")
        parts = header.split(None, 1)

        if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
            return error_response("unauthorized", "Falta el token Bearer.", 401)

        token = parts[1].strip()
        try:
            payload = jwt.decode(
                token,
                cfg.jwt_secret,
                algorithms=["HS256"],
                options={"require": ["exp", "iat", "sub"]},
            )
        except jwt.ExpiredSignatureError:
            return error_response("unauthorized", "El token vencio.", 401)
        except jwt.InvalidTokenError:
            return error_response("unauthorized", "Token invalido.", 401)

        subject = payload.get("sub")
        if not isinstance(subject, str) or not subject:
            return error_response("unauthorized", "Token invalido.", 401)

        g.user_id = subject
        email = payload.get("email")
        g.user_email = email if isinstance(email, str) else ""
        return view(*args, **kwargs)

    return wrapped


# ---------------------------------------------------------------------------
# Rutas
# ---------------------------------------------------------------------------


def health():
    app = current_app._get_current_object()
    if request.args.get("deep") not in ("1", "true", "yes"):
        return jsonify({"status": "ok"}), 200

    cfg = get_config(app)
    checks: Dict[str, str] = {}
    healthy = True

    try:
        with db_cursor(app) as cursor:
            cursor.execute("SELECT 1 AS ok")
            cursor.fetchone()
        checks["mysql"] = "ok"
    except Exception as exc:
        checks["mysql"] = "error"
        healthy = False
        app.logger.warning("health deep: MySQL no responde: %s", exc)

    try:
        get_ddb(app).get_item(
            TableName=cfg.ddb_table,
            Key={"documentId": {"S": "health-check"}},
        )
        checks["dynamodb"] = "ok"
    except Exception as exc:
        checks["dynamodb"] = "error"
        healthy = False
        app.logger.warning("health deep: DynamoDB no responde: %s", exc)

    if healthy:
        return jsonify({"status": "ok", "checks": checks}), 200
    return (
        jsonify(
            {
                "error": "unhealthy",
                "message": "Una o mas dependencias no responden.",
                "checks": checks,
            }
        ),
        503,
    )


def register():
    app = current_app._get_current_object()
    payload, error = _json_body()
    if error:
        return error

    email = validate_email(payload.get("email"))
    if email is None:
        return error_response("invalid_email", "El correo no es valido.", 400)

    password = payload.get("password")
    password_error = validate_password(password)
    if password_error:
        return error_response("weak_password", password_error, 400)

    schema_error = ensure_schema_or_error(app)
    if schema_error:
        return schema_error

    password_hash = hash_password(password)
    try:
        user_id = create_user(email, password_hash, app)
    except EmailAlreadyExists:
        return error_response(
            "email_exists", "Ya existe una cuenta con ese correo.", 409
        )
    except pymysql.MySQLError as exc:
        _mark_schema_missing(exc, app)
        app.logger.error("Error de MySQL en register: %s", exc)
        return error_response(
            "database_unavailable", "Base de datos no disponible.", 503
        )

    return jsonify({"id": user_id, "email": email}), 201


def login():
    app = current_app._get_current_object()
    cfg = get_config(app)
    payload, error = _json_body()
    if error:
        return error

    email = validate_email(payload.get("email"))
    password = payload.get("password")
    if (
        email is None
        or not isinstance(password, str)
        or len(password.encode("utf-8")) > 72
    ):
        return error_response(
            "invalid_credentials", "Correo o contrasena incorrectos.", 401
        )

    schema_error = ensure_schema_or_error(app)
    if schema_error:
        return schema_error

    try:
        user = get_user_by_email(email, app)
    except pymysql.MySQLError as exc:
        _mark_schema_missing(exc, app)
        app.logger.error("Error de MySQL en login: %s", exc)
        return error_response(
            "database_unavailable", "Base de datos no disponible.", 503
        )

    if not user or not verify_password(password, str(user["password_hash"])):
        return error_response(
            "invalid_credentials", "Correo o contrasena incorrectos.", 401
        )

    now = int(time.time())
    token = jwt.encode(
        {
            "sub": str(user["id"]),
            "email": str(user["email"]),
            "iat": now,
            "exp": now + JWT_TTL_SECONDS,
        },
        cfg.jwt_secret,
        algorithm="HS256",
    )
    return jsonify({"token": token, "expiresIn": JWT_TTL_SECONDS}), 200


@require_auth
def create_document():
    app = current_app._get_current_object()
    cfg = get_config(app)
    payload, error = _json_body()
    if error:
        return error

    filename = sanitize_filename(payload.get("filename"))
    if filename is None:
        return error_response("invalid_filename", "El nombre del archivo no es valido.", 400)

    content_type = validate_content_type(payload.get("contentType"))
    if content_type is None:
        return error_response(
            "invalid_file_type",
            "Tipo no permitido. Usa PDF, PNG, JPG o TXT.",
            400,
        )

    size = validate_size(payload.get("size"))
    if size is None:
        return error_response(
            "invalid_file_size",
            "El archivo debe pesar entre 1 byte y 10 MB.",
            400,
        )

    document_id = str(uuid.uuid4())
    key = "{}/{}/{}/{}".format(
        S3_UPLOAD_PREFIX, g.user_id, document_id, filename
    )
    timestamp = iso_timestamp()
    item = {
        "documentId": document_id,
        "userId": g.user_id,
        "filename": filename,
        "contentType": content_type,
        "s3Key": key,
        "status": "PENDING",
        "createdAt": timestamp,
        "updatedAt": timestamp,
    }

    try:
        upload_url = get_s3(app).generate_presigned_url(
            "put_object",
            Params={
                "Bucket": cfg.docs_bucket,
                "Key": key,
                "ContentType": content_type,
            },
            ExpiresIn=PRESIGN_EXPIRES_SECONDS,
        )
        get_ddb(app).put_item(
            TableName=cfg.ddb_table,
            Item=to_ddb_item(item),
        )
    except (BotoCoreError, ClientError) as exc:
        app.logger.error("No se pudo preparar el documento en AWS: %s", exc)
        return error_response(
            "storage_unavailable", "No se pudo preparar la subida.", 503
        )

    return (
        jsonify(
            {
                "documentId": document_id,
                "uploadUrl": upload_url,
                "method": "PUT",
                "headers": {"Content-Type": content_type},
                "key": key,
                "expiresIn": PRESIGN_EXPIRES_SECONDS,
            }
        ),
        201,
    )


@require_auth
def list_documents():
    app = current_app._get_current_object()
    cfg = get_config(app)

    try:
        response = get_ddb(app).query(
            TableName=cfg.ddb_table,
            IndexName=GSI_NAME,
            KeyConditionExpression="#userId = :userId",
            ExpressionAttributeNames={"#userId": "userId"},
            ExpressionAttributeValues={":userId": {"S": g.user_id}},
            ScanIndexForward=False,
            Limit=DOCUMENT_LIST_LIMIT,
        )
    except (BotoCoreError, ClientError) as exc:
        app.logger.error("No se pudo listar documentos: %s", exc)
        return error_response(
            "storage_unavailable", "No se pudo consultar los documentos.", 503
        )

    items = [
        normalize_value(from_ddb_item(item)) for item in response.get("Items", [])
    ]
    return jsonify({"items": items}), 200


@require_auth
def get_document(document_id: str):
    app = current_app._get_current_object()
    cfg = get_config(app)

    try:
        uuid.UUID(document_id)
    except (AttributeError, TypeError, ValueError):
        return error_response("not_found", "Documento no encontrado.", 404)

    try:
        response = get_ddb(app).get_item(
            TableName=cfg.ddb_table,
            Key={"documentId": {"S": document_id}},
            ConsistentRead=True,
        )
    except (BotoCoreError, ClientError) as exc:
        app.logger.error("No se pudo leer el documento: %s", exc)
        return error_response(
            "storage_unavailable", "No se pudo consultar el documento.", 503
        )

    raw_item = response.get("Item")
    if not raw_item:
        return error_response("not_found", "Documento no encontrado.", 404)

    item = from_ddb_item(raw_item)
    if str(item.get("userId")) != g.user_id:
        return error_response("not_found", "Documento no encontrado.", 404)

    return jsonify(normalize_value(item)), 200


# ---------------------------------------------------------------------------
# Registro de la aplicación
# ---------------------------------------------------------------------------


def register_hooks(application: Flask) -> None:
    @application.before_request
    def _start_timer() -> None:
        g.request_started_at = time.monotonic()

    @application.after_request
    def _finish(response: Response) -> Response:
        started = getattr(g, "request_started_at", None)
        if started is not None:
            elapsed_ms = (time.monotonic() - started) * 1000
            application.logger.info(
                "%s %s -> %s (%.1f ms)",
                request.method,
                request.path,
                response.status_code,
                elapsed_ms,
            )

        origin = request.headers.get("Origin")
        if origin and origin in get_config(application).cors_allowed_origins:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = (
                "Authorization, Content-Type"
            )
            response.headers["Access-Control-Max-Age"] = "600"
            response.headers.add("Vary", "Origin")
        return response


def _http_error_details(status: int, exc: HTTPException) -> Tuple[str, str]:
    mapping = {
        400: ("invalid_request", "Solicitud invalida."),
        401: ("unauthorized", "No autorizado."),
        404: ("not_found", "Recurso no encontrado."),
        405: ("method_not_allowed", "Metodo no permitido."),
        413: ("payload_too_large", "El cuerpo de la solicitud es demasiado grande."),
        415: ("unsupported_media_type", "Content-Type no soportado."),
    }
    if status in mapping:
        return mapping[status]
    return ("http_error", exc.description or "Error HTTP.")


def register_error_handlers(application: Flask) -> None:
    @application.errorhandler(RequestEntityTooLarge)
    def _too_large(_exc: RequestEntityTooLarge):
        return error_response(
            "payload_too_large",
            "El cuerpo de la solicitud es demasiado grande.",
            413,
        )

    @application.errorhandler(HTTPException)
    def _http_error(exc: HTTPException):
        status = exc.code or 500
        code, message = _http_error_details(status, exc)
        return error_response(code, message, status)

    @application.errorhandler(Exception)
    def _unexpected(exc: Exception):
        application.logger.exception("Error no controlado: %s", exc)
        return error_response("internal_error", "Error interno del servidor.", 500)


def register_routes(application: Flask) -> None:
    application.add_url_rule("/api/health", "health", health, methods=["GET"])
    application.add_url_rule(
        "/api/auth/register", "register", register, methods=["POST"]
    )
    application.add_url_rule("/api/auth/login", "login", login, methods=["POST"])
    application.add_url_rule(
        "/api/documents", "create_document", create_document, methods=["POST"]
    )
    application.add_url_rule(
        "/api/documents", "list_documents", list_documents, methods=["GET"]
    )
    application.add_url_rule(
        "/api/documents/<document_id>",
        "get_document",
        get_document,
        methods=["GET"],
    )


def create_app(config: Optional[Config] = None) -> Flask:
    cfg = config or load_config()
    application = Flask(__name__, static_folder=None)
    application.json = ApiJSONProvider(application)
    application.json.ensure_ascii = False
    application.json.sort_keys = False
    application.config.update(
        MAX_CONTENT_LENGTH=API_MAX_BODY_BYTES,
        PROPAGATE_EXCEPTIONS=False,
        TESTING=False,
    )
    application.extensions["docuprocess_runtime"] = Runtime(config=cfg)

    configure_logging()
    register_hooks(application)
    register_error_handlers(application)
    register_routes(application)

    # El health check debe responder aunque MySQL este apagado: se intenta
    # aplicar el esquema, pero un fallo no impide arrancar. Se reintenta en
    # el primer registro/login.
    try:
        ensure_schema(application)
    except Exception as exc:
        application.logger.warning(
            "No se pudo aplicar schema.sql al arrancar: %s", exc
        )

    return application


app = create_app()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000)
