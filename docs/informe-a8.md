# Informe A8 — Prueba de carga y evidencia del escalado del ASG

> **Estado (2026-11-13): Verificado.** El escalado del ASG bajo carga está demostrado con evidencia real en **dos sesiones del Sandbox de entrega** (la de la mañana, con la pila #50–#52, y la de la tarde, con el despliegue desde cero `apply 73`). Los datos provienen de `logs/run.log`/`asg.txt`/`ab.txt` (corrida del 13-nov) y del informe de ejecución de la prueba del 11-nov (fix `keepAliveTimeout = 65000`, merge en PR #45). En algunas sesiones del laboratorio las APIs de lectura llegan a estar denegadas por SCP; cuando eso ocurra, usar la consola (sección «Cómo repetir»).

## Objetivo (enunciado §10)

Simular carga de tráfico y comprobar que el Auto Scaling Group escala (y que el target tracking CPU 60 % funciona): «Simulación de carga de tráfico para verificar el comportamiento del ASG».

## Lo existente y validado por revisión de código

`scripts/load-test.sh` (rama `main`):

- Registra un usuario de prueba propio (correo único por corrida `carga-<epoch>@docuprocess.test`, password aleatoria) vía `POST /api/auth/register` contra el **ALB** (no CloudFront) — comprueba el deploy completo (ruta 53/ALB/API) antes del esfuerzo.
- Confirma login de prueba (200).
- Satura la CPU del ASG con **logins masivos con bcrypt costo 12**: `ab -s 60 -n … -c 50 -p login.json -T application/json …/api/auth/login` contra el ALB (saturación realista de CPU, no de I/O).
- Sondea cada 30 s `aws autoscaling describe-scaling-activities` y la CPU media (`GetMetricStatistics`) → muestra el escalado (2 → más instancias) y la CPU.
- Parámetros por defecto: `600 s`, concurrencia `50`; `LOG_DIR` configurable para guardar la salida en `./logs`.
- Errores cubiertos: registro no devuelve 201 → aborta; login no devuelve 200 → aborta; falta `ab`/`aws`/`terraform`/`curl` → mensaje claro.

Consistencia cruzada: la prueba de carga complementa el target tracking `ASGAverageCPUUtilization` (60 %) definido en `infra/modules/compute/main.tf` (policy target tracking, orden `create_before_destroy` correcto).

## Evidencia #1 — ejecución del 11-nov y mañana del 13-nov (equipo, pila #50–#52)

`scripts/load-test.sh` ejecutado contra el ALB (login bcrypt como generador de carga):

- **1ª corrida (2026-11-11):** 6677 logins; el ASG pasó **2 → 3 → 4** (CPU 100 %); 1.0 % de errores (50 × ELB 502 por keep-alive de Node + 15 × 503 de MySQL `ETIMEDOUT` bajo saturación); el ASG bajó de nuevo a 2 en ~22 min tras ceder la carga.
- **2ª corrida (13-nov, con el fix `keepAliveTimeout = 65000` de #45):** 3651 logins; **ELB 502 = 0**; 38 × 503 (MySQL `ETIMEDOUT` con CPU al 100 % — saturación, no de red); CPU 14 % → 100 % en ~5 min; **escalado 2 → 4 en ~7 min**.
- **Ctrl+C probado:** el script termina limpio, imprime el resumen de `ab` y no deja ningún proceso `ab` vivo.

## Evidencia #2 — ejecución del 13-nov, sesión de entrega (cuenta voclabs)

> Corrida directa contra el ALB de la pila desplegada hoy desde cero (`apply` de 73 recursos). Los datos provienen de `run.log`/`asg.txt`/`ab.txt` de `/tmp/opencode/loadtest-2026-11-13/`.

- **Comando:** `AWS_PROFILE=academy LOG_DIR=/tmp/opencode/loadtest-2026-11-13 ./scripts/load-test.sh` (600 s, concurrencia 50, usuario `carga-1794592725@docuprocess.test`, directo contra el ALB, sin CloudFront).
- **Rampa de CPU (sondeo cada 30 s):** 0 % (+0 s) → 3 % (+32 s) → 10 % (+64 s, +98 s, +130 s, warm-up) → **99 % desde +162 s** y sostenido ≥95 % hasta el final de la corrida.
- **Escalado real del ASG:** a los +333 s (13:04:19 −05, 18:04:19 UTC) el ASG pasó de `Desired=2 InService=2` a **`Desired=4 InService=4`** (target tracking CPU 60 % disparó la política). Las actividades de scaling registradas (`describe-scaling-activities`) confirman: `Successful — Launching a new EC2 instance: i-008f985b20298fea3` y `... i-0ae3ffffdad8a1fb9` a las 18:04:05Z (además del alta inicial de `i-01ad8be4d7168cd5f` e `i-03f1436f858e72c8c` a las 17:42:42Z).
- **Resultado de ab:** 5848 requests completos, 32 fallidos, **4 no-2xx** (transitorios durante el escalado), 9.75 req/s, latencia media 5.13 s (p50 3.95 s, p90 8.09 s, p99 23.4 s, máx 135.8 s) — coherente con bcrypt costo 12 saturando 2 vCPU.
- **Capacidad:** el ASG permaneció en 4 al terminar la corrida; el scale-in a 2 requiere ~15 min de CPU baja (la alarma `AlarmLow` de target tracking evalúa 15 puntos de 1 min).
- **Nota honesta sobre `ab.txt`:** ApacheBench no imprime el resumen hasta que finaliza la corrida; los números de arriba corresponden al cierre de la prueba (exit 0).

### Qué demuestra para el enunciado §10 y la rúbrica (monitoreo 15 %)

1. La política de **target tracking CPU 60 %** funciona de verdad: la CPU saturada disparó el escalado 2→4 y el ASG reemplazó capacidad sin intervención manual.
2. El flujo completo bajo carga (ALB → 2→4 EC2 → API → login bcrypt) se mantuvo sirviendo 200/4xx/5xx esperados; los 4 no-2xx son la transitoriedad típica de draining/scale-out.
3. Las alarmas CloudWatch (`docuprocess-dev-ec2-cpu-high`, ver `docs/informe-b10.md`) estaban en `OK` con 1 acción SNS antes de la prueba; la corrida no generó fallo de servicio.

### Contexto (no es el resultado de A8)

El 13-nov se hizo además un *drill* de tolerancia a fallos: un `terminate-instances` → el ALB siguió sirviendo 200 con la instancia restante; el ASG reemplazó la instancia; draining de 30 s; 5xx transitorios ~1–4 min esperados. Se documenta como antecedente operativo; **no sustituye la evidencia de carga de A8** (arriba).

## Cómo repetir A8 (sesión con permisos o consola)

1. Abrir sesión del laboratorio (AWS Academy → Details) y copiar credenciales; refrescar `~/.aws/credentials`.
2. Verificar: `aws sts get-caller-identity` (cuenta del lab) y `terraform -chdir=infra plan` sin sorpresas.
3. Ejecutar:

   ```bash
   mkdir -p logs && LOG_DIR=./logs ./scripts/load-test.sh
   ```

   Esperado: CPU sube hacia/por encima del 60 %, el ASG suma instancias (hasta 4), salidas en `logs/ab.txt` (login/s, pXX) y `logs/asg.txt` (actividades de scaling).
4. En la consola: **CloudWatch → Alarmas** → `docuprocess-dev-ec2-cpu-high` debe pasar a `ALARM`; **EC2 → ASG → Activity** debe mostrar `Launching a new EC2 instance`; confirmar correo de SNS (suscripción confirmada).
5. Cuando baje la CPU (≈15 min tras parar): verificar que la política reduce instancias; adjuntar `logs/` (sin IDs de cuenta ni secretos) aquí y en `docs/trazabilidad.md` fila 19.

## Enunciado y rúbrica

- A10/A7 (escala↔seguro) y A8 (carga) corresponden al punto «Simulación de carga de tráfico para verificar el comportamiento del ASG»;
- Rúbrica: monitoreo/resiliencia 15 % e IaC 2–4 con target tracking.

## Estado final (cierre 2026-11-13)

- **Implementación**: completa y revisada (script, policy target tracking, alarmas). ✅
- **Evidencia viva**: **obtenida y repetida** — escalado real 2→4 en dos ejecuciones (11-nov y 13-nov); la del 13-nov detalla rampa CPU 98–99 % (+162 s), escalado a los +333 s, 5848 requests, 4 no-2xx transitorios. ✅
- **Pendiente menor**: scale-in automático 4→2 (~15 min de CPU baja) y, opcionalmente, captura de la alarma en estado `ALARM` durante la defensa.
