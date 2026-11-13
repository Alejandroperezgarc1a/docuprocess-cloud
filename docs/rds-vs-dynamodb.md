# RDS vs. DynamoDB: justificación de las dos bases de datos

> Documento exigido por el enunciado (§5: «justificación/comparativa RDS vs. DynamoDB para sus
> respectivos casos de uso») y por la rúbrica de Gestión de Datos (20 %). No es una comparación
> genérica: explica por qué **DocuProcess Cloud usa las dos** y qué problema resuelve cada una.

## 1. Resumen de la decisión

| Necesidad del sistema | Motor elegido | Por qué |
| --- | --- | --- |
| Cuentas, correos únicos y autenticación | **RDS MySQL 8.0** (Single-AZ, `db.t3.micro`) | Datos relacionales con unicidad, transacciones y consultas por correo; el esquema cambia poco y el volumen es pequeño |
| Estado de cada documento y cola del worker | **DynamoDB** (`documents`, on-demand) | Acceso por clave (`documentId`) y por índice (`userId`, `status`); escala sin administrar servidores y la carga es intermitente |
| Historial auditable de cambios de estado | **DynamoDB** (`document_events`, append-only) | Eventos inmutables, ordenados por `documentId` + `eventAt`; crecen de forma ilimitada sin migraciones ni joins |
| Archivos originales | **S3** | Objetos binarios de hasta 10 MB; no pertenecen a una base de datos |

La regla de diseño es: **RDS para lo que exige integridad relacional; DynamoDB para lo que exige
acceso por clave y escala horizontal; S3 para los bytes**.

## 2. RDS MySQL: usuarios y autenticación

### 2.1. Qué problema resuelve

La tabla `users` necesita:

- **Unicidad del correo.** `UNIQUE(email)` es una restricción declarativa: la base la hace cumplir
  incluso si dos peticiones simultáneas intentan registrar el mismo correo. En DynamoDB habría que
  inventar una clave y coordinar la condición a mano.
- **Transacciones ACID** al crear el usuario y, más adelante, al relacionarlo con otros datos.
- **Consultas por atributos** (`WHERE email = ?`) sin diseñar un índice para cada combinación.
- **Integridad referencial** si se agregan tablas relacionadas (sesiones, preferencias, auditoría
  administrativa).
- **Credenciales y respaldo gestionados** por RDS: no hay servidor MySQL que operar.

El esquema se aplica al arrancar la API (`app/api/schema.sql`), no con Terraform: Terraform crea
la instancia, no las tablas. Esto separa infraestructura de esquema de aplicación.

### 2.2. Por qué NO DynamoDB para autenticación

- El correo es un atributo consultable, no una clave natural. DynamoDB obligaría a mantener un
  ítem «correo → usuario» y a escribir dos ítems por registro (transacción) o a aceptar
  duplicados.
- Las contraseñas se comparan con bcrypt, pero el flujo de login necesita buscar por correo y
  luego leer el hash: dos accesos por clave que en SQL son una consulta trivial.
- El volumen de usuarios de la demo es mínimo; la escala horizontal de DynamoDB no aporta nada.
- El enunciado pide explícitamente RDS para «cuentas y autenticación».

### 2.3. Restricciones del Sandbox que afectan a RDS

| Restricción | Decisión |
| --- | --- |
| Single-AZ obligatorio | `multi_az = false`; el subnet group usa 2 AZ para poder recrear la instancia |
| Almacenamiento `gp2` ≤ 100 GB | `allocated_storage = 20`, `storage_type = "gp2"` |
| Clase pequeña | `db.t3.micro` |
| Sin NAT | RDS vive en subredes privadas; solo el SG de la app abre 3306 |
| Backups | `backup_retention_period = 1` (point-in-time recovery mínimo) |

## 3. DynamoDB: documentos y bitácora

### 3.1. Qué problema resuelve

Los documentos tienen tres patrones de acceso claros:

