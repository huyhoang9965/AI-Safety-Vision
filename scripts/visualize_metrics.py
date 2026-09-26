"""Truc quan hoa metric cho cac model trong AI Safety Monitoring.

Script tu dong doc cac file metric hien co cua:
  - RF-DETR va YOLO26x: detection metrics theo epoch.
  - VideoMAE stage 1/stage 3: classification metrics theo epoch.
  - V-JEPA 2.1: test metrics, AP va threshold theo tung lop.

Chay tu thu muc goc du an:
    python scripts/visualize_metrics.py

Ket qua mac dinh duoc ghi vao outputs/metric_visualizations/.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Iterable

import matplotlib
import numpy as np
import pandas as pd


PROJECT_ROOT = Path(__file__).resolve().parents[1]

DETECTION_MODELS = {
    "RF-DETR": Path("RF-DETR") / "metrics (1).csv",
    "YOLO26x": Path("yolo 26x") / "metrics.csv",
}

VIDEOMAE_STAGES = {
    "VideoMAE - Stage 1": Path("videomae_stage1") / "history_stage1.csv",
    "VideoMAE - Stage 3": Path("videomae_stage1") / "history_stage3.csv",
}

VJEPA_DIR = Path("VJEPA2_1_ViTL16_384_SafetyBehavior")

COLORS = {
    "blue": "#2563EB",
    "cyan": "#0891B2",
    "green": "#16A34A",
    "orange": "#EA580C",
    "red": "#DC2626",
    "purple": "#7C3AED",
    "gray": "#64748B",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Ve chi tiet metric cua cac model AI Safety Monitoring."
    )
    parser.add_argument(
        "--models-dir",
        type=Path,
        default=PROJECT_ROOT / "models",
        help="Thu muc chua model va metric (mac dinh: models/).",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=PROJECT_ROOT / "outputs" / "metric_visualizations",
        help="Thu muc luu PNG/CSV/Markdown.",
    )
    parser.add_argument("--dpi", type=int, default=180, help="DPI cua anh PNG.")
    parser.add_argument(
        "--show",
        action="store_true",
        help="Hien tung bieu do sau khi luu (phu hop khi chay local).",
    )
    return parser.parse_args()


def configure_matplotlib(show: bool) -> Any:
    if not show:
        matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams.update(
        {
            "figure.facecolor": "white",
            "axes.facecolor": "#F8FAFC",
            "axes.edgecolor": "#CBD5E1",
            "axes.grid": True,
            "grid.color": "#E2E8F0",
            "grid.linewidth": 0.8,
            "axes.axisbelow": True,
            "font.family": "DejaVu Sans",
            "font.size": 10,
            "axes.titlesize": 12,
            "axes.titleweight": "bold",
            "figure.titlesize": 16,
            "figure.titleweight": "bold",
            "legend.frameon": False,
        }
    )
    return plt


def last_valid(values: pd.Series) -> float:
    """Lay gia tri cuoi khac NaN trong mot epoch."""
    valid = values.dropna()
    return np.nan if valid.empty else valid.iloc[-1]


def aggregate_detection_metrics(path: Path) -> pd.DataFrame:
    """Gop cac dong LR/loss/validation tach roi thanh mot dong moi epoch."""
    raw = pd.read_csv(path)
    if "epoch" not in raw.columns:
        raise ValueError(f"{path} khong co cot 'epoch'.")

    for column in raw.columns:
        raw[column] = pd.to_numeric(raw[column], errors="coerce")

    aggregated = raw.groupby("epoch", sort=True).agg(last_valid).reset_index()
    aggregated["epoch"] = aggregated["epoch"].astype(int)
    return aggregated


def available_columns(frame: pd.DataFrame, columns: Iterable[str]) -> list[str]:
    return [column for column in columns if column in frame and frame[column].notna().any()]


def plot_lines(
    ax: Any,
    frame: pd.DataFrame,
    columns: list[str],
    labels: dict[str, str],
    *,
    x: str = "epoch",
    ylim: tuple[float, float] | None = None,
    log_y: bool = False,
) -> None:
    palette = list(COLORS.values())
    for index, column in enumerate(available_columns(frame, columns)):
        ax.plot(
            frame[x],
            frame[column],
            marker="o",
            markersize=4,
            linewidth=2,
            label=labels.get(column, column),
            color=palette[index % len(palette)],
        )
    if ylim is not None:
        ax.set_ylim(*ylim)
    if log_y:
        ax.set_yscale("log")
    ax.set_xlabel("Epoch")
    ax.legend(loc="best", fontsize=8)


def annotate_bars(ax: Any, *, digits: int = 3) -> None:
    for patch in ax.patches:
        height = patch.get_height()
        if np.isfinite(height):
            ax.annotate(
                f"{height:.{digits}f}",
                (patch.get_x() + patch.get_width() / 2, height),
                xytext=(0, 4),
                textcoords="offset points",
                ha="center",
                va="bottom",
                fontsize=8,
            )


def save_figure(plt: Any, fig: Any, path: Path, dpi: int, show: bool) -> None:
    fig.savefig(path, dpi=dpi, bbox_inches="tight", facecolor="white")
    if show:
        plt.show()
    plt.close(fig)


def detection_summary(name: str, frame: pd.DataFrame) -> dict[str, Any]:
    metric = "val/mAP_50_95"
    valid = frame.dropna(subset=[metric])
    if valid.empty:
        raise ValueError(f"{name} khong co gia tri {metric} hop le.")
    best = valid.loc[valid[metric].idxmax()]
    last = valid.iloc[-1]
    return {
        "model": name,
        "task": "object_detection",
        "best_epoch": int(best["epoch"]),
        "selection_metric": "mAP@50:95",
        "best_score": float(best[metric]),
        "last_evaluated_epoch": int(last["epoch"]),
        "mAP_50": float(best.get("val/mAP_50", np.nan)),
        "mAP_50_95": float(best[metric]),
        "F1": float(best.get("val/F1", np.nan)),
        "precision": float(best.get("val/precision", np.nan)),
        "recall": float(best.get("val/recall", np.nan)),
        "train_loss": float(best.get("train/loss", np.nan)),
    }


def plot_detection(
    plt: Any,
    name: str,
    frame: pd.DataFrame,
    output_path: Path,
    dpi: int,
    show: bool,
) -> None:
    fig, axes = plt.subplots(2, 2, figsize=(15, 10), constrained_layout=True)
    fig.suptitle(f"{name} - diễn biến metric theo epoch")

    plot_lines(
        axes[0, 0],
        frame,
        ["val/F1", "val/precision", "val/recall"],
        {
            "val/F1": "F1",
            "val/precision": "Precision",
            "val/recall": "Recall",
        },
        ylim=(0, 1.02),
    )
    axes[0, 0].set_title("Chất lượng phân loại detection")
    axes[0, 0].set_ylabel("Score")

    plot_lines(
        axes[0, 1],
        frame,
        [
            "val/mAP_50",
            "val/mAP_50_95",
            "val/mAP_75",
            "val/mAR",
            "val/ema_mAP_50_95",
        ],
        {
            "val/mAP_50": "mAP@50",
            "val/mAP_50_95": "mAP@50:95",
            "val/mAP_75": "mAP@75",
            "val/mAR": "mAR",
            "val/ema_mAP_50_95": "EMA mAP@50:95",
        },
        ylim=(0, 1.02),
    )
    axes[0, 1].set_title("Average Precision / Average Recall")
    axes[0, 1].set_ylabel("Score")

    plot_lines(
        axes[1, 0],
        frame,
        [
            "train/loss",
            "train/loss_ce",
            "train/loss_bbox",
            "train/loss_giou",
            "train/loss_ce_aux",
            "train/loss_bbox_aux",
            "train/loss_giou_aux",
        ],
        {
            "train/loss": "Total loss",
            "train/loss_ce": "Classification",
            "train/loss_bbox": "BBox L1",
            "train/loss_giou": "GIoU",
            "train/loss_ce_aux": "Classification aux",
            "train/loss_bbox_aux": "BBox aux",
            "train/loss_giou_aux": "GIoU aux",
        },
    )
    axes[1, 0].set_title("Training loss và các thành phần")
    axes[1, 0].set_ylabel("Loss")

    plot_lines(
        axes[1, 1],
        frame,
        ["train/lr", "train/lr_max", "train/lr_min"],
        {
            "train/lr": "Learning rate",
            "train/lr_max": "LR max",
            "train/lr_min": "LR min",
        },
        log_y=True,
    )
    axes[1, 1].set_title("Learning-rate schedule (log scale)")
    axes[1, 1].set_ylabel("Learning rate")

    valid = frame.dropna(subset=["val/mAP_50_95"])
    if not valid.empty:
        best = valid.loc[valid["val/mAP_50_95"].idxmax()]
        for ax in (axes[0, 0], axes[0, 1], axes[1, 0]):
            ax.axvline(
                best["epoch"],
                color=COLORS["red"],
                linestyle="--",
                linewidth=1.2,
                alpha=0.75,
            )
        axes[0, 1].annotate(
            f"Best: epoch {int(best['epoch'])}\n{best['val/mAP_50_95']:.4f}",
            xy=(best["epoch"], best["val/mAP_50_95"]),
            xytext=(10, -45),
            textcoords="offset points",
            arrowprops={"arrowstyle": "->", "color": COLORS["red"]},
            fontsize=9,
        )

    save_figure(plt, fig, output_path, dpi, show)


def normalize_videomae(frame: pd.DataFrame) -> pd.DataFrame:
    frame = frame.copy()
    if "val_mAP" in frame and "mAP" not in frame:
        frame = frame.rename(columns={"val_mAP": "mAP"})
    for column in frame.columns:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    return frame


def videomae_summary(name: str, frame: pd.DataFrame) -> dict[str, Any]:
    valid = frame.dropna(subset=["mAP"])
    best = valid.loc[valid["mAP"].idxmax()]
    return {
        "model": name,
        "task": "multi_label_video_classification",
        "best_epoch": int(best["epoch"]),
        "selection_metric": "mAP",
        "best_score": float(best["mAP"]),
        "last_evaluated_epoch": int(valid.iloc[-1]["epoch"]),
        "mAP": float(best["mAP"]),
        "macro_f1": float(best.get("macro_f1", np.nan)),
        "micro_f1": float(best.get("micro_f1", np.nan)),
        "macro_precision": float(best.get("macro_precision", np.nan)),
        "macro_recall": float(best.get("macro_recall", np.nan)),
        "train_loss": float(best.get("train_loss", np.nan)),
        "val_loss": float(best.get("val_loss", np.nan)),
    }


def plot_videomae(
    plt: Any,
    name: str,
    frame: pd.DataFrame,
    output_path: Path,
    dpi: int,
    show: bool,
) -> None:
    fig, axes = plt.subplots(2, 2, figsize=(15, 10), constrained_layout=True)
    fig.suptitle(f"{name} - diễn biến metric theo epoch")

    plot_lines(
        axes[0, 0],
        frame,
        ["train_loss", "val_loss"],
        {"train_loss": "Train loss", "val_loss": "Validation loss"},
    )
    axes[0, 0].set_title("Train loss và validation loss")
    axes[0, 0].set_ylabel("Loss")

    plot_lines(
        axes[0, 1],
        frame,
        ["mAP", "macro_f1", "micro_f1"],
        {"mAP": "mAP", "macro_f1": "Macro F1", "micro_f1": "Micro F1"},
        ylim=(0, 1.02),
    )
    axes[0, 1].set_title("Các metric đánh giá chính")
    axes[0, 1].set_ylabel("Score")

    quality_columns = available_columns(frame, ["macro_precision", "macro_recall"])
    if quality_columns:
        plot_lines(
            axes[1, 0],
            frame,
            quality_columns,
            {
                "macro_precision": "Macro precision",
                "macro_recall": "Macro recall",
            },
            ylim=(0, 1.02),
        )
        axes[1, 0].set_title("Precision và recall cấp macro")
        axes[1, 0].set_ylabel("Score")
    else:
        gap = frame["val_loss"] - frame["train_loss"]
        axes[1, 0].bar(frame["epoch"], gap, color=COLORS["orange"], alpha=0.85)
        axes[1, 0].axhline(0, color=COLORS["gray"], linewidth=1)
        axes[1, 0].set_title("Generalization gap (val loss - train loss)")
        axes[1, 0].set_xlabel("Epoch")
        axes[1, 0].set_ylabel("Loss gap")

    lr_columns = available_columns(
        frame, ["encoder_lr", "fc_norm_lr", "classifier_lr", "lr_fc_norm", "lr_classifier"]
    )
    plot_lines(
        axes[1, 1],
        frame,
        lr_columns,
        {
            "encoder_lr": "Encoder LR",
            "fc_norm_lr": "FC norm LR",
            "classifier_lr": "Classifier LR",
            "lr_fc_norm": "FC norm LR",
            "lr_classifier": "Classifier LR",
        },
        log_y=True,
    )
    axes[1, 1].set_title("Learning-rate schedule (log scale)")
    axes[1, 1].set_ylabel("Learning rate")

    best = frame.loc[frame["mAP"].idxmax()]
    for ax in axes.flat:
        ax.axvline(
            best["epoch"],
            color=COLORS["red"],
            linestyle="--",
            linewidth=1.2,
            alpha=0.75,
        )
    axes[0, 1].annotate(
        f"Best mAP: epoch {int(best['epoch'])}\n{best['mAP']:.4f}",
        xy=(best["epoch"], best["mAP"]),
        xytext=(8, -42),
        textcoords="offset points",
        arrowprops={"arrowstyle": "->", "color": COLORS["red"]},
        fontsize=9,
    )

    save_figure(plt, fig, output_path, dpi, show)


def plot_videomae_comparison(
    plt: Any,
    frames: dict[str, pd.DataFrame],
    output_path: Path,
    dpi: int,
    show: bool,
) -> None:
    metrics = ["mAP", "macro_f1", "micro_f1"]
    labels = ["mAP", "Macro F1", "Micro F1"]
    names = list(frames)
    values = []
    epochs = []
    for name in names:
        frame = frames[name]
        best = frame.loc[frame["mAP"].idxmax()]
        values.append([best.get(metric, np.nan) for metric in metrics])
        epochs.append(int(best["epoch"]))

    fig, ax = plt.subplots(figsize=(11, 6), constrained_layout=True)
    x = np.arange(len(metrics))
    width = 0.35
    for index, (name, row) in enumerate(zip(names, values)):
        offset = (index - (len(names) - 1) / 2) * width
        ax.bar(x + offset, row, width, label=f"{name} (best epoch {epochs[index]})")
    ax.set_title("VideoMAE - so sánh hai giai đoạn tại epoch có mAP tốt nhất")
    ax.set_ylabel("Score")
    ax.set_ylim(0, 1.02)
    ax.set_xticks(x, labels)
    ax.legend(loc="best")
    annotate_bars(ax)
    save_figure(plt, fig, output_path, dpi, show)


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def vjepa_summary(test_metrics: dict[str, Any]) -> dict[str, Any]:
    return {
        "model": test_metrics["model"],
        "task": "multi_label_video_classification",
        "best_epoch": int(test_metrics["checkpoint_epoch"]),
        "selection_metric": "test_mAP",
        "best_score": float(test_metrics["mAP"]),
        "last_evaluated_epoch": int(test_metrics["checkpoint_epoch"]),
        "test_videos": int(test_metrics["test_videos"]),
        "mAP": float(test_metrics["mAP"]),
        "macro_f1": float(test_metrics["macro_f1"]),
        "micro_f1": float(test_metrics["micro_f1"]),
        "macro_precision": float(test_metrics["macro_precision"]),
        "macro_recall": float(test_metrics["macro_recall"]),
    }


def plot_vjepa(
    plt: Any,
    test: dict[str, Any],
    thresholds: dict[str, Any],
    output_path: Path,
    dpi: int,
    show: bool,
) -> None:
    fig, axes = plt.subplots(2, 2, figsize=(17, 12), constrained_layout=True)
    fig.suptitle(
        f"{test['model']} - checkpoint epoch {test['checkpoint_epoch']} "
        f"({test['test_videos']} test videos)"
    )

    global_keys = ["mAP", "macro_f1", "micro_f1", "macro_precision", "macro_recall"]
    global_labels = ["mAP", "Macro F1", "Micro F1", "Macro P", "Macro R"]
    axes[0, 0].bar(
        global_labels,
        [test[key] for key in global_keys],
        color=[COLORS["blue"], COLORS["purple"], COLORS["cyan"], COLORS["orange"], COLORS["green"]],
    )
    axes[0, 0].set_title("Metric tổng quát trên test set")
    axes[0, 0].set_ylim(0, 1.02)
    axes[0, 0].set_ylabel("Score")
    annotate_bars(axes[0, 0])

    ap_series = pd.Series(test["ap_per_class"], dtype=float).sort_values()
    ap_colors = [COLORS["red"] if value < 0.5 else COLORS["green"] for value in ap_series]
    bars = axes[0, 1].barh(ap_series.index, ap_series.values, color=ap_colors, alpha=0.9)
    axes[0, 1].set_title("Average Precision (AP) theo từng lớp")
    axes[0, 1].set_xlim(0, 1.08)
    axes[0, 1].set_xlabel("AP")
    axes[0, 1].axvline(test["mAP"], color=COLORS["blue"], linestyle="--", label=f"mAP = {test['mAP']:.3f}")
    axes[0, 1].legend(loc="lower right")
    axes[0, 1].bar_label(bars, fmt="%.3f", padding=3, fontsize=8)

    class_names = thresholds["class_names"]
    threshold_values = thresholds["thresholds"]
    threshold_series = pd.Series(threshold_values, index=class_names).sort_values()
    threshold_bars = axes[1, 0].barh(
        threshold_series.index, threshold_series.values, color=COLORS["orange"], alpha=0.88
    )
    axes[1, 0].set_title("Decision threshold tối ưu theo từng lớp")
    axes[1, 0].set_xlim(0, 1.08)
    axes[1, 0].set_xlabel("Threshold")
    axes[1, 0].axvline(0.5, color=COLORS["gray"], linestyle="--", label="Mặc định = 0.5")
    axes[1, 0].legend(loc="lower right")
    axes[1, 0].bar_label(threshold_bars, fmt="%.2f", padding=3, fontsize=8)

    metric_keys = ["macro_f1", "micro_f1", "macro_precision", "macro_recall"]
    metric_labels = ["Macro F1", "Micro F1", "Macro P", "Macro R"]
    default_values = [thresholds["validation_metrics_05"][key] for key in metric_keys]
    tuned_values = [thresholds["validation_metrics_tuned"][key] for key in metric_keys]
    x = np.arange(len(metric_keys))
    width = 0.36
    axes[1, 1].bar(x - width / 2, default_values, width, label="Threshold = 0.5", color=COLORS["gray"])
    axes[1, 1].bar(x + width / 2, tuned_values, width, label="Threshold tuned", color=COLORS["blue"])
    axes[1, 1].set_xticks(x, metric_labels)
    axes[1, 1].set_ylim(0, 1.02)
    axes[1, 1].set_ylabel("Validation score")
    axes[1, 1].set_title(
        f"Ảnh hưởng của threshold tuning (validation mAP = {thresholds['validation_mAP']:.3f})"
    )
    axes[1, 1].legend(loc="best")
    annotate_bars(axes[1, 1])

    save_figure(plt, fig, output_path, dpi, show)


def format_number(value: Any) -> str:
    if value is None or pd.isna(value):
        return "N/A"
    if isinstance(value, (int, np.integer)):
        return str(value)
    if isinstance(value, (float, np.floating)):
        return f"{value:.4f}"
    return str(value)


def write_report(
    path: Path,
    summaries: list[dict[str, Any]],
    vjepa_test: dict[str, Any],
    vjepa_thresholds: dict[str, Any],
    generated_files: list[str],
) -> None:
    lines = [
        "# Báo cáo trực quan hóa metric",
        "",
        "> Báo cáo này được sinh tự động bởi `scripts/visualize_metrics.py`.",
        "",
        "## Tóm tắt checkpoint/epoch tốt nhất",
        "",
        "| Model | Bài toán | Epoch | Tiêu chí chọn | Điểm tốt nhất |",
        "| --- | --- | ---: | --- | ---: |",
    ]
    for row in summaries:
        lines.append(
            f"| {row['model']} | {row['task']} | {row['best_epoch']} | "
            f"{row['selection_metric']} | {format_number(row['best_score'])} |"
        )

    default_f1 = vjepa_thresholds["validation_metrics_05"]["macro_f1"]
    tuned_f1 = vjepa_thresholds["validation_metrics_tuned"]["macro_f1"]
    f1_delta = tuned_f1 - default_f1
    ap_series = pd.Series(vjepa_test["ap_per_class"], dtype=float)
    strongest = ap_series.idxmax()
    weakest = ap_series.idxmin()
    lines.extend(
        [
            "",
            "## Chi tiết V-JEPA",
            "",
            f"- Threshold tuning làm validation macro F1 thay đổi từ {default_f1:.4f} "
            f"lên {tuned_f1:.4f} (chênh lệch {f1_delta:+.4f}).",
            f"- Lớp có AP cao nhất: **{strongest}** ({ap_series[strongest]:.4f}).",
            f"- Lớp có AP thấp nhất: **{weakest}** ({ap_series[weakest]:.4f}).",
            "- Không so sánh trực tiếp mAP detection với mAP classification vì định nghĩa và bài toán khác nhau.",
            "",
            "## File đầu ra",
            "",
        ]
    )
    lines.extend(f"- `{filename}`" for filename in generated_files)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    models_dir = args.models_dir.resolve()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    plt = configure_matplotlib(args.show)

    summaries: list[dict[str, Any]] = []
    generated_files: list[str] = []

    detection_frames: dict[str, pd.DataFrame] = {}
    for index, (name, relative_path) in enumerate(DETECTION_MODELS.items(), start=1):
        path = models_dir / relative_path
        if not path.exists():
            raise FileNotFoundError(f"Khong tim thay metric cua {name}: {path}")
        frame = aggregate_detection_metrics(path)
        detection_frames[name] = frame
        normalized_name = name.lower().replace("-", "").replace(" ", "_")
        csv_name = f"{index:02d}_{normalized_name}_metrics_by_epoch.csv"
        png_name = f"{index:02d}_{normalized_name}_training_metrics.png"
        frame.to_csv(output_dir / csv_name, index=False, encoding="utf-8-sig")
        plot_detection(plt, name, frame, output_dir / png_name, args.dpi, args.show)
        summaries.append(detection_summary(name, frame))
        generated_files.extend([png_name, csv_name])

    videomae_frames: dict[str, pd.DataFrame] = {}
    for index, (name, relative_path) in enumerate(VIDEOMAE_STAGES.items(), start=3):
        path = models_dir / relative_path
        if not path.exists():
            raise FileNotFoundError(f"Khong tim thay history cua {name}: {path}")
        frame = normalize_videomae(pd.read_csv(path))
        videomae_frames[name] = frame
        stage_number = name.rsplit(" ", maxsplit=1)[-1]
        png_name = f"{index:02d}_videomae_stage{stage_number}_training_metrics.png"
        plot_videomae(plt, name, frame, output_dir / png_name, args.dpi, args.show)
        summaries.append(videomae_summary(name, frame))
        generated_files.append(png_name)

    comparison_name = "05_videomae_stage_comparison.png"
    plot_videomae_comparison(
        plt, videomae_frames, output_dir / comparison_name, args.dpi, args.show
    )
    generated_files.append(comparison_name)

    vjepa_test_path = models_dir / VJEPA_DIR / "vjepa_epoch8_final_test_metrics.json"
    vjepa_threshold_path = models_dir / VJEPA_DIR / "vjepa_epoch8_thresholds.json"
    vjepa_test = load_json(vjepa_test_path)
    vjepa_thresholds = load_json(vjepa_threshold_path)
    vjepa_name = "06_vjepa_test_metrics.png"
    plot_vjepa(
        plt,
        vjepa_test,
        vjepa_thresholds,
        output_dir / vjepa_name,
        args.dpi,
        args.show,
    )
    summaries.append(vjepa_summary(vjepa_test))
    generated_files.append(vjepa_name)

    summary_name = "metrics_summary.csv"
    pd.DataFrame(summaries).to_csv(
        output_dir / summary_name, index=False, encoding="utf-8-sig"
    )
    generated_files.append(summary_name)

    report_name = "REPORT.md"
    write_report(
        output_dir / report_name,
        summaries,
        vjepa_test,
        vjepa_thresholds,
        generated_files,
    )
    generated_files.append(report_name)

    print(f"Da tao {len(generated_files)} file trong: {output_dir}")
    for filename in generated_files:
        print(f"  - {filename}")


if __name__ == "__main__":
    main()
