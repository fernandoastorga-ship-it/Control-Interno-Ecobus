from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import quote

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.middleware.sessions import SessionMiddleware

from auth import authenticate, require_login, seed_admin
from database import Base, IS_SQLITE, engine, get_db
from models import StoredImport

BASE_DIR = Path(__file__).resolve().parent
PORTAL_DIR = BASE_DIR / "portal_static"
SECRET_KEY = os.getenv("SECRET_KEY", "clave-local-solo-desarrollo-cambiar")
MAX_IMPORT_BYTES = int(os.getenv("MAX_IMPORT_BYTES", str(30 * 1024 * 1024)))

Base.metadata.create_all(engine)

app = FastAPI(title="Control Interno Ecobus", version="1.0.0", docs_url="/docs")
app.add_middleware(
    SessionMiddleware,
    secret_key=SECRET_KEY,
    same_site="lax",
    https_only=os.getenv("RENDER", "").lower() == "true",
    max_age=60 * 60 * 12,
)
app.mount("/static", StaticFiles(directory=PORTAL_DIR), name="portal-static")

LOGIN_HTML = """<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ingreso | Control Interno Ecobus</title><style>
:root{--green:#0d6b3a;--dark:#102f23;--lime:#b7f34a;--bg:#eef3f0;--muted:#6b766f}*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:Inter,Arial,sans-serif;background:linear-gradient(135deg,#eff6f2,#dcebe2);display:grid;place-items:center;color:#17251d}.shell{width:min(970px,94vw);min-height:560px;background:#fff;border-radius:25px;overflow:hidden;display:grid;grid-template-columns:1.08fr .92fr;box-shadow:0 25px 70px #15352525}.visual{background:linear-gradient(145deg,#0b5a31,#11914d);position:relative;padding:50px;color:#fff;display:flex;flex-direction:column;justify-content:space-between}.visual:before{content:'';position:absolute;inset:0;background:url('/static/img/hero-ecobus.svg') center/cover;opacity:.42}.visual>*{position:relative}.visual img{width:190px;max-height:75px;object-fit:contain}.visual h1{font-size:45px;line-height:1.05;margin:0 0 15px}.visual p{font-size:16px;line-height:1.55;opacity:.85}.tag{color:var(--lime);font-size:11px;font-weight:900;letter-spacing:.17em}.form{padding:68px 55px;display:flex;flex-direction:column;justify-content:center}.form h2{font-size:29px;margin:0 0 8px}.form>p{color:var(--muted);line-height:1.5;margin:0 0 26px}.form label{font-size:13px;font-weight:900;margin-top:15px}.form input{width:100%;padding:13px;border:1px solid #cbd8d0;border-radius:10px;margin-top:7px;font-size:15px}.form button{margin-top:22px;background:var(--green);color:#fff;border:0;border-radius:10px;padding:13px;font-size:15px;font-weight:900;cursor:pointer}.error{background:#fee4e2;color:#a51d16;padding:11px;border-radius:9px;font-size:13px;margin-bottom:10px}.hint{font-size:11px!important;margin-top:18px!important}@media(max-width:760px){.shell{grid-template-columns:1fr}.visual{min-height:240px;padding:28px}.visual h1{font-size:35px}.form{padding:35px 28px}}
</style></head><body><main class="shell"><section class="visual"><img src="/static/img/ecobus-logo.png" alt="Ecobus"><div><span class="tag">PLATAFORMA EMPRESARIAL</span><h1>Control Interno Ecobus</h1><p>Compras Ágiles, inventario y pricing en un solo portal empresarial.</p></div></section><form class="form" method="post" action="/login"><h2>Bienvenido</h2><p>Ingresa con tu usuario para acceder a los módulos autorizados.</p>{error}<label>Usuario<input name="username" autocomplete="username" required autofocus></label><label>Contraseña<input type="password" name="password" autocomplete="current-password" required></label><button>Ingresar al sistema</button><p class="hint">El usuario inicial se configura mediante ADMIN_USERNAME y ADMIN_PASSWORD en Render.</p></form></main></body></html>"""


@app.on_event("startup")
def startup() -> None:
    seed_admin()


@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    if request.session.get("authenticated"):
        return RedirectResponse("/", status_code=303)
    return LOGIN_HTML.replace("{error}", "")