1. **Por documento:** `GetItem(documentId)` para el detalle y para que el worker lo reclame.
2. **Por usuario:** `Query` del GSI `userId-createdAt`, más recientes primero (lista del frontend).
3. **Por estado:** `Query` del GSI `status-createdAt` para que el worker tome los `PENDING` más
   antiguos (cola lógica).

Estos patrones se conocen de antemano y encajan con el modelo de DynamoDB: clave de partición
`documentId`, índices para las dos consultas alternativas y `PAY_PER_REQUEST` para no aprovisionar
capacidad en una demo intermitente.

La bitácora `document_events` añade un cuarto patrón:

4. **Por documento, en orden cronológico:** `Query(documentId)` con `ScanIndexForward=true`.
   Además, `userId-eventAt` permite auditar a un usuario entre documentos y `day-eventAt` permite
   auditar un día completo sin `Scan`.

### 3.2. Por qué NO RDS para los documentos

- El estado del documento es **schemaless en la práctica**: `result` cambia según el tipo (páginas
  para PDF, ancho/alto para imágenes) y `error` solo existe en `FAILED`. En SQL esto serían columnas
  nulas o una tabla de atributos; en DynamoDB es un mapa opcional.
- La cola del worker se resuelve con un índice y un `Update` condicional, sin bloquear filas ni
  mantener un proceso de polling sobre una tabla relacional.
- El historial crece de forma monotónica. Una tabla de eventos en MySQL funcionaría, pero obliga a
  administrar particiones, purgas y capacidad; en DynamoDB el crecimiento es horizontal y el
  `PutItem` es O(1).
- Aislar la carga del worker de la carga de autenticación evita que un pico de procesamiento
  afecte los logins (y viceversa).

### 3.3. Por qué una tabla separada para el historial

Se evaluaron dos opciones:

| Opción | Ventaja | Problema |
| --- | --- | --- |
| Guardar una lista `events` dentro del ítem `documents` | Una sola lectura trae estado + historial | El ítem crece sin límite (400 KB máximo); reescribir la lista completa en cada transición; no se puede consultar «todos los eventos de un día» sin leer todos los documentos; un error de código puede borrar la historia |
| Tabla `document_events` append-only | Crecimiento independiente; consultas por documento, usuario o día; la política del rol no permite `UpdateItem`/`DeleteItem` | Dos escrituras por transición (resueltas con `TransactWriteItems`) |

Se eligió la segunda. La inmutabilidad no depende solo del código: **la política de recurso de
DynamoDB no concede `UpdateItem` ni `DeleteItem`** al rol de las instancias. Aunque un bug
intentara reescribir un evento, AWS lo denegaría.

### 3.4. Atomicidad entre estado e historial

`TransactWriteItems` agrupa:

- `Put` del documento con `ConditionExpression = attribute_not_exists(documentId)` (no sobrescribe
  un documento existente).
- `Put` del evento con `ConditionExpression = attribute_not_exists(eventAt)`: la clave es
  `(documentId, eventAt)`, así que la condición protege esa clave exacta y no impide que el
  documento tenga otros eventos. El sufijo aleatorio de `eventAt` evita colisiones.

Si cualquiera falla, no se escribe ninguno. El SDK devuelve `TransactionCanceledException` con
`CancellationReasons`; el código de la condición es `ConditionalCheckFailed` (no
`ConditionalCheckFailedException`, que es el de un `UpdateItem` suelto).

**Fallback del Sandbox:** si una SCP denegara las escrituras transaccionales, `DDB_TRANSACTIONS=false`
escribe primero el documento y después el evento. El sistema sigue funcionando, pero una caída
entre las dos escrituras deja un documento sin su evento `PENDING`; se documenta como deuda y se
detecta comparando el documento con su bitácora.

### 3.5. Capacidad y costo

- `PAY_PER_REQUEST` evita capacidad ociosa: se paga por lectura/escritura real. En una demo con
  decenas de documentos el costo es céntimos.
- Con `PROVISIONED` habría que estimar RCU/WCU y ajustar alarmas de throttling; no aporta nada al
  proyecto.
