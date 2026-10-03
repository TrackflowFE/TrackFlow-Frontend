# TrackFlow · Frontend

Prototipo funcional del frontend de TrackFlow (Fábrica Escuela, UdeA 2026-2). Consume la API real del backend del equipo, sin datos simulados.

- **Backend:** [TrackflowFE/FabricaEscuela-Proyecto-TrackFlow](https://github.com/TrackflowFE/FabricaEscuela-Proyecto-TrackFlow)
- **API desplegada:** https://trackflow-mxll.onrender.com ([Swagger](https://trackflow-mxll.onrender.com/swagger-ui/index.html))
- **Especificación:** [`TrackFlow Especificación.dc.html`](TrackFlow%20Especificaci%C3%B3n.dc.html): pantallas, contrato consumido y estados diseñados.

## Pantallas

| Pantalla | Acceso | Historia |
|---|---|---|
| Rastrear envío: estado, pasos y línea de tiempo | Público | HU-03, HU-04 |
| Registrar envío | Operador | HU-01 |
| Registrar evento logístico | Operador | HU-02 |
| Volumen de envíos por periodo y punto de ingreso | Operador | HU-07 |
| Ingresar / cerrar sesión | Público | HU-08 |
| Reconstruir proyecciones | Administrador | — |

## Cómo ejecutarlo

Es un sitio estático: no requiere compilación. Debe servirse desde `http://localhost:5173`, que es el origen permitido por CORS en el backend (abrirlo con doble clic, como `file://`, no funciona).

```bash
python -m http.server 5173
```

Luego abrir http://localhost:5173/ (redirige a `TrackFlow.dc.html`).

La URL del backend está en la propiedad `apiBaseUrl` de `TrackFlow.dc.html`; por defecto, `https://trackflow-mxll.onrender.com`. Para el backend local se cambia a `http://localhost:8080`.

El plan gratuito de Render duerme el servicio: la primera consulta puede tardar cerca de un minuto, y la página lo indica mientras espera.

## Comportamiento destacado

- **Contrato en inglés** del backend (`sender`, `recipient`, `type`, `centerId`, `movements`…).
- **Sesión (HU-08):** el token solo viaja en las peticiones protegidas; cualquier 401 lleva al login con el aviso "Sesión terminada" (sesión cerrada o inactiva más de 30 min); cerrar sesión la invalida en el servidor y borra de la pantalla los datos de la operación.
- **Idempotencia:** el registro de eventos envía `Idempotency-Key`; si falla por red y se reintenta, el backend no duplica el movimiento.
- **Validación en el navegador** antes de llamar al backend (campos obligatorios, formato de guía, fechas), y los errores del backend se muestran con su `detail`.

## Publicarlo

Si se publica (por ejemplo con GitHub Pages), el dominio debe agregarse a la variable `TRACKFLOW_CORS_ORIGINS` del servicio en Render; si no, el navegador bloqueará las llamadas a la API.