@app.post("/login", response_class=HTMLResponse)
def login_submit(request: Request, username: str = Form(...), password: str = Form(...)):
    user = authenticate(username, password)
    if not user:
        return HTMLResponse(
            LOGIN_HTML.replace("{error}", '<div class="error">Usuario o contraseña incorrectos.</div>'),
            status_code=401,
        )
    request.session.update(
        {
            "authenticated": True,
            "user_id": user.id,
            "username": user.username,
            "display_name": user.display_name,
            "role": user.role,
        }
    )
    return RedirectResponse("/", status_code=303)


@app.get("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login", status_code=303)


@app.get("/")
def portal(request: Request):
    if not request.session.get("authenticated"):
        return RedirectResponse("/login", status_code=303)
    return FileResponse(PORTAL_DIR / "index.html")


@app.get("/importaciones")
def imports_page(request: Request):
    if not request.session.get("authenticated"):
        return RedirectResponse("/login", status_code=303)
    return FileResponse(PORTAL_DIR / "importaciones.html")


@app.get("/api/me", dependencies=[Depends(require_login)])
def me(request: Request):
    return {
        "id": request.session.get("user_id"),
        "username": request.session.get("username"),
        "display_name": request.session.get("display_name"),
        "role": request.session.get("role"),
    }


@app.get("/api/imports", dependencies=[Depends(require_login)])
def list_imports(db: Session = Depends(get_db)):
    rows = db.scalars(select(StoredImport).order_by(StoredImport.uploaded_at.desc())).all()
    return [
        {
            "id": row.id,
            "module": row.module,
            "filename": row.filename,
            "content_type": row.content_type,
            "size": row.size,
            "status": row.status,
            "notes": row.notes,
            "uploaded_by": row.uploaded_by,
            "uploaded_at": row.uploaded_at.isoformat(),
        }
        for row in rows
    ]


@app.post("/api/imports", dependencies=[Depends(require_login)])
async def upload_import(
    request: Request,
    module: str = Form(...),
    notes: str = Form(""),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    allowed_modules = {"aseo", "compras", "pricing", "general"}
    if module not in allowed_modules:
        raise HTTPException(status_code=422, detail="Módulo inválido")
    data = await file.read(MAX_IMPORT_BYTES + 1)
    if len(data) > MAX_IMPORT_BYTES:
        raise HTTPException(status_code=413, detail="El archivo supera el límite permitido de 30 MB")
    if not data:
        raise HTTPException(status_code=422, detail="El archivo está vacío")
    row = StoredImport(
        module=module,
        filename=(file.filename or "respaldo").replace("\r", "").replace("\n", ""),
        content_type=file.content_type or "application/octet-stream",
        size=len(data),
        status="PENDIENTE",
        notes=notes.strip(),
        data=data,
        uploaded_by=request.session.get("display_name") or request.session.get("username") or "admin",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"ok": True, "id": row.id}


@app.get("/api/imports/{import_id}/download", dependencies=[Depends(require_login)])
def download_import(import_id: int, db: Session = Depends(get_db)):
    row = db.get(StoredImport, import_id)
    if not row:
        raise HTTPException(status_code=404, detail="Archivo no encontrado")
    headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(row.filename)}"}
    return Response(content=row.data, media_type=row.content_type, headers=headers)


@app.delete("/api/imports/{import_id}", dependencies=[Depends(require_login)])
def delete_import(import_id: int, db: Session = Depends(get_db)):
    row = db.get(StoredImport, import_id)
    if not row:
        raise HTTPException(status_code=404, detail="Archivo no encontrado")
    db.delete(row)
    db.commit()
    return {"deleted": True}


@app.get("/health")
def health():
    return {"status": "ok", "application": "Control Interno Ecobus", "database": "sqlite" if IS_SQLITE else "postgresql"}


# Los módulos se montan al final para conservar sus rutas independientes dentro de un solo servicio.
from aseo_app import app as aseo_app  # noqa: E402
from compras_app import app as compras_app  # noqa: E402
from pricing_app import app as pricing_app  # noqa: E402

app.mount("/aseo", aseo_app)
app.mount("/compras", compras_app)
app.mount("/pricing", pricing_app)