- El tamaño máximo de un ítem es 400 KB. Los archivos **no** se guardan en DynamoDB: viven en S3 y
  el ítem solo guarda la clave (`s3Key`) y los metadatos del análisis.

## 4. Comparación lado a lado

| Criterio | RDS MySQL | DynamoDB |
| --- | --- | --- |
| Modelo | Relacional, SQL, joins | Clave-valor/documento, API por ítem |
| Esquema | Fijo, migraciones | Flexible; solo se declaran claves e índices |
| Unicidad | `UNIQUE`, `PRIMARY KEY` | Condiciones (`attribute_not_exists`) o claves diseñadas |
| Transacciones | ACID completas | `TransactWriteItems`/`TransactGetItems` (hasta 100 ítems) |
| Consistencia | Fuerte por defecto | Eventual en GSIs; `ConsistentRead` en la tabla base |
| Escala | Vertical (clase de instancia) | Horizontal (particiones) |
| Capacidad | Aprovisionada | On-demand o aprovisionada |
| Consultas ad hoc | Sí (`WHERE`, `JOIN`, `GROUP BY`) | No: hay que diseñar índices o usar `Scan` (caro) |
| Backups | Automáticos + snapshots | PITR (35 días) + on-demand |
| Seguridad de acceso | SG + usuario/contraseña + TLS | Políticas de recurso/IAM + cifrado en reposo |
| Operación | Parches y ventanas de RDS | Totalmente gestionado, sin servidores |
| Límite por ítem | Filas sin límite práctico | 400 KB |
| Costo en la demo | Instancia `db.t3.micro` encendida 24/7 | Por petición (céntimos) |
| Ajuste al problema | Cuentas y autenticación | Estado, cola e historial |

## 5. Patrones de acceso

Cada consulta del sistema está resuelta por una clave o un índice concreto; ninguna usa `Scan`.
La tabla se obtuvo del código (`app/api/src/db.ts`, `app/api/src/aws.ts` y `app/worker/src/aws.ts`).

| Consulta | Base, tabla o índice | Operación | Quién la hace |
| --- | --- | --- | --- |
| Registrar un usuario | RDS, `users` | `INSERT` con `UNIQUE(email)`; un duplicado devuelve 409 | API |
| Iniciar sesión | RDS, `users` | `SELECT … WHERE email = ?` y comparación bcrypt | API |
| Readiness al arrancar | RDS | `SELECT 1` (`GET /api/ready`) | API, llamada por el userData |
| Crear un documento | `documents` + `document_events` | `TransactWriteItems`: `Put` con `attribute_not_exists(documentId)` + `Put` del evento | API |
| Listar los documentos del usuario | `documents`, GSI `userId-createdAt` | `Query` por `userId`, descendente, máximo 50 | API |
| Ver el detalle de un documento | `documents`, tabla base | `GetItem` por `documentId` con `ConsistentRead` y verificación de dueño | API |
| Ver la bitácora de un documento | `document_events`, tabla base | `Query` por `documentId`, ascendente por `eventAt`, máximo 200 | API |
| Tomar trabajo pendiente | `documents`, GSI `status-createdAt` | `Query` con `status = PENDING`, ascendente (los más antiguos primero) | Worker |
| Reclamar un documento | `documents` + `document_events` | `UpdateItem` con `#s = :pending` → `PROCESSING` + `Put` del evento | Worker |
| Cerrar un documento | `documents` + `document_events` | `UpdateItem` con `#s = :processing` → `DONE` o `FAILED` + `Put` del evento | Worker |
| Vencer una subida que nunca llegó | `documents` + `document_events` | `UpdateItem` con `#s = :pending` → `FAILED "upload timeout"` + `Put` del evento | Worker |
| Auditar a un usuario entre documentos | `document_events`, GSI `userId-eventAt` | `Query` por `userId` | Operador (consola o CLI); la app no lo expone |
| Auditar todos los cambios de un día | `document_events`, GSI `day-eventAt` | `Query` por `eventDay` | Operador (consola o CLI); la app no lo expone |

