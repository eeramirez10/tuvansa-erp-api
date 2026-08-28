# Despliegue de producción con Docker

La API se construye como una imagen multi-stage. La etapa final contiene Node.js,
las dependencias de producción y `dist/`; no contiene TypeScript, pnpm, pruebas,
scripts de captura ni credenciales.

## Requisitos del servidor

- Linux con Docker Engine y Docker Compose v2.
- Acceso de red desde el contenedor hacia la base MySQL heredada.
- Un proxy inverso como Nginx, Caddy o Traefik si se publicará con HTTPS.
- El repositorio clonado en una ruta dedicada al servicio.

## Configuración inicial

Desde la raíz del repositorio:

```bash
cp .env.production.example .env.production
chmod 600 .env.production
nano .env.production
```

Configure las credenciales MySQL y sustituya `CORS_ORIGINS` por el dominio real
del frontend. Puede declarar varios orígenes separados por comas:

```dotenv
CORS_ORIGINS=https://erp.tuvansa.com.mx,https://erp-admin.tuvansa.com.mx
```

Por seguridad, el puerto se publica en `127.0.0.1` de forma predeterminada para
que solamente lo consuma un proxy inverso en el mismo servidor. Para exponerlo
directamente en la red debe cambiar conscientemente:

```dotenv
API_BIND_ADDRESS=0.0.0.0
```

`.env.production` está ignorado por Git y no debe copiarse al repositorio.

## Primer despliegue

```bash
git checkout main
git pull --ff-only origin main
docker compose --env-file .env.production -f compose.production.yml build --pull
docker compose --env-file .env.production -f compose.production.yml up -d --remove-orphans
docker compose --env-file .env.production -f compose.production.yml ps
curl --fail http://127.0.0.1:3000/health
```

La respuesta esperada es:

```json
{"status":"ok"}
```

## Actualización habitual

```bash
git checkout main
git pull --ff-only origin main
docker compose --env-file .env.production -f compose.production.yml up -d --build --remove-orphans
```

El servicio usa `restart: unless-stopped`, healthcheck, un filesystem de solo
lectura, usuario sin privilegios y límites configurables de CPU, memoria y
procesos.

El healthcheck se ejecuta dentro del contenedor contra
`http://127.0.0.1:3000/health`. `API_PORT` solamente cambia el puerto publicado
en el servidor; no cambia el puerto interno del contenedor.

## Operación

Consultar estado y logs:

```bash
docker compose --env-file .env.production -f compose.production.yml ps
docker compose --env-file .env.production -f compose.production.yml logs -f --tail=200 api
```

Reiniciar o detener:

```bash
docker compose --env-file .env.production -f compose.production.yml restart api
docker compose --env-file .env.production -f compose.production.yml down
```

Inspeccionar el healthcheck:

```bash
docker inspect --format '{{json .State.Health}}' tuvansa-erp-api-api-1
```

Si Compose asignó otro nombre al contenedor, obténgalo con `docker compose ps`.

## Rollback básico

Antes de actualizar, conserve el hash actualmente desplegado:

```bash
git rev-parse HEAD
```

Para volver temporalmente a ese commit sin modificar el historial remoto:

```bash
git checkout <commit-anterior>
docker compose --env-file .env.production -f compose.production.yml up -d --build
```

Después del diagnóstico puede regresar a la rama estable:

```bash
git checkout main
git pull --ff-only origin main
docker compose --env-file .env.production -f compose.production.yml up -d --build
```

## Consideraciones de red

- `LEGACY_DB_HOST` debe ser resoluble y alcanzable desde la red de Docker.
- No use `localhost` para una base que vive fuera del contenedor de la API.
- Si MySQL filtra por dirección IP, autorice la dirección del servidor o la red
  de Docker correspondiente.
- Termine TLS en el proxy inverso y reenvíe tráfico al puerto configurado en
  `API_PORT`.
