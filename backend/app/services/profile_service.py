from __future__ import annotations

import base64
import binascii
import io
import json
import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from PIL import Image, ImageOps, UnidentifiedImageError

from app.config import get_settings
from app.database.database import connection
from app.profile_schemas import UpdateProfileRequest
from app.security import create_access_token, create_refresh_token, hash_refresh_token
from app.services.auth_service import _user_payload


class ProfileError(ValueError):
    pass


class ProfileConflictError(ProfileError):
    pass


def _write_avatar(data: str, directory: Path) -> tuple[str, Path]:
    prefix, separator, encoded = data.partition(",")
    formats = {"data:image/png;base64": "PNG", "data:image/jpeg;base64": "JPEG", "data:image/webp;base64": "WEBP"}
    if not separator or prefix not in formats:
        raise ProfileError("Vui lòng chọn ảnh JPG, PNG hoặc WebP")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ProfileError("Dữ liệu ảnh không hợp lệ") from exc
    if not raw or len(raw) > 5 * 1024 * 1024:
        raise ProfileError("Ảnh đại diện phải có dung lượng lớn hơn 0 và không quá 5 MB")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as image:
                if image.format != formats[prefix] or image.width * image.height > 16_000_000:
                    raise ProfileError("Ảnh không hợp lệ hoặc có kích thước quá lớn")
                image.seek(0)
                image = ImageOps.exif_transpose(image)
                image.thumbnail((512, 512))
                converted = image.convert("RGBA")
                output = io.BytesIO()
                converted.save(output, format="PNG", optimize=True)
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ProfileError("Không đọc được ảnh đại diện. Vui lòng chọn ảnh khác") from exc
    directory.mkdir(parents=True, exist_ok=True)
    filename = uuid4().hex + ".png"
    path = directory / filename
    path.write_bytes(output.getvalue())
    return "/avatars/" + filename, path


def update_profile(user_id: UUID | str, body: UpdateProfileRequest) -> dict[str, Any]:
    # Identity comes exclusively from current_user; no client-supplied user ID.
    new_file: Path | None = None
    avatar_url: str | None = None
    try:
        if body.avatar_data is not None:
            avatar_url, new_file = _write_avatar(body.avatar_data, get_settings().avatar_storage_dir)
        profile_preferences = json.dumps({
            "birthday": body.birthday.isoformat() if body.birthday else None,
            "gender": body.gender,
            "bio": body.bio,
        }, ensure_ascii=False)
        with connection() as conn:
            row = conn.execute(
                """
                UPDATE safety.users
                SET full_name=%s, username=%s, phone=%s, department=%s, job_title=%s,
                    preferences=jsonb_set(COALESCE(preferences, '{}'::jsonb), '{profile}', %s::jsonb, true),
                    avatar_url=CASE WHEN %s THEN %s ELSE avatar_url END,
                    updated_at=now()
                WHERE id=%s AND deleted_at IS NULL AND status='active'
                RETURNING id
                """,
                (body.full_name, body.username, body.phone, body.department, body.job_title,
                 profile_preferences, body.avatar_data is not None or body.remove_avatar, avatar_url, user_id),
            ).fetchone()
            if not row:
                raise ProfileError("Tài khoản không còn hoạt động")
            result = _user_payload(conn, user_id)
            if result is None:
                raise ProfileError("Không tìm thấy tài khoản")
        return result
    except Exception as exc:
        if new_file is not None:
            new_file.unlink(missing_ok=True)
        if getattr(exc, "sqlstate", None) == "23505":
            raise ProfileConflictError("Tên tài khoản này đã được sử dụng") from exc
        raise


def change_password(
    user_id: UUID | str,
    current_password: str,
    new_password: str,
    ip_address: str | None,
    user_agent: str | None,
) -> dict[str, Any]:
    settings = get_settings()
    try:
        with connection() as conn:
            # This database function verifies the old password, hashes the new
            # password and revokes refresh sessions in one transaction.
            conn.execute("SELECT safety.change_password(%s, %s, %s)", (user_id, current_password, new_password))
            refresh_token = create_refresh_token()
            conn.execute(
                "SELECT safety.create_session(%s, %s, %s, %s, %s, %s)",
                (user_id, hash_refresh_token(refresh_token),
                 datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_days),
                 ip_address, user_agent, None),
            )
            user = _user_payload(conn, user_id)
            if user is None:
                raise ProfileError("Không tìm thấy tài khoản")
            access_token, expires_in = create_access_token(str(user_id), settings)
        return {"access_token": access_token, "refresh_token": refresh_token,
                "expires_in": expires_in, "user": user}
    except Exception as exc:
        message = str(exc).split("\n", 1)[0]
        if "Mat khau hien tai khong dung" in message:
            raise ProfileError("Mật khẩu hiện tại không chính xác") from exc
        if "Mat khau moi" in message:
            raise ProfileError("Mật khẩu mới phải có ít nhất 8 ký tự") from exc
        raise