Observaciones:

- Los GSI son de consistencia eventual. Por eso el worker no confía en el estado leído del índice:
  el `UpdateItem` condicional sobre la tabla base es el que decide, y el detalle que ve el usuario
  se lee con `ConsistentRead`.
- Las dos consultas de auditoría (`userId-eventAt` y `day-eventAt`) están diseñadas pero no tienen
  endpoint; se usan desde la consola o la CLI durante una revisión.

## 6. Alternativas descartadas

### 6.1. Todo en RDS

Una sola base MySQL con tablas `users`, `documents` y `document_events` es viable a esta escala y
tiene ventajas reales: un solo motor que operar, joins entre usuarios y documentos, y consultas ad
hoc. Se descartó por estas razones:

- **Acoplamiento de carga.** El worker sondea la cola cada 5 segundos desde 2 a 4 instancias; en
  RDS eso compite por CPU y conexiones con el login, que ya es la operación cara (bcrypt cost 12) y
  la que estresa la prueba de carga. Una sola `db.t3.micro` sería el punto de saturación de todo el
  sistema.
- **Cola sobre SQL.** Para que dos workers no tomen la misma fila habría que usar
  `SELECT … FOR UPDATE SKIP LOCKED` dentro de una transacción, con conexiones abiertas mientras se
  reclama. En DynamoDB el reclamo es una sola petición HTTP condicional, sin conexiones ni bloqueos.
- **Esquema variable.** `result` depende del tipo de archivo (páginas para PDF, ancho y alto para
  imágenes); en SQL serían columnas nulas o una tabla de atributos.
- **Crecimiento y permisos de la bitácora.** En MySQL la inmutabilidad dependería de `GRANT`s sobre
  un usuario de base de datos que la propia API administra; en DynamoDB la impone la política de
  recurso, fuera del alcance de la aplicación.
- **Disponibilidad.** RDS es Single-AZ en este despliegue; con todo en RDS, su caída detendría
  también el procesamiento de documentos. Hoy una caída de RDS solo afecta registro y login.

### 6.2. SQS como cola

SQS es la opción estándar para desacoplar productor y consumidor. Aquí se usa en su lugar el GSI
`status-createdAt` más el `UpdateItem` condicional.

**Por qué basta en este proyecto:**

- El volumen es bajo (una demo con decenas de documentos) y el sondeo cada 5 segundos es una
  latencia aceptable.
- El estado del documento ya tiene que vivir en DynamoDB para la API y la bitácora. Con SQS habría
  dos fuentes de verdad (el mensaje y el ítem) que mantener consistentes: si la API escribe el ítem
  y falla al encolar, el documento queda huérfano; si encola primero, el worker puede recibir un
  mensaje de un ítem que no existe.
- La exclusión mutua la da la condición `#s = :pending`: aunque varios workers lean el mismo
  `PENDING` del índice, solo uno gana. SQS estándar entrega *at-least-once*, así que de todas
  formas haría falta esa misma condición para que el procesamiento sea idempotente.
- Un componente menos que crear, asegurar con política de recurso y alcanzar desde subredes sin
  NAT (SQS necesitaría su propio interface endpoint).

**Qué ganaríamos con SQS:**

- **Recuperación de trabajos huérfanos.** Con el diseño actual, si una instancia termina (escalado
  hacia abajo o reemplazo del ASG) mientras un documento está en `PROCESSING`, ese documento queda
  en ese estado: el código no tiene un barrido que lo devuelva a `PENDING`. En SQS el *visibility
  timeout* hace que el mensaje vuelva a la cola automáticamente.
- **Dead-letter queue.** Los mensajes que fallan N veces se apartan solos para revisión.
- **Entrega por evento en vez de sondeo.** Con notificaciones de S3 a SQS el worker solo trabaja
  cuando el archivo existe, sin `HeadObject` de documentos todavía no subidos y con long polling
  en lugar de consultas periódicas al índice.
