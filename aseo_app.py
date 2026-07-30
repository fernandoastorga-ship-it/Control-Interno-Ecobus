from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import DateTime, Integer, Text, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from auth import require_login
from database import Base, engine, get_db

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "aseo_static"


class AseoState(Base):
    __tablename__ = "aseo_app_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    data: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


Base.metadata.create_all(engine)

app = FastAPI(title="Inventario y Aseo Ecobus", docs_url="/docs", redoc_url=None)


@app.get("/")
def home(request: Request):
    if not request.session.get("authenticated"):
        return RedirectResponse("/login", status_code=303)
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/state", dependencies=[Depends(require_login)])
def read_state(db: Session = Depends(get_db)):
    row = db.get(AseoState, 1)
    if row is None:
        return None
    try:
        return json.loads(row.data)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail="La información guardada está dañada") from exc


@app.put("/api/state", dependencies=[Depends(require_login)])
def save_state(payload: dict, db: Session = Depends(get_db)):
    required = ("productos", "conductores", "movimientos")
    if any(not isinstance(payload.get(key), list) for key in required):
        raise HTTPException(status_code=422, detail="Formato de datos inválido")

    serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    row = db.get(AseoState, 1)
    if row is None:
        row = AseoState(id=1, data=serialized)
        db.add(row)
    else:
        row.data = serialized
        row.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return {"ok": True, "updated_at": row.updated_at.isoformat()}


@app.get("/health")
def health(db: Session = Depends(get_db)):
    db.execute(select(1))
    return {"status": "ok", "module": "aseo"}
