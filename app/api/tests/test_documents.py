from __future__ import annotations

import uuid

from botocore.exceptions import ClientError


def _create(client, headers, **overrides):
    payload = {
        "filename": "demo.pdf",
        "contentType": "application/pdf",
        "size": 12345,
    }
    payload.update(overrides)
    return client.post("/api/documents", json=payload, headers=headers)


def test_crear_documento_devuelve_url_y_guarda_pending(
    client, app, api_module, register_and_login
):
    headers, user_id, _token = register_and_login()

    response = _create(client, headers)

    assert response.status_code == 201
    body = response.get_json()
    document_id = body["documentId"]
    assert uuid.UUID(document_id).version == 4
    assert body["method"] == "PUT"
    assert body["headers"] == {"Content-Type": "application/pdf"}
    assert body["expiresIn"] == 900
    assert body["key"] == "uploads/{}/{}/demo.pdf".format(user_id, document_id)
    assert "X-Amz-Signature" in body["uploadUrl"]
    assert "content-type" in body["uploadUrl"].lower()
    assert document_id in body["uploadUrl"]

    ddb = api_module.get_ddb(app)
    item = ddb.get_item(
        TableName="documents",
        Key={"documentId": {"S": document_id}},
    )["Item"]
    assert item["status"]["S"] == "PENDING"
    assert item["userId"]["S"] == str(user_id)
    assert item["filename"]["S"] == "demo.pdf"
    assert item["contentType"]["S"] == "application/pdf"
    assert item["s3Key"]["S"] == body["key"]
    assert item["createdAt"]["S"] == item["updatedAt"]["S"]
    assert item["createdAt"]["S"].endswith("Z")


def test_crear_documento_tipo_no_permitido_400(
    client, register_and_login
):
    headers, _user_id, _token = register_and_login()

    response = _create(client, headers, contentType="application/zip")

    assert response.status_code == 400
    assert response.get_json()["error"] == "invalid_file_type"


def test_crear_documento_tamano_invalido_400(client, register_and_login):
    headers, _user_id, _token = register_and_login()

    too_big = _create(client, headers, size=10 * 1024 * 1024 + 1)
    zero = _create(client, headers, size=0)
    boolean = _create(client, headers, size=True)
    text = _create(client, headers, size="123")

    assert too_big.status_code == 400
    assert zero.status_code == 400
    assert boolean.status_code == 400
    assert text.status_code == 400
    assert too_big.get_json()["error"] == "invalid_file_size"


def test_crear_documento_tamano_maximo_permitido(
    client, register_and_login
):
    headers, _user_id, _token = register_and_login()

    response = _create(client, headers, size=10 * 1024 * 1024)

    assert response.status_code == 201


def test_crear_documento_sanea_el_nombre(client, register_and_login):
    headers, _user_id, _token = register_and_login()

    traversal = _create(client, headers, filename="../../etc/passwd")
    backslashes = _create(client, headers, filename="..\\..\\x.txt")
    long_name = _create(client, headers, filename="a" * 250 + ".pdf")
    empty = _create(client, headers, filename="..")

    assert traversal.status_code == 201
    assert traversal.get_json()["key"].endswith("/passwd")
    assert ".." not in traversal.get_json()["key"]

    assert backslashes.status_code == 201
    assert backslashes.get_json()["key"].endswith("/x.txt")

    assert long_name.status_code == 201
    last_segment = long_name.get_json()["key"].rsplit("/", 1)[-1]
    assert len(last_segment) == 200
    assert last_segment.endswith(".pdf")

    assert empty.status_code == 400
    assert empty.get_json()["error"] == "invalid_filename"


def test_crear_documento_campos_faltantes_400(client, register_and_login):
    headers, _user_id, _token = register_and_login()

    assert (
        client.post("/api/documents", json={}, headers=headers).status_code
        == 400
    )
    assert (
        client.post(
            "/api/documents",
            json={"contentType": "application/pdf", "size": 10},
            headers=headers,
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/api/documents",
            json={"filename": "a.pdf", "size": 10},
            headers=headers,
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/api/documents",
            json={"filename": "a.pdf", "contentType": "application/pdf"},
            headers=headers,
        ).status_code
        == 400
    )


def test_tipos_permitidos(client, register_and_login):
    headers, _user_id, _token = register_and_login()

    for content_type in (
        "application/pdf",
        "image/png",
        "image/jpeg",
        "text/plain",
    ):
        response = _create(client, headers, contentType=content_type)
        assert response.status_code == 201
        assert response.get_json()["headers"]["Content-Type"] == content_type


