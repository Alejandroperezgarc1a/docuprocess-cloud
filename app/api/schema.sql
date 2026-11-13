-- Tabla de usuarios de DocuProcess Cloud.
-- La API aplica este archivo al arrancar de forma idempotente.

CREATE TABLE IF NOT EXISTS users (
    id INT NOT NULL AUTO_INCREMENT,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(16) NOT NULL DEFAULT 'user',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tokens revocados (logout real): el JWT sigue siendo HS256 pero se comprueba su
-- jti contra esta tabla antes de aceptar el request. Las filas se podan solas:
-- expires_at es el exp del token, asi que una fila sin valor de seguridad queda
-- muerta cuando el token dejaria de ser valido de todas formas.
CREATE TABLE IF NOT EXISTS revoked_tokens (
    jti VARCHAR(64) NOT NULL,
    user_id INT NOT NULL,
    expires_at BIGINT NOT NULL,
    revoked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (jti),
    KEY idx_revoked_expires (expires_at),
    FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
