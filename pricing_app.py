from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import DateTime, JSON, String, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from auth import require_login
from database import Base, engine, get_db

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "pricing_static"


class PricingQuote(Base):
    __tablename__ = "pricing_cotizaciones"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    created_by: Mapped[str] = mapped_column(String(120), default="admin", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


Base.metadata.create_all(engine)


class QuoteInput(BaseModel):
    id: str | None = Field(default=None, max_length=64)
    data: dict[str, Any]


class ImportInput(BaseModel):
    cotizaciones: list[dict[str, Any]]


app = FastAPI(title="Calculadora de Pricing Ecobus", docs_url="/docs", redoc_url=None)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")


def quote_to_dict(row: PricingQuote) -> dict[str, Any]:
    result = dict(row.payload or {})
    result.update(
        {
            "id": row.id,
            "createdBy": row.created_by,
            "createdAt": row.created_at.isoformat(),
            "updatedAt": row.updated_at.isoformat(),
        }
    )
    return result


@app.get("/")
def index(request: Request):
    if not request.session.get("authenticated"):
        return RedirectResponse("/login", status_code=303)
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/config.js", dependencies=[Depends(require_login)])
def config_js():
    config = {"MAPBOX_TOKEN": os.getenv("MAPBOX_TOKEN", "")}
    return Response(
        content=f"window.ECOBUS_CONFIG = {json.dumps(config)};",
        media_type="application/javascript",
    )


@app.get("/api/quotes", dependencies=[Depends(require_login)])
def list_quotes(db: Session = Depends(get_db)):
    rows = db.scalars(select(PricingQuote).order_by(PricingQuote.created_at.desc())).all()
    return [quote_to_dict(row) for row in rows]


@app.post("/api/quotes", dependencies=[Depends(require_login)])
def create_quote(payload: QuoteInput, request: Request, db: Session = Depends(get_db)):
    quote_id = payload.id or f"COT-{uuid4().hex[:12].upper()}"
    if db.get(PricingQuote, quote_id):
        raise HTTPException(status_code=409, detail="La cotización ya existe")
    row = PricingQuote(
        id=quote_id,
        payload=payload.data,
        created_by=request.session.get("display_name") or request.session.get("username") or "admin",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return quote_to_dict(row)


@app.put("/api/quotes/{quote_id}", dependencies=[Depends(require_login)])
def update_quote(quote_id: str, payload: QuoteInput, db: Session = Depends(get_db)):
    row = db.get(PricingQuote, quote_id)
    if not row:
        raise HTTPException(status_code=404, detail="Cotización no encontrada")
    row.payload = payload.data
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return quote_to_dict(row)


@app.delete("/api/quotes/{quote_id}", dependencies=[Depends(require_login)])
def delete_quote(quote_id: str, db: Session = Depends(get_db)):
    row = db.get(PricingQuote, quote_id)
    if not row:
        raise HTTPException(status_code=404, detail="Cotización no encontrada")
    db.delete(row)
    db.commit()
    return {"deleted": True}


@app.post("/api/import", dependencies=[Depends(require_login)])
def import_quotes(payload: ImportInput, request: Request, db: Session = Depends(get_db)):
    imported = 0
    updated = 0
    username = request.session.get("display_name") or request.session.get("username") or "admin"
    for item in payload.cotizaciones:
        quote_id = str(item.get("id") or f"COT-{uuid4().hex[:12].upper()}")
        cleaned = {k: v for k, v in item.items() if k not in {"id", "createdAt", "updatedAt", "createdBy"}}
        row = db.get(PricingQuote, quote_id)
        if row:
            row.payload = cleaned
            row.updated_at = datetime.now(timezone.utc)
            updated += 1
        else:
            db.add(PricingQuote(id=quote_id, payload=cleaned, created_by=username))
            imported += 1
    db.commit()
    return {"imported": imported, "updated": updated}


@app.get("/health")
def health():
    return {"status": "ok", "module": "pricing"}
