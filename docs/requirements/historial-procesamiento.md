## Visualización del historial de procesamiento

### API REST (backend)

**Endpoints documentados en Swagger (`/api/docs`):**
- `GET /api/documents` — lista documentos del usuario autenticado
- `GET /api/documents/:id` — detalle de un documento
- `GET /api/documents/:id/events` — **bitácora de eventos** (PENDING → PROCESSING → DONE con fechas y actor)

**Qué pide el usuario:**
- Mostrar la lista de documentos con su estado y un detalle que se actualiza solo mientras se procesan.
- **No mostrar la bitácora de eventos** (PENDING > PROCESSING > DONE con fechas) — el frontend nunca llamó a `GET /api/documents/:id/events`.

### Autenticación y sesiones

- **Contraseñas:** bcrypt con costo 12 en RDS; el correo es único.
- **Token JWT:** firmado con HS256, dura 1 hora. Si vence, la API responde 401 y el frontend cierra la sesión solo; también hay botón de cerrar sesión.
- **Por usuario:** cada usuario ve y consulta solo sus propios documentos. Documento ajeno responde 404 (probado en la demo). No hay roles (administrador, usuario, etc.).

### Estado actual y hallazgo

- La API ya tiene `GET /api/documents/:id/events` y devuelve `{items: [...]}` con cada evento que tiene: `documentId`, `eventAt`, `eventId`, `toStatus`, `fromStatus`, `actor`, `reason`, `userId`, `schemaVersion`.
- **El frontend no lo usa** — los eventos de auditoría (PENDING → PROCESSING → DONE) no aparecen en la UI.
- El detalle actual muestra metadatos (tipo, tamaño, SHA-256, páginas/dimensiones) pero no la línea de tiempo de eventos.

### Propuesta de organización

1. **Historia de eventos en el drawer/detail**
   - Usar `GET /api/documents/:id/events` en paralelo al carga del detalle.
   - Mostrar línea de tiempo: PENDING → PROCESSING → DONE con fecha y actor (api/worker/system).
   - Cada evento con su motivo si es FAILED.

2. **Lista con estados y actualización automática**
   - Mostrar estado actual (PENDING/PROCESSING/DONE/FAILED) en la lista.
   - El polling existente cada 5 s ya actualiza el estado; añadir indicador de "ultima actualización".

3. **Sesión y auth (ya implementado)**
   - JWT HS256, 1 hora, renovación implícita por polling.
   - Cierre de sesión por timeout (401) y botón explícito.
   - Aislamiento por usuario: `WHERE userId = ?` en todas las queries.

4. **Sin roles nuevos**
   - El modelo actual (mismo usuario, documentos propios) es suficiente.
   - No se requiere un rol "admin" para esta historia.