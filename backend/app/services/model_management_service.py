from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import UUID

from app.database.database import connection
from app.model_schemas import ModelDeployRequest
from app.models.registry import registry


class ModelManagementNotFound(ValueError):
    pass


class ModelManagementConflict(ValueError):
    pass


MODEL_METADATA = {
    "RF-DETR": {
        "code": "RF_DETR",
        "framework": "rfdetr + ultralytics",
        "labels": [
            "Person", "Helmet", "Vest", "Gloves", "Goggles", "Mask",
            "Safety shoe", "Suspected no helmet", "Suspected no vest",
        ],
    },
    "VideoMAE": {
        "code": "VIDEOMAE",
        "framework": "PyTorch + Transformers",
        "labels": [
            "Safe Walkway Violation", "Unauthorized Intervention",
            "Opened Panel Cover", "Carrying Overload with Forklift",
            "Safe Walkway", "Authorized Intervention", "Closed Panel Cover",
            "Safe Carrying",
        ],
    },
}


def _organizations(user: dict[str, Any]) -> list[UUID]:
    return [item["organization_id"] for item in user.get("memberships", [])]


def _primary_organization(user: dict[str, Any]) -> UUID:
    memberships = user.get("memberships", [])
    if not memberships:
        raise ModelManagementConflict("Tài khoản chưa thuộc tổ chức nào")
    selected = next((item for item in memberships if item.get("is_default")), memberships[0])
    return selected["organization_id"]


def _sync_ai_models(conn: Any) -> None:
    for spec in registry.specs():
        metadata = MODEL_METADATA[spec.name]
        conn.execute(
            """
            INSERT INTO safety.ai_models
              (code,name,version,task_type,framework,artifact_uri,labels,is_active)
            VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,true)
            ON CONFLICT (code,version) DO UPDATE SET
              name=EXCLUDED.name, task_type=EXCLUDED.task_type,
              framework=EXCLUDED.framework, artifact_uri=EXCLUDED.artifact_uri,
              labels=EXCLUDED.labels, is_active=true
            """,
            (
                metadata["code"], spec.name, spec.version, spec.type,
                metadata["framework"], str(spec.weight_path) if spec.weight_path else None,
                json.dumps(metadata["labels"]),
            ),
        )


def _model_stats(conn: Any, model_name: str) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT count(ih.id)::int AS total_runs,
               count(ih.id) FILTER (WHERE ih.status='completed')::int AS completed_runs,
               count(ih.id) FILTER (WHERE ih.status='failed')::int AS failed_runs,
               avg(ih.processing_time) FILTER (WHERE ih.status='completed')::float8
                 AS average_processing_seconds,
               max(ih.created_at) AS last_run_at,
               (SELECT count(*)::int FROM public.detection_results dr
                JOIN public.inference_history x ON x.id=dr.inference_id
                JOIN public.models xm ON xm.id=x.model_id WHERE xm.name=%s) AS detections,
               (SELECT count(*)::int FROM public.detection_results dr
                JOIN public.inference_history x ON x.id=dr.inference_id
                JOIN public.models xm ON xm.id=x.model_id
                WHERE xm.name=%s AND dr.is_violation) AS violations,
               COALESCE(
                 (SELECT avg(dr.confidence)::float8 FROM public.detection_results dr
                  JOIN public.inference_history x ON x.id=dr.inference_id
                  JOIN public.models xm ON xm.id=x.model_id WHERE xm.name=%s),
                 (SELECT avg(p.confidence)::float8 FROM public.predictions p
                  JOIN public.inference_history x ON x.id=p.inference_id
                  JOIN public.models xm ON xm.id=x.model_id WHERE xm.name=%s)
               ) AS average_confidence
        FROM public.inference_history ih
        JOIN public.models m ON m.id=ih.model_id
        WHERE m.name=%s
        """,
        (model_name, model_name, model_name, model_name, model_name),
    ).fetchone()
    return dict(row)


def management_data(user: dict[str, Any]) -> dict[str, Any]:
    organizations = _organizations(user)
    if not organizations:
        raise ModelManagementConflict("Tài khoản chưa thuộc tổ chức nào")
    with connection() as conn:
        _sync_ai_models(conn)
        deployment_rows = conn.execute(
            """
            SELECT md.id,m.code AS model_code,m.name AS model_name,md.camera_id,
                   c.code AS camera_code,c.name AS camera_name,s.name AS site_name,
                   z.name AS zone_name,md.confidence_threshold::float8 AS confidence_threshold,
                   md.is_enabled,md.deployed_at,md.stopped_at
            FROM safety.model_deployments md
            JOIN safety.ai_models m ON m.id=md.model_id
            JOIN safety.cameras c ON c.id=md.camera_id
            JOIN safety.sites s ON s.id=c.site_id
            LEFT JOIN safety.zones z ON z.id=c.zone_id
            WHERE md.organization_id=ANY(%s::uuid[])
            ORDER BY md.is_enabled DESC,md.deployed_at DESC
            """,
            (organizations,),
        ).fetchall()
        camera_rows = conn.execute(
            """
            SELECT c.id,c.code,c.name,s.name AS site_name,z.name AS zone_name,
                   c.status::text AS status
            FROM safety.cameras c JOIN safety.sites s ON s.id=c.site_id
            LEFT JOIN safety.zones z ON z.id=c.zone_id
            WHERE c.organization_id=ANY(%s::uuid[]) AND c.is_active
            ORDER BY s.name,c.code
            """,
            (organizations,),
        ).fetchall()
        recent = conn.execute(
            """
            SELECT ih.id,m.name AS model_name,c.code AS camera_code,ih.status,
                   ih.processing_time::float8 AS processing_time,
                   COALESCE(
                     (SELECT p.class_name FROM public.predictions p
                      WHERE p.inference_id=ih.id ORDER BY p.confidence DESC LIMIT 1),
                     (SELECT d.class_name FROM public.detection_results d
                      WHERE d.inference_id=ih.id ORDER BY d.confidence DESC LIMIT 1)
                   ) AS prediction,
                   COALESCE(
                     (SELECT max(p.confidence)::float8 FROM public.predictions p WHERE p.inference_id=ih.id),
                     (SELECT max(d.confidence)::float8 FROM public.detection_results d WHERE d.inference_id=ih.id)
                   ) AS confidence,ih.created_at
            FROM public.inference_history ih
            JOIN public.models m ON m.id=ih.model_id
            LEFT JOIN safety.cameras c ON c.id=ih.camera_id
            WHERE ih.camera_id IS NULL OR c.organization_id=ANY(%s::uuid[])
            ORDER BY ih.created_at DESC LIMIT 20
            """,
            (organizations,),
        ).fetchall()
        class_metrics = conn.execute(
            """
            WITH values_by_class AS (
              SELECT m.name AS model_name,d.class_name,d.confidence
              FROM public.detection_results d
              JOIN public.inference_history ih ON ih.id=d.inference_id
              JOIN public.models m ON m.id=ih.model_id
              LEFT JOIN safety.cameras c ON c.id=ih.camera_id
              WHERE ih.camera_id IS NULL OR c.organization_id=ANY(%s::uuid[])
              UNION ALL
              SELECT m.name,p.class_name,p.confidence
              FROM public.predictions p
              JOIN public.inference_history ih ON ih.id=p.inference_id
              JOIN public.models m ON m.id=ih.model_id
              LEFT JOIN safety.cameras c ON c.id=ih.camera_id
              WHERE ih.camera_id IS NULL OR c.organization_id=ANY(%s::uuid[])
            )
            SELECT model_name,class_name,count(*)::int AS count,
                   avg(confidence)::float8 AS average_confidence
            FROM values_by_class GROUP BY model_name,class_name
            ORDER BY count DESC LIMIT 16
            """,
            (organizations, organizations),
        ).fetchall()
        daily = conn.execute(
            """
            SELECT to_char(date_trunc('day',ih.created_at),'YYYY-MM-DD') AS day,
                   m.name AS model_name,
                   count(*) FILTER (WHERE ih.status='completed')::int AS completed,
                   count(*) FILTER (WHERE ih.status='failed')::int AS failed,
                   avg(ih.processing_time) FILTER (WHERE ih.status='completed')::float8
                     AS average_processing_seconds
            FROM public.inference_history ih JOIN public.models m ON m.id=ih.model_id
            LEFT JOIN safety.cameras c ON c.id=ih.camera_id
            WHERE ih.created_at>=now()-interval '7 days'
              AND (ih.camera_id IS NULL OR c.organization_id=ANY(%s::uuid[]))
            GROUP BY date_trunc('day',ih.created_at),m.name
            ORDER BY day,model_name
            """,
            (organizations,),
        ).fetchall()

        models = []
        for spec in registry.specs():
            metadata = MODEL_METADATA[spec.name]
            connected, status = spec.connection_status()
            active = [
                row for row in deployment_rows
                if row["model_code"] == metadata["code"] and row["is_enabled"]
            ]
            artifact_size = (
                spec.weight_path.stat().st_size
                if spec.weight_path and spec.weight_path.is_file() else None
            )
            models.append({
                "code": metadata["code"], "name": spec.name, "version": spec.version,
                "type": spec.type, "framework": metadata["framework"],
                "connected": connected, "loaded": registry.is_loaded(spec.name),
                "status": status,
                "artifact_name": spec.weight_path.name if spec.weight_path else None,
                "artifact_size_bytes": artifact_size,
                "labels": metadata["labels"],
                "active_deployments": len(active),
                "camera_coverage": len({row["camera_id"] for row in active}),
                "stats": _model_stats(conn, spec.name),
            })
        summary_row = conn.execute(
            """
            SELECT count(*) FILTER (WHERE ih.created_at>=now()-interval '24 hours')::int AS runs_24h,
                   count(*) FILTER (WHERE ih.created_at>=now()-interval '24 hours'
                                    AND ih.status='failed')::int AS failures_24h,
                   avg(ih.processing_time) FILTER (WHERE ih.created_at>=now()-interval '24 hours'
                                    AND ih.status='completed')::float8 AS average_processing_seconds
            FROM public.inference_history ih
            LEFT JOIN safety.cameras c ON c.id=ih.camera_id
            WHERE ih.camera_id IS NULL OR c.organization_id=ANY(%s::uuid[])
            """,
            (organizations,),
        ).fetchone()
    active_deployments = [row for row in deployment_rows if row["is_enabled"]]
    return {
        "models": models,
        "deployments": [dict(row) for row in deployment_rows],
        "cameras": [dict(row) for row in camera_rows],
        "recent_inferences": [dict(row) for row in recent],
        "class_metrics": [dict(row) for row in class_metrics],
        "daily_metrics": [dict(row) for row in daily],
        "summary": {
            "total_models": len(models),
            "connected_models": sum(1 for item in models if item["connected"]),
            "loaded_models": sum(1 for item in models if item["loaded"]),
            "active_deployments": len(active_deployments),
            "cameras_covered": len({row["camera_id"] for row in active_deployments}),
            **dict(summary_row),
        },
    }


def deploy(model_code: str, body: ModelDeployRequest, user: dict[str, Any]) -> int:
    organization_id = _primary_organization(user)
    camera_ids = list(dict.fromkeys(body.camera_ids))
    with connection() as conn:
        _sync_ai_models(conn)
        model = conn.execute(
            "SELECT id,name FROM safety.ai_models WHERE code=%s AND is_active ORDER BY created_at DESC LIMIT 1",
            (model_code.upper(),),
        ).fetchone()
        if not model:
            raise ModelManagementNotFound("Không tìm thấy mô hình")
        valid = conn.execute(
            "SELECT id FROM safety.cameras WHERE organization_id=%s AND id=ANY(%s::uuid[]) AND is_active",
            (organization_id, camera_ids),
        ).fetchall()
        valid_ids = [row["id"] for row in valid]
        if len(valid_ids) != len(camera_ids):
            raise ModelManagementConflict("Một hoặc nhiều camera không hợp lệ")
        for camera_id in valid_ids:
            conn.execute(
                """
                UPDATE safety.model_deployments SET is_enabled=false,stopped_at=COALESCE(stopped_at,now())
                WHERE organization_id=%s AND camera_id=%s AND model_id=%s AND is_enabled
                """,
                (organization_id, camera_id, model["id"]),
            )
            conn.execute(
                """
                INSERT INTO safety.model_deployments
                  (organization_id,camera_id,model_id,confidence_threshold,is_enabled)
                VALUES (%s,%s,%s,%s,true)
                """,
                (organization_id, camera_id, model["id"], body.confidence_threshold),
            )
        conn.execute(
            """
            INSERT INTO safety.audit_logs
              (organization_id,actor_user_id,action,entity_type,entity_id,new_data)
            VALUES (%s,%s,'model.deploy','ai_model',%s,%s::jsonb)
            """,
            (organization_id,user["id"],str(model["id"]),json.dumps({
                "model_code": model_code.upper(),
                "camera_ids": [str(item) for item in valid_ids],
                "confidence_threshold": body.confidence_threshold,
            })),
        )
    return len(valid_ids)


def set_deployment_status(
    deployment_id: UUID, enabled: bool, user: dict[str, Any]
) -> None:
    organizations = _organizations(user)
    with connection() as conn:
        row = conn.execute(
            """
            SELECT organization_id,model_id,camera_id
            FROM safety.model_deployments
            WHERE id=%s AND organization_id=ANY(%s::uuid[])
            """,
            (deployment_id, organizations),
        ).fetchone()
        if not row:
            raise ModelManagementNotFound("Không tìm thấy bản triển khai")
        if enabled:
            conn.execute(
                """
                UPDATE safety.model_deployments
                SET is_enabled=false,stopped_at=COALESCE(stopped_at,now())
                WHERE organization_id=%s AND camera_id=%s AND model_id=%s
                  AND id<>%s AND is_enabled
                """,
                (
                    row["organization_id"],
                    row["camera_id"],
                    row["model_id"],
                    deployment_id,
                ),
            )
        conn.execute(
            """
            UPDATE safety.model_deployments
            SET is_enabled=%s,stopped_at=CASE WHEN %s THEN NULL ELSE now() END
            WHERE id=%s
            """,
            (enabled, enabled, deployment_id),
        )
        conn.execute(
            """
            INSERT INTO safety.audit_logs
              (organization_id,actor_user_id,action,entity_type,entity_id,new_data)
            VALUES (%s,%s,'model.deployment_status','model_deployment',%s,%s::jsonb)
            """,
            (row["organization_id"],user["id"],str(deployment_id),
             json.dumps({"is_enabled": enabled})),
        )


def set_threshold(
    deployment_id: UUID, threshold: float, user: dict[str, Any]
) -> None:
    organizations = _organizations(user)
    with connection() as conn:
        row = conn.execute(
            """
            UPDATE safety.model_deployments SET confidence_threshold=%s
            WHERE id=%s AND organization_id=ANY(%s::uuid[]) RETURNING organization_id
            """,
            (threshold, deployment_id, organizations),
        ).fetchone()
        if not row:
            raise ModelManagementNotFound("Không tìm thấy bản triển khai")
        conn.execute(
            """
            INSERT INTO safety.audit_logs
              (organization_id,actor_user_id,action,entity_type,entity_id,new_data)
            VALUES (%s,%s,'model.threshold','model_deployment',%s,%s::jsonb)
            """,
            (row["organization_id"],user["id"],str(deployment_id),
             json.dumps({"confidence_threshold": threshold})),
        )
