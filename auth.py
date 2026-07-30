from __future__ import annotations

import base64
import hashlib
import hmac
import os
from typing import Any

from fastapi import HTTPException, Request
from sqlalchemy import select

from database import SessionLocal
from models import CoreUser

PBKDF2_ITERATIONS = 390_000


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return "pbkdf2_sha256${}${}${}".format(
        PBKDF2_ITERATIONS,
        base64.urlsafe_b64encode(salt).decode("ascii"),
        base64.urlsafe_b64encode(digest).decode("ascii"),
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations, salt_b64, digest_b64 = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        salt = base64.urlsafe_b64decode(salt_b64.encode("ascii"))
        expected = base64.urlsafe_b64decode(digest_b64.encode("ascii"))
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iterations))
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def seed_admin() -> None:
    username = os.getenv("ADMIN_USERNAME", "admin").strip().lower()
    password = os.getenv("ADMIN_PASSWORD", "cambiar-esta-clave")
    display_name = os.getenv("ADMIN_DISPLAY_NAME", "Administrador Ecobus")

    with SessionLocal() as db:
        existing = db.execute(select(CoreUser).where(CoreUser.username == username)).scalar_one_or_none()
        if existing is None:
            db.add(
                CoreUser(
                    username=username,
                    display_name=display_name,
                    password_hash=hash_password(password),
                    role="admin",
                    is_active=True,
                )
            )
            db.commit()


def authenticate(username: str, password: str) -> CoreUser | None:
    with SessionLocal() as db:
        user = db.execute(
            select(CoreUser).where(CoreUser.username == username.strip().lower())
        ).scalar_one_or_none()
        if not user or not user.is_active or not verify_password(password, user.password_hash):
            return None
        db.expunge(user)
        return user


def require_login(request: Request) -> dict[str, Any]:
    if not request.session.get("authenticated"):
        raise HTTPException(status_code=401, detail="Sesión no iniciada")
    return {
        "id": request.session.get("user_id"),
        "username": request.session.get("username"),
        "display_name": request.session.get("display_name"),
        "role": request.session.get("role"),
    }
