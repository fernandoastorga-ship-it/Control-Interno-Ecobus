# Control Interno Ecobus

Portal empresarial unificado para tres módulos:

1. **Compras Ágiles**
2. **Inventario y Aseo**
3. **Calculadora de Pricing**

El sistema **Administrador La Colonia no forma parte de este proyecto** y debe continuar funcionando en su servicio actual, sin cambios.

## Estructura

```text
/
├── /compras/        Compras Ágiles
├── /aseo/           Inventario y entregas
├── /pricing/        Calculadora e historial de cotizaciones
├── /importaciones   Centro de archivos de respaldo
└── /docs            Documentación de la aplicación principal
```

## Características

- Un solo inicio de sesión.
- Una sola aplicación web en Render.
- Una base PostgreSQL compartida, con tablas separadas por módulo.
- Portal corporativo con identidad Ecobus.
- Importación directa dentro de Aseo, Compras y Pricing.
- Centro general para guardar archivos JSON, CSV, Excel, SQLite, ZIP o backups y procesarlos posteriormente.

## Variables de entorno

```env
DATABASE_URL=
SECRET_KEY=
ADMIN_USERNAME=admin
ADMIN_PASSWORD=
ADMIN_DISPLAY_NAME=Administrador Ecobus
MAPBOX_TOKEN=
```

Variables opcionales para límites de archivos:

```env
MAX_IMPORT_BYTES=31457280
MAX_FILE_BYTES=10485760
MAX_PURCHASE_FILES_BYTES=31457280
```

## Ejecución local

### Windows PowerShell

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:ADMIN_PASSWORD="tu-clave-local"
$env:MAPBOX_TOKEN="tu-token-mapbox"
uvicorn main:app --reload
```

Luego abre:

```text
http://localhost:8000
```

## Despliegue en Render

1. Sube el contenido del proyecto a un repositorio de GitHub.
2. En Render crea un Blueprint usando `render.yaml`.
3. Configura `ADMIN_PASSWORD` y `MAPBOX_TOKEN`.
4. Espera la creación del servicio web y de PostgreSQL.
5. Comprueba `/health` e inicia sesión.

## Importación posterior

Los sistemas pueden comenzar con sus bases limpias.

- **Aseo:** Historial → Importar respaldo JSON.
- **Compras Ágiles:** seleccionar perfil → importar respaldo.
- **Pricing:** importar historial JSON.
- **Centro de Importaciones:** permite almacenar otros respaldos para procesarlos posteriormente.

## Seguridad operacional

No subas al repositorio archivos `.env`, contraseñas, tokens, URLs privadas de bases ni copias con credenciales. El archivo `.gitignore` evita varios de estos archivos, pero siempre debes revisarlos antes de hacer `push`.
