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

**Fallback del Sandbox:** si una SCP denegara `TransactWriteItems`, `DDB_TRANSACTIONS=false`
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

## 5. Antipatrones que se evitaron

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

## 6. Cuándo cambiar la decisión

| Si el proyecto… | Entonces… |
| --- | --- |
| necesitara reportes ad hoc sobre documentos (por fecha, tipo, usuario, estado combinados) | mover un resumen a RDS o a un data warehouse; DynamoDB no es para analítica |
| tuviera millones de usuarios con consultas por múltiples atributos | evaluar Aurora o una base relacional escalable; el modelo de usuarios no cambia |
| necesitara búsqueda de texto completo | usar OpenSearch o un motor de búsqueda, no DynamoDB |
| procesara más de 100 ítems por transacción | dividir la transacción o usar un patrón saga |
| necesitara retención legal de eventos por años con consultas complejas | exportar a S3 + Athena, manteniendo DynamoDB como registro operativo |

## 7. Referencias

- AWS, *Amazon RDS vs. Amazon DynamoDB* (documentación de decisión).
- AWS, *DynamoDB core components*: claves, índices y capacidad.
- AWS, *DynamoDB transactions*: `TransactWriteItems` y límites.
- AWS, *RDS for MySQL*: Single-AZ, backups y point-in-time recovery.
- `docs/architecture.md`, secciones 4, 4.1 y 11 (contrato y permisos reales del proyecto).
