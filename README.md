# AI Safety Monitoring — Real Model Demo

Module demo thật gồm:

```text
Next.js frontend (/demo)
        |
        v
FastAPI backend (:8000)
        |
        +--> PostgreSQL (metadata + inference history)
        |
        +--> dataset test videos + lazy-loaded AI checkpoints
```

Landing page `/` không bị thay đổi. Demo chỉ sử dụng video thật có `final_split=test` trong `outputs/video_audit/video_manifest_FINAL_kaggle.csv`.

## 1. Tạo PostgreSQL database

PostgreSQL service phải đang chạy. Trong pgAdmin4:

1. Kết nối server PostgreSQL.
2. Mở **Query Tool** trên database mặc định `postgres`.
3. Chạy `backend/migrations/000_create_database.sql` để tạo database `ai_safety_monitoring`.
4. Kết nối database mới `ai_safety_monitoring`.
5. Chạy `backend/migrations/001_init.sql`.

Backend cũng tự chạy migration `001_init.sql` khi khởi động. Database phải được tạo trước vì PostgreSQL không cho phép `CREATE DATABASE` trong transaction thông thường.

Các bảng:

- `videos`: đường dẫn video, split và duration.
- `models`: model, loại, version và đường dẫn checkpoint.
- `inference_history`: trạng thái, thời gian xử lý và output video.
- `predictions`: xác suất các lớp classification.
- `detection_results`: class, confidence và tọa độ bbox theo frame.

Binary video không được lưu vào PostgreSQL. Database chỉ lưu đường dẫn.

## 2. Cấu hình và chạy FastAPI

Trong PowerShell:

```powershell
cd D:\AI_Safety_Monitoring\backend
..\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Mở `backend/.env` và thay `YOUR_PASSWORD` bằng password PostgreSQL thật:

```env
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/ai_safety_monitoring
FRONTEND_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
AI_DEVICE=auto
DETECTION_CONFIDENCE=0.20
RF_DETR_INFERENCE_FPS=1.0
RF_DETR_INPUT_SIZE=512
```

Khởi động backend:

```powershell
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Kiểm tra:

- Swagger UI: `http://localhost:8000/docs`
- Health: `http://localhost:8000/api/health`
- 100 test videos: `http://localhost:8000/api/videos/test`
- Model catalog: `http://localhost:8000/api/models`

## 3. Chạy frontend

Mở PowerShell thứ hai:

```powershell
cd D:\AI_Safety_Monitoring\web
Copy-Item .env.example .env.local
npm install
npm run dev
```

Mở:

- Demo thật: `http://localhost:3000/demo`
- Landing page: `http://localhost:3000/`

## 4. Dùng demo tự động

Mở `/demo`; không cần chọn model hoặc nhấn nút chạy. Dashboard cố định 5 camera, mỗi camera phát nối tiếp 2 clip test để tránh video quá ngắn (10 clip, tổng khoảng 130 giây), rồi tự chạy lần lượt:

1. **RF-DETR** ưu tiên một clip PPE đại diện để cảnh báo có bbox xuất hiện sớm, sau đó tiếp tục quét từng camera.
2. **VideoMAE `best_stage3.pt`** và RF-DETR lần lượt phân tích hành vi/vùng nguy hiểm và PPE trên toàn bộ 10 clip.
3. Vi phạm được thêm ngay vào **Cảnh báo thời gian thực** và **Lịch sử vi phạm**.
4. Người dùng có thể xác nhận sự cố hoặc đánh dấu báo sai trong phần lịch sử.
5. Khi PostgreSQL kết nối, inference và các detection/prediction được ghi vào database; nếu database chưa sẵn sàng, lịch sử giao diện được giữ trong phiên trình duyệt.

VideoMAE là model phân loại cả clip nên không trả tọa độ. Giao diện khoanh vùng đã hiệu chỉnh riêng cho camera. Pipeline PPE dùng YOLOv8s COCO để định vị người (toàn ảnh và các ô chồng lấn), rồi RF-DETR kiểm tra trên từng crop người. Người đứng yên và người chỉ lộ phần thân trên không còn bị loại bởi ngưỡng chuyển động.

Cảnh báo thiếu PPE cần hai lần kiểm tra liên tiếp trên cùng người và được ghi **nghi ngờ**: checkpoint PPE không có nhãn `no_helmet/no_vest`, không thấy PPE chưa chứng minh người không mang PPE. Vùng đầu và thân được ước lượng trong bbox người; người chỉ lộ đầu/vai không được đánh giá thiếu áo. Mỗi người/loại cảnh báo có một ảnh crop, thời điểm trong clip và mã theo dõi riêng trong `metrics.evidence_events`. Không dùng confidence nhận diện người làm xác suất vi phạm. Các mã theo dõi chỉ có hiệu lực trong từng clip và có thể đổi khi người bị che khuất lâu.

Checkpoint định vị người bổ sung đã được tải vào `storage/checkpoints/yolov8s.pt`; đây là model phụ trong pipeline RF-DETR, không phải checkpoint YOLO26x PPE. Khi cài trên máy khác:

```powershell
cd D:\AI_Safety_Monitoring
New-Item -ItemType Directory -Force storage/checkpoints
curl.exe -L --fail https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8s.pt -o storage/checkpoints/yolov8s.pt
```

Backend báo chưa kết nối khi thiếu checkpoint hoặc `ultralytics`. Không tải weights âm thầm khi gọi inference. Chia ô ảnh và quét crop người làm CPU chậm hơn; tiến trình tự chạy và cache kết quả trong phiên backend. Sau khi cập nhật backend, khởi động lại để xóa cache kết quả cũ, rồi tải lại `/demo`.

API request:

```http
POST /api/inference
Content-Type: application/json

{
  "video_id": 1,
  "model_name": "VideoMAE"
}
```

Response:

```json
{
  "video": "0_tr6.mp4",
  "video_id": 1,
  "model": "VideoMAE",
  "type": "classification",
  "prediction": "Safe Walkway Violation",
  "confidence": 0.92,
  "output_video": "/api/videos/1/stream",
  "processing_time": 4.71,
  "metrics": {
    "class_scores": {}
  },
  "ground_truth": ["Safe Walkway Violation"],
  "persisted": true
}
```

Các giá trị prediction/confidence trên chỉ minh họa **schema API**, không phải kết quả hard-code. Backend không có fallback prediction.

## Model sử dụng trong demo

| Model | Trạng thái | Adapter |
| --- | --- | --- |
| RF-DETR | Connected sau khi cài `rfdetr==1.10.1` | RFDETRLarge + OpenCV output renderer |
| VideoMAE | Connected | Transformers, 16 frame midpoint sampling, checkpoint `best_stage3.pt` |
| YOLOv8s COCO (bổ trợ) | `storage/checkpoints/yolov8s.pt` | Định vị người, chia ô chồng lấn; gọi nội bộ từ RF-DETR |

Các tên model khác bị API từ chối. Backend không thay bằng ảnh, video hay prediction giả.

## Storage

```text
storage/
  videos/       # dành cho video được ingest sau này
  outputs/      # video detection đã render
  checkpoints/  # dành cho checkpoint được quản lý sau này
```

Checkpoint hiện có vẫn được đọc trực tiếp từ `models/` để tránh sao chép nhiều GB dữ liệu.

## Kiểm tra code

```powershell
cd D:\AI_Safety_Monitoring
.\.venv\Scripts\python.exe -m pytest backend\tests

cd web
npm run typecheck
npm run build
```
