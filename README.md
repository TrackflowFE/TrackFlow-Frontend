# TrackFlow · Frontend

Prototipo funcional del frontend de TrackFlow (Fábrica Escuela, UdeA 2026-2). Consume la API real del backend del equipo, sin datos simulados.

- **Backend:** [TrackflowFE/FabricaEscuela-Proyecto-TrackFlow](https://github.com/TrackflowFE/FabricaEscuela-Proyecto-TrackFlow)
- **API desplegada:** https://trackflow-mxll.onrender.com ([Swagger](https://trackflow-mxll.onrender.com/swagger-ui/index.html))
- **Especificación:** [`docs/especificacion.html`](docs/especificacion.html): pantallas, contrato consumido y estados diseñados.

## Pantallas

| Pantalla | Acceso | Historia |
|---|---|---|
| Rastrear envío: estado, pasos y línea de tiempo | Público | HU-03, HU-04 |
| Registrar envío | Operador | HU-01 |
| Registrar evento logístico | Operador | HU-02 |
| Volumen de envíos por periodo y punto de ingreso | Operador | HU-07 |
| Tiempos de tránsito: promedio total y por tramo de los envíos entregados | Operador | HU-05 |
| Ingresar / cerrar sesión | Público | HU-08 |
| Reconstruir proyecciones | Administrador | — |

## Estructura

```
TrackFlow-Frontend/
├── index.html                  Aplicación (pantallas, estilos y lógica)
├── assets/
│   └── images/                 Logo y fotografías de fondo
├── docs/
│   └── especificacion.html     Especificación de pantallas y contrato
└── vendor/                     Código de terceros, no se edita a mano
    ├── dc-runtime/             Motor de plantillas, image-slot y página de documentación
    └── design-system/          Tokens y estilos base del sistema de diseño
```

## Cómo ejecutarlo

Es un sitio estático: no requiere compilación. Debe servirse desde `http://localhost:5173`, que es el origen permitido por CORS en el backend (abrirlo con doble clic, como `file://`, no funciona).

```bash
python -m http.server 5173
```

Luego abrir http://localhost:5173/.

La URL del backend está en la propiedad `apiBaseUrl` de `index.html`; por defecto, `https://trackflow-mxll.onrender.com`. Para el backend local se cambia a `http://localhost:8080`.

La propiedad `reportsApiBaseUrl` dirige exclusivamente `/api/tracking/**` y
`/api/reports/**` a la API 2 de
[trackflow-reports-api](https://github.com/TrackflowFE/trackflow-reports-api).
Para pruebas locales se configura `http://localhost:8082`; en producción debe
usarse la URL real asignada por Render después de verificar su despliegue.
Mientras quede vacía, esas consultas siguen usando el monolito como respaldo.
Login, sesiones, registro de envíos, eventos, historial y rutas no cambian de
destino en esta rama. El mismo token de API 1 se envía a los reportes protegidos.
Antes de consultar un reporte protegido, el navegador valida y renueva la
actividad mediante `/api/auth/sesion` en API 1; API 2 solo lee las sesiones.

El plan gratuito de Render duerme el servicio: la primera consulta puede tardar cerca de un minuto, y la página lo indica mientras espera.

## Comportamiento destacado

- **Contrato en inglés** del backend (`sender`, `recipient`, `type`, `centerId`, `movements`…).
- **Sesión (HU-08):** el token solo viaja en las peticiones protegidas; cualquier 401 lleva al login con el aviso "Sesión terminada" (sesión cerrada o inactiva más de 30 min); cerrar sesión la invalida en el servidor y borra de la pantalla los datos de la operación.
- **Idempotencia:** el registro de eventos envía `Idempotency-Key`; si falla por red y se reintenta, el backend no duplica el movimiento.
- **Validación en el navegador** antes de llamar al backend (campos obligatorios, formato de guía, fechas), y los errores del backend se muestran con su `detail`.

## Publicarlo

Si se publica (por ejemplo con GitHub Pages), el dominio debe agregarse a la variable `TRACKFLOW_CORS_ORIGINS` del servicio en Render; si no, el navegador bloqueará las llamadas a la API.