def test_lista_solo_los_documentos_del_usuario(
    client, register_and_login
):
    headers_a, _user_a, _token_a = register_and_login("a@example.com")
    headers_b, _user_b, _token_b = register_and_login("b@example.com")

    doc_a = _create(client, headers_a, filename="a.pdf").get_json()["documentId"]
    doc_b = _create(client, headers_b, filename="b.pdf").get_json()["documentId"]

    response_a = client.get("/api/documents", headers=headers_a)
    response_b = client.get("/api/documents", headers=headers_b)

    assert response_a.status_code == 200
    assert [item["documentId"] for item in response_a.get_json()["items"]] == [
        doc_a
    ]
    assert response_b.status_code == 200
    assert [item["documentId"] for item in response_b.get_json()["items"]] == [
        doc_b
    ]


def test_lista_ordena_descendente_y_limita_a_50(
    client, app, api_module, register_and_login
):
    headers, user_id, _token = register_and_login()
    ddb = api_module.get_ddb(app)

    for index in range(55):
        document_id = str(uuid.uuid4())
        item = {
            "documentId": document_id,
            "userId": str(user_id),
            "filename": "doc-{}.pdf".format(index),
            "contentType": "application/pdf",
            "s3Key": "uploads/{}/{}/doc-{}.pdf".format(
                user_id, document_id, index
            ),
            "status": "PENDING",
            "createdAt": "2026-01-01T00:00:{:02d}.000Z".format(index),
            "updatedAt": "2026-01-01T00:00:{:02d}.000Z".format(index),
        }
        ddb.put_item(TableName="documents", Item=api_module.to_ddb_item(item))

    response = client.get("/api/documents", headers=headers)

    assert response.status_code == 200
    items = response.get_json()["items"]
    assert len(items) == 50
    assert items[0]["createdAt"] == "2026-01-01T00:00:54.000Z"
    assert items[-1]["createdAt"] == "2026-01-01T00:00:05.000Z"


def test_detalle_propio_200_y_ajeno_404(client, register_and_login):
    headers_a, _user_a, _token_a = register_and_login("a@example.com")
    headers_b, _user_b, _token_b = register_and_login("b@example.com")

    document_id = _create(client, headers_a).get_json()["documentId"]

    own = client.get("/api/documents/" + document_id, headers=headers_a)
    other = client.get("/api/documents/" + document_id, headers=headers_b)
    missing = client.get(
        "/api/documents/" + str(uuid.uuid4()), headers=headers_a
    )
    malformed = client.get("/api/documents/no-es-uuid", headers=headers_a)

    assert own.status_code == 200
    assert own.get_json()["documentId"] == document_id
    assert own.get_json()["status"] == "PENDING"

    for response in (other, missing, malformed):
        assert response.status_code == 404
        assert response.get_json()["error"] == "not_found"


def test_detalle_serializa_decimales_del_worker(
    client, app, api_module, register_and_login
):
    headers, user_id, _token = register_and_login()
    created = _create(client, headers).get_json()
    document_id = created["documentId"]

    item = {
        "documentId": document_id,
        "userId": str(user_id),
        "filename": "demo.pdf",
        "contentType": "application/pdf",
        "s3Key": created["key"],
        "status": "DONE",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:01.000Z",
        "result": {
            "sizeBytes": 123,
            "mimeType": "application/pdf",
            "sha256": "abc123",
            "pages": 2,
            "width": 10,
            "height": 20,
        },
    }
    api_module.get_ddb(app).put_item(
        TableName="documents", Item=api_module.to_ddb_item(item)
    )

    response = client.get("/api/documents/" + document_id, headers=headers)

    assert response.status_code == 200
    result = response.get_json()["result"]
    assert result == {
        "sizeBytes": 123,
        "mimeType": "application/pdf",
        "sha256": "abc123",
        "pages": 2,
        "width": 10,
        "height": 20,
    }


def test_error_de_dynamodb_al_crear_503(
    client, api_module, register_and_login, monkeypatch
):
    headers, _user_id, _token = register_and_login()

    class BrokenDdb:
        def put_item(self, **_kwargs):
            raise ClientError(
                {"Error": {"Code": "ResourceNotFoundException", "Message": "no"}},
                "PutItem",
            )

    monkeypatch.setattr(api_module, "get_ddb", lambda app=None: BrokenDdb())

    response = _create(client, headers)

    assert response.status_code == 503
    assert response.get_json()["error"] == "storage_unavailable"