- **Escalado por profundidad de cola.** La métrica `ApproximateNumberOfMessagesVisible` permite
  escalar los workers por trabajo pendiente y no solo por CPU.

Si el volumen creciera, el siguiente paso sería S3 → SQS → worker, manteniendo DynamoDB como
fuente de verdad del estado y el `UpdateItem` condicional como garantía de idempotencia.

### 6.3. RDS Multi-AZ

El módulo `rds` crea la instancia con `multi_az = false`. Multi-AZ mantiene una réplica síncrona en
otra AZ y hace *failover* automático, pero el Sandbox de AWS Academy admite **exclusivamente
despliegues Single-AZ** (el enunciado lo lista entre sus restricciones y la rúbrica de datos exige
cumplirla). Aun sin esa restricción, duplicaría el costo de la instancia y alargaría la creación en
un laboratorio que se destruye y recrea en cada sesión.

Consecuencia aceptada: si la AZ de RDS falla, el registro y el login quedan caídos hasta que la
instancia se recupere. Los documentos (DynamoDB y S3, regionales) y el ALB y el ASG (dos AZ) siguen
disponibles, y el health check del ALB (`/api/health`) no depende de MySQL, así que el ASG no
recicla instancias por una caída de la base.

En producción cambiaría:

- `multi_az = true` (o Aurora MySQL con una réplica en otra AZ). El subnet group ya cubre dos AZ,
  así que no hay que rehacer la red.
- `backup_retention_period` de 7 días o más, `deletion_protection = true` y snapshot final al
  destruir (`skip_final_snapshot = false`).
- La API debería reintentar conexiones durante el *failover* (unos 60 a 120 segundos), porque el
  endpoint DNS cambia de IP.
- Probablemente RDS Proxy, para absorber las reconexiones de varias instancias del ASG.

## 7. Antipatrones que se evitaron

- **Usar DynamoDB como base relacional:** hacer `Scan` para listar usuarios o documentos es caro y
  lento; por eso cada consulta tiene su índice.
- **Guardar el historial como una lista dentro del documento:** el ítem crece sin control y se
  reescribe completo.
- **Usar una clave de estado constante (`status`) sin ordenación:** todos los `PENDING` caerían en
  la misma partición. El GSI usa `status` + `createdAt` y el worker limita la consulta.
- **Guardar archivos en la base:** los binarios van a S3; DynamoDB solo guarda metadatos.
- **Confiar solo en el código para la inmutabilidad:** la política de recurso elimina
  `UpdateItem`/`DeleteItem` de la tabla de eventos.
- **Mezclar la carga del worker con la de autenticación:** RDS y DynamoDB escalan y fallan por
  separado.

## 8. Cuándo cambiar la decisión

| Si el proyecto… | Entonces… |
| --- | --- |
| necesitara reportes ad hoc sobre documentos (por fecha, tipo, usuario, estado combinados) | mover un resumen a RDS o a un data warehouse; DynamoDB no es para analítica |
| tuviera millones de usuarios con consultas por múltiples atributos | evaluar Aurora o una base relacional escalable; el modelo de usuarios no cambia |
| necesitara búsqueda de texto completo | usar OpenSearch o un motor de búsqueda, no DynamoDB |
| procesara más de 100 ítems por transacción | dividir la transacción o usar un patrón saga |
| necesitara retención legal de eventos por años con consultas complejas | exportar a S3 + Athena, manteniendo DynamoDB como registro operativo |

## 9. Referencias

- AWS, *Amazon RDS vs. Amazon DynamoDB* (documentación de decisión).
- AWS, *DynamoDB core components*: claves, índices y capacidad.
- AWS, *DynamoDB transactions*: `TransactWriteItems` y límites.
- AWS, *RDS for MySQL*: Single-AZ, backups y point-in-time recovery.
- `docs/architecture.md`, vista general (diagramas, permisos y restricciones del Sandbox) y contratos 4, 4.1 y 11.
