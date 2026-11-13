# Informe A8 — Prueba de carga y evidencia del escalado del ASG

> **Estado honesto (2026-11-13):** el guion de saturación existe y está validado por revisión de código (`scripts/load-test.sh`); **la evidencia viva desde esta sesión no se puede producir** porque el SCP del Sandbox deniega toda API de lectura (`autoscaling:DescribeScalingActivities`, `GetMetricStatistics`...). Este informe documenta lo existente, lo que falta y el procedimiento exacto para cerrarlo. **No hay resultados de escalado 2→4 inventados en este documento.**

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

## Lo que NO se ha podido demostrar aún

- Escalado real del ASG (2 → 3/4 instancias) bajo carga, medido en `describe-scaling-activities`.
- CPU media subiendo de 60 % y disparo de la política.
- Alarmas de CPU en `ALARM` durante la ventana de carga.

Motivo: en la sesión actual (`AWS_PROFILE=academy`, voclabs) **todo SCP deniega las APIs de lectura**: mensajes literales en `docs/informe-b10.md`.

Antecedente que sí existe: el drill de tolerancia a fallos del 2026-11-13 (un `terminate-instances` → ALB siguió sirviendo 200 con la instancia restante; el ASG reemplazó la instancia; draining 30 s; 5xx transitorios ~1–4 min esperados).

## Cómo cerrar A8 (sesión con permisos o consola)

1. Abrir sesión del laboratorio (AWS Academy → Details) y copiar credenciales; refrescar `~/.aws/credentials`.
2. Verificar: `aws sts get-caller-identity` (cuenta del lab) y `terraform -chdir=infra plan` sin sorpresas.
3. Ejecutar:

   ```bash
   mkdir -p logs && LOG_DIR=./logs ./scripts/load-test.sh
   ```

   Esperado: CPU sube hacia/tu sobre el 60 %, el ASG suma instancias (hasta 4), salidas en `logs/ab.txt` (login/s, pXX) y `logs/asg.txt` (actividades de scaling).
4. En la consola: **CloudWatch → Alarmas** → `docuprocess-dev-ec2-cpu-high` debe pasar a `ALARM`; **EC2 → ASG → Activity** debe mostrar `Launching a new EC2 instance` repetidas; confirmar correo de SNS (suscripción confirmada).
5. Cuando baje la CPU (≈15 min tras parar): verificar que la política reduce instancias de vuelta; adjuntar `logs/` (sin IDs de cuenta ni secretos) aquí y en `docs/trazabilidad.md` fila 19 → `Verificado`.

## Enunciado y rúbrica

- A10/A7 (escala↔seguro) y A8 (carga) corresponden al punto «Simulación de carga de tráfico para verificar el comportamiento del ASG»;
- Rúbrica: monitoreo/resiliencia 15 % e IaC 2–4 con target tracking.

## Estado final (cierre 2026-11-13)

- **Implementación**: completa y revisada (script, policy target tracking, alarmas). ✅
- **Evidencia viva en esta sesión**: **no obtenible** (SCP). ⚠️
- **Pendiente para la defensa**: ejecutar el procedimiento anterior en una sesión con permisos (planificado con C4, 2026-11-13) y pegar los logs redactados en este documento.
