from __future__ import annotations

import base64
import binascii
import logging
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import DateTime, ForeignKey, Integer, JSON, LargeBinary, String, create_engine, func, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("compras_agiles")

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "compras_static"

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./control_interno_ecobus.db")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+psycopg://", 1)
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+psycopg://", 1)

IS_SQLITE = DATABASE_URL.startswith("sqlite")
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=not IS_SQLITE,
    connect_args={"check_same_thread": False} if IS_SQLITE else {},
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

MAX_FILE_BYTES = int(os.getenv("MAX_FILE_BYTES", str(10 * 1024 * 1024)))
MAX_PURCHASE_FILES_BYTES = int(os.getenv("MAX_PURCHASE_FILES_BYTES", str(30 * 1024 * 1024)))
APP_PASSWORD = os.getenv("APP_PASSWORD", "cambiar-esta-clave")
SECRET_KEY = os.getenv("SECRET_KEY", secrets.token_urlsafe(32))


class Base(DeclarativeBase):
    pass


class Profile(Base):
    __tablename__ = "compras_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    purchases: Mapped[list["Purchase"]] = relationship(
        back_populates="profile", cascade="all, delete-orphan"
    )


class Purchase(Base):
    __tablename__ = "compras_purchases"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    profile_id: Mapped[int] = mapped_column(ForeignKey("compras_profiles.id", ondelete="CASCADE"), index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    profile: Mapped[Profile] = relationship(back_populates="purchases")
    attachments: Mapped[list["Attachment"]] = relationship(
        back_populates="purchase", cascade="all, delete-orphan"
    )


class Attachment(Base):
    __tablename__ = "compras_attachments"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    purchase_id: Mapped[str] = mapped_column(
        ForeignKey("compras_purchases.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(500), nullable=False)
    content_type: Mapped[str] = mapped_column(String(255), nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    data: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)

    purchase: Mapped[Purchase] = relationship(back_populates="attachments")


class ProfileCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class AttachmentInput(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(default_factory=lambda: str(uuid4()), max_length=64)
    nombre: str = Field(max_length=500)
    tipo: str = Field(default="application/octet-stream", max_length=255)
    size: int = Field(default=0, ge=0)
    fechaCarga: str | None = None
    dataUrl: str | None = None


class PurchaseInput(BaseModel):
    model_config = ConfigDict(extra="allow")

    idInterno: str = Field(min_length=1, max_length=64)
    archivos: list[AttachmentInput] = Field(default_factory=list)


class ImportPayload(BaseModel):
    profile: str = Field(min_length=1, max_length=120)
    compras: list[dict[str, Any]]


app = FastAPI(title="Compras Ágiles", docs_url="/docs", redoc_url=None)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# Los eventos startup de una subaplicación montada no siempre se ejecutan.
# Creamos y sembramos las tablas al importar el módulo para asegurar su disponibilidad.
Base.metadata.create_all(bind=engine)
with SessionLocal() as _seed_db:
    for _name in ("Fernando", "Patricio"):
        if not _seed_db.scalar(select(Profile).where(Profile.name == _name)):
            _seed_db.add(Profile(name=_name))
    _seed_db.commit()


@app.on_event("startup")
def startup() -> None:
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        for name in ("Fernando", "Patricio"):
            if not db.scalar(select(Profile).where(Profile.name == name)):
                db.add(Profile(name=name))
        db.commit()
    if APP_PASSWORD == "cambiar-esta-clave":
        logger.warning("APP_PASSWORD usa el valor predeterminado. Configúralo antes de publicar.")
    if IS_SQLITE:
        logger.warning("Usando SQLite local. En producción debes configurar DATABASE_URL con PostgreSQL.")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def require_auth(request: Request) -> None:
    if not request.session.get("authenticated"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sesión no válida")


def get_or_create_profile(db: Session, name: str) -> Profile:
    clean_name = name.strip()
    if not clean_name:
        raise HTTPException(status_code=400, detail="El perfil no puede estar vacío")
    profile = db.scalar(select(Profile).where(Profile.name == clean_name))
    if profile:
        return profile
    profile = Profile(name=clean_name)
    db.add(profile)
    db.flush()
    return profile


def attachment_to_dict(attachment: Attachment) -> dict[str, Any]:
    uploaded = attachment.uploaded_at
    if uploaded.tzinfo is None:
        uploaded = uploaded.replace(tzinfo=timezone.utc)
    return {
        "id": attachment.id,
        "nombre": attachment.name,
        "tipo": attachment.content_type,
        "size": attachment.size,
        "fechaCarga": uploaded.isoformat(),
        "downloadUrl": f"/compras/api/attachments/{quote(attachment.id)}",
    }


def purchase_to_dict(purchase: Purchase) -> dict[str, Any]:
    result = dict(purchase.payload or {})
    result["idInterno"] = purchase.id
    result["archivos"] = [
        attachment_to_dict(item)
        for item in sorted(purchase.attachments, key=lambda a: a.uploaded_at)
    ]
    return result


def parse_data_url(data_url: str) -> tuple[str, bytes]:
    if not data_url.startswith("data:") or ";base64," not in data_url:
        raise HTTPException(status_code=400, detail="Formato de archivo adjunto inválido")
    header, encoded = data_url.split(",", 1)
    content_type = header[5:].split(";", 1)[0] or "application/octet-stream"
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Archivo adjunto corrupto") from exc
    return content_type, raw


def upsert_purchase(db: Session, profile: Profile, data: PurchaseInput) -> Purchase:
    purchase = db.get(Purchase, data.idInterno)
    if purchase and purchase.profile_id != profile.id:
        raise HTTPException(status_code=409, detail="El identificador pertenece a otro perfil")
    if not purchase:
        purchase = Purchase(id=data.idInterno, profile_id=profile.id, payload={})
        db.add(purchase)
        db.flush()

    payload = data.model_dump(exclude={"archivos"})
    payload.pop("idInterno", None)
    for key, value in (data.model_extra or {}).items():
        if key not in {"archivos", "idInterno"}:
            payload[key] = value
    purchase.payload = payload
    purchase.updated_at = datetime.now(timezone.utc)

    current = {item.id: item for item in purchase.attachments}
    incoming_ids = {item.id for item in data.archivos}
    for attachment_id, attachment in list(current.items()):
        if attachment_id not in incoming_ids:
            db.delete(attachment)

    total_bytes = 0
    for item in data.archivos:
        if item.id in current and not item.dataUrl:
            total_bytes += current[item.id].size
            continue
        if not item.dataUrl:
            raise HTTPException(
                status_code=400,
                detail=f"Faltan los datos del archivo nuevo: {item.nombre}",
            )
        detected_type, raw = parse_data_url(item.dataUrl)
        if len(raw) > MAX_FILE_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"El archivo {item.nombre} supera el máximo permitido",
            )
        total_bytes += len(raw)
        if total_bytes > MAX_PURCHASE_FILES_BYTES:
            raise HTTPException(
                status_code=413,
                detail="Los adjuntos de la compra superan el máximo total permitido",
            )
        uploaded_at = datetime.now(timezone.utc)
        if item.fechaCarga:
            try:
                uploaded_at = datetime.fromisoformat(item.fechaCarga.replace("Z", "+00:00"))
            except ValueError:
                pass
        attachment = current.get(item.id)
        if attachment:
            attachment.name = item.nombre
            attachment.content_type = item.tipo or detected_type
            attachment.size = len(raw)
            attachment.uploaded_at = uploaded_at
            attachment.data = raw
        else:
            db.add(
                Attachment(
                    id=item.id,
                    purchase_id=purchase.id,
                    name=item.nombre,
                    content_type=item.tipo or detected_type,
                    size=len(raw),
                    uploaded_at=uploaded_at,
                    data=raw,
                )
            )

    return purchase


LOGIN_HTML = """<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Acceso | Compras Ágiles</title><style>
*{box-sizing:border-box}body{margin:0;font-family:Inter,Arial,sans-serif;background:#f4f7fb;color:#1f2937;min-height:100vh;display:grid;place-items:center}
.card{width:min(420px,92vw);background:white;border-radius:18px;padding:32px;box-shadow:0 18px 50px rgba(15,23,42,.12)}
.icon{font-size:42px}h1{margin:12px 0 8px;font-size:26px}p{color:#64748b;line-height:1.5}label{display:block;font-weight:700;margin:22px 0 8px}
input{width:100%;padding:13px 14px;border:1px solid #cbd5e1;border-radius:10px;font-size:16px}button{width:100%;margin-top:18px;padding:13px;border:0;border-radius:10px;background:#1769aa;color:white;font-weight:800;font-size:16px;cursor:pointer}.error{background:#fee2e2;color:#991b1b;padding:10px;border-radius:9px}
</style></head><body><main class="card"><div class="icon">🛒</div><h1>Compras Ágiles</h1><p>Ingresa la contraseña del sistema para acceder a la información almacenada en la nube.</p>{error}<form method="post"><label>Contraseña</label><input type="password" name="password" autofocus required><button type="submit">Ingresar</button></form></main></body></html>"""


@app.get("/login")
def login_page():
    return RedirectResponse("/login", status_code=303)


@app.post("/login")
def login_submit():
    return RedirectResponse("/login", status_code=303)


@app.get("/logout")
def logout():
    return RedirectResponse("/logout", status_code=303)


@app.get("/health")
def health():
    return {"status": "ok", "database": "sqlite" if IS_SQLITE else "postgresql"}


@app.get("/")
def index(request: Request):
    if not request.session.get("authenticated"):
        return RedirectResponse("/login", status_code=303)
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/profiles", dependencies=[Depends(require_auth)])
def list_profiles(db: Session = Depends(get_db)):
    profiles = db.scalars(select(Profile).order_by(Profile.created_at, Profile.name)).all()
    result = []
    for profile in profiles:
        purchases = db.scalars(select(Purchase).where(Purchase.profile_id == profile.id)).all()
        pending = sum(
            1
            for purchase in purchases
            if purchase.payload.get("estado") == "GANADA" and not purchase.payload.get("fechaPago")
        )
        result.append({"name": profile.name, "count": len(purchases), "pending": pending})
    return result


@app.post("/api/profiles", dependencies=[Depends(require_auth)])
def create_profile(payload: ProfileCreate, db: Session = Depends(get_db)):
    profile = get_or_create_profile(db, payload.name)
    db.commit()
    return {"name": profile.name}


@app.get("/api/profiles/{profile_name}/purchases", dependencies=[Depends(require_auth)])
def list_purchases(profile_name: str, db: Session = Depends(get_db)):
    profile = db.scalar(select(Profile).where(Profile.name == profile_name))
    if not profile:
        return []
    purchases = db.scalars(
        select(Purchase)
        .where(Purchase.profile_id == profile.id)
        .order_by(Purchase.created_at.desc())
    ).all()
    return [purchase_to_dict(item) for item in purchases]


@app.put("/api/profiles/{profile_name}/purchases/{purchase_id}", dependencies=[Depends(require_auth)])
def save_purchase(
    profile_name: str,
    purchase_id: str,
    payload: PurchaseInput,
    db: Session = Depends(get_db),
):
    if payload.idInterno != purchase_id:
        raise HTTPException(status_code=400, detail="Identificador inconsistente")
    profile = get_or_create_profile(db, profile_name)
    purchase = upsert_purchase(db, profile, payload)
    db.commit()
    db.refresh(purchase)
    return purchase_to_dict(purchase)


@app.delete("/api/profiles/{profile_name}/purchases/{purchase_id}", dependencies=[Depends(require_auth)])
def delete_purchase(profile_name: str, purchase_id: str, db: Session = Depends(get_db)):
    profile = db.scalar(select(Profile).where(Profile.name == profile_name))
    purchase = db.get(Purchase, purchase_id)
    if not profile or not purchase or purchase.profile_id != profile.id:
        raise HTTPException(status_code=404, detail="Compra no encontrada")
    db.delete(purchase)
    db.commit()
    return {"deleted": True}


@app.delete("/api/profiles/{profile_name}/purchases", dependencies=[Depends(require_auth)])
def clear_profile(profile_name: str, db: Session = Depends(get_db)):
    profile = db.scalar(select(Profile).where(Profile.name == profile_name))
    if not profile:
        return {"deleted": 0}
    purchases = db.scalars(select(Purchase).where(Purchase.profile_id == profile.id)).all()
    count = len(purchases)
    for purchase in purchases:
        db.delete(purchase)
    db.commit()
    return {"deleted": count}


@app.get("/api/attachments/{attachment_id}", dependencies=[Depends(require_auth)])
def download_attachment(attachment_id: str, db: Session = Depends(get_db)):
    attachment = db.get(Attachment, attachment_id)
    if not attachment:
        raise HTTPException(status_code=404, detail="Archivo no encontrado")
    safe_name = attachment.name.replace("\r", "").replace("\n", "")
    headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(safe_name)}"}
    return Response(content=attachment.data, media_type=attachment.content_type, headers=headers)


@app.post("/api/import", dependencies=[Depends(require_auth)])
def import_backup(payload: ImportPayload, db: Session = Depends(get_db)):
    profile = get_or_create_profile(db, payload.profile)
    imported = 0
    for raw in payload.compras:
        try:
            purchase_data = PurchaseInput.model_validate(raw)
            upsert_purchase(db, profile, purchase_data)
            imported += 1
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(
                status_code=400,
                detail=f"No se pudo importar una compra: {exc}",
            ) from exc
    db.commit()
    return {"imported": imported, "profile": profile.name}


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    if "/api/" in request.url.path:
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
    return HTMLResponse(str(exc.detail), status_code=exc.status_code)
