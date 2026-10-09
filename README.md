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
RF_DETR_INFERENCE_FPS=2
RF_DETR_INPUT_SIZE=384
PERSON_LOCATOR_TILING=false
PERSON_LOCATOR_INPUT_SIZE=960
AI_PRELOAD_MODELS=true
AI_CPU_THREADS=8
AI_MAX_CONCURRENT_INFERENCE=1
VIDEO_OUTPUT_MAX_WIDTH=1280
VIDEO_ENCODE_PRESET=ultrafast
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

Video demo phát qua HTTP Range từ bản H.264 tối đa 1280×720, giữ thời điểm khung hình và audio của nguồn, có MP4 `faststart` và keyframe khoảng mỗi giây. Backend tạo sẵn 13 bản phát trong `storage/outputs/playback` khi khởi động; trong lúc chuẩn bị hoặc nếu chuyển đổi lỗi, API vẫn dùng bản gốc. Có thể chuẩn bị trước bằng `python backend/scripts/prepare_demo_playback.py`; báo cáo `storage/outputs/playback-audit.json` chứa kích thước và đường dẫn để kiểm tra phát thực tế. Bản gốc vẫn dùng cho AI và ảnh bằng chứng; cache bản phát tự đổi khi nguồn thay đổi. Trang giám sát dùng video trực tiếp thay vì tải toàn bộ clip vào blob, còn Demo chỉ cập nhật khung AI trong thành phần player và tải trước clip kế tiếp. Mặc định AI dùng tối đa 4 luồng CPU; `AI_CPU_THREADS` có thể điều chỉnh theo máy. Kiểm tra 13 clip thật với backend đang chạy bằng `npm run test:e2e -- tests/video-playback.spec.ts` trong `web`.
4. Người dùng có thể xác nhận sự cố hoặc đánh dấu báo sai trong phần lịch sử.
5. Khi PostgreSQL kết nối, inference và các detection/prediction được ghi vào database; nếu database chưa sẵn sàng, lịch sử giao diện được giữ trong phiên trình duyệt.

VideoMAE là model phân loại cả clip nên không trả tọa độ. Khung cảnh báo lấy từ bước định vị đối tượng nhìn thấy trong ảnh và kiểm tra hành vi theo góc quay đã hiệu chỉnh; không dùng toàn bộ vùng camera làm khung vi phạm. Pipeline PPE mặc định dùng một lượt YOLOv8s COCO trên toàn ảnh 960px để định vị người, rồi RF-DETR kiểm tra trên từng crop người. Có thể bật `PERSON_LOCATOR_TILING=true` khi chạy bằng GPU hoặc khi cần ưu tiên phát hiện người rất nhỏ ở xa. Người đứng yên và người chỉ lộ phần thân trên không còn bị loại bởi ngưỡng chuyển động.

Cảnh báo thiếu PPE cần hai lần kiểm tra liên tiếp trên cùng người và được ghi **nghi ngờ**: checkpoint PPE không có nhãn `no_helmet/no_vest`, không thấy PPE chưa chứng minh người không mang PPE. Vùng đầu và thân được ước lượng trong bbox người; người chỉ lộ đầu/vai không được đánh giá thiếu áo. Mỗi người/loại cảnh báo có một ảnh crop, thời điểm trong clip và mã theo dõi riêng trong `metrics.evidence_events`. Không dùng confidence nhận diện người làm xác suất vi phạm. Các mã theo dõi chỉ có hiệu lực trong từng clip và có thể đổi khi người bị che khuất lâu.

PPE mặc định kiểm tra khoảng **2 lần/giây** (`RF_DETR_INFERENCE_FPS=2`) để theo dõi người di chuyển và xác nhận lỗi từ đầu clip. Người đứng tại máy bị detector bỏ sót ngắn hạn có thể giữ mã tối đa 4 giây với yêu cầu khớp vị trí chặt hơn; vùng đầu tương đồng giúp nối bbox toàn thân và bbox bị che khuất. Vận tốc gần nhất hỗ trợ nối người di chuyển giữa hai lần quan sát. Không có quan sát thì không phát sinh box/cảnh báo; xuất hiện lại phải xác nhận hai lần mới. Màu dùng chung từ `web/lib/detection-styles.json`: thiếu mũ **đỏ**, thiếu áo **vàng cam**, tủ điện mở **tím**. Áp dụng cho Demo, giám sát trực tiếp, video xử lý và ảnh crop mới; nhãn trên trình duyệt là tiếng Việt và có chú thích màu.

CAM-03 bổ sung `panel_search` cho đúng tủ điện trong ba clip demo. VideoMAE vẫn phải nhận diện `Opened Panel Cover` ≥0,90 và chênh lớp đối thủ ≥0,20; định vị tìm phần khoang tủ nhìn thấy trong ảnh và xác nhận qua ít nhất ba quan sát trong khoảng 0,5 giây. Khung bám vùng ảnh tìm được, không dùng toàn bộ ROI làm box; tủ bị che kín/mất khỏi ảnh thì khung dừng. Hiệu chỉnh này chỉ áp dụng cho góc quay demo đã kiểm tra, không phải detector tủ điện tổng quát cho camera mới. Mỗi tủ trong clip có một cảnh báo, dùng lại định danh `clip` cũ để cập nhật bằng chứng. Cache phân tích được đổi khi code detector/định vị hoặc bảng màu thay đổi.

Nếu mô hình đã nhận diện áo `Vest` đúng vùng thân của một người, pipeline giữ bằng chứng dương tính tối đa khoảng 3 giây trên mã theo dõi đó. Mô hình bỏ sót áo ngắn hạn không phát cảnh báo thiếu áo; không vẽ lại box áo cũ và không dùng áo của người bên cạnh. Hết khoảng nhớ, hai quan sát liên tiếp không thấy áo vẫn có thể cảnh báo. Quy tắc mũ giữ nguyên. Khi phân tích lại RF-DETR thành công, cảnh báo thiếu áo/mũ demo cũ ở trạng thái `new` và không còn trong kết quả được chuyển sang `dismissed`; chỉ áp dụng đúng camera/clip/model, giữ nguyên các cảnh báo đã được người dùng xác nhận hoặc xử lý trong database. Danh sách Demo trong sessionStorage đối chiếu lại từng camera/clip/model với kết quả mới và bỏ cảnh báo không còn tương ứng, kể cả mục từng xác nhận trong phiên; lịch sử quyết định ở Dashboard vẫn được giữ. Không cần thay đổi schema SQL.

CAM-04 dùng thêm `person_focus` để chạy một lượt định vị ở độ chi tiết cao hơn trên vùng làm việc, ghép bbox đầu/thân trùng mà vẫn giữ hai người riêng. Khi detector tạm bỏ sót, `person_tracking_seconds=1.5` cho phép nối theo các đặc trưng đầu còn khớp trên ảnh hiện tại: optical flow thuận/ngược, tương quan ảnh và độ tương phản đều phải đạt. Không tạo người từ ROI hoặc nền trống, không giữ khung khi ảnh không còn khớp và không vượt quá 1,5 giây kể từ lần detector nhìn thấy người. Cấu hình chỉ áp dụng cho góc quay CAM-04; camera khác vẫn dùng lượt toàn khung như trước.

Hai clip CAM-04 có góc quay khác nhau nên dùng `clip_views` riêng để kiểm tra vùng công nhân phía sau máy và cạnh tủ. `confirm_person_bodies` yêu cầu ứng viên có thân người được YOLO nhận lại trong một vùng ảnh có ngữ cảnh, với bbox và vị trí đầu tương ứng; đồ vật bị nhầm ở lượt toàn ảnh không đủ để tạo cảnh báo PPE. Với tủ, `panel_interior` chỉ xác định khoang vật lý để kiểm tra ảnh hiện tại: cần tỷ lệ vùng tối, chi tiết bên trong và thành phần ảnh ổn định qua ba quan sát. Khung được lấy từ thành phần nhìn thấy, không tự vẽ theo vùng hiệu chỉnh. VideoMAE nhận `Unauthorized Intervention` rõ ràng vẫn có thể kèm cảnh báo tủ mở được xác minh bằng ảnh; cảnh báo phụ không gán điểm của lớp can thiệp thành độ tin cậy của lớp tủ. Hai loại lỗi dùng định danh riêng, mỗi clip chỉ tạo một cảnh báo tủ; phân tích lại dùng cache và cập nhật bằng chứng, không gửi lặp. Đây là hiệu chỉnh cho hai góc demo, cần hiệu chỉnh lại nếu camera được di chuyển.

CAM-05 clip `0_tr79.mp4` thêm lượt kiểm tra vùng làm việc ở kích thước đầu vào 640 qua `person_focus_input_size`; lượt toàn ảnh vẫn giữ kích thước 960. Tỷ lệ này giúp YOLO nhận phần thân còn nhìn thấy của công nhân quay lưng phía sau máy, thay vì chỉ đầu hoặc bỏ sót. Ứng viên thân người được xác minh lại trong vùng ảnh chi tiết; nếu vùng hẹp mất ngữ cảnh thì thêm vùng 800×450 qua `person_body_context_size`, yêu cầu nhận đúng bbox và vị trí đầu với confidence ≥0,35. Bằng chứng thân người đã xác minh được nhớ tối đa 1,5 giây, chỉ cho bbox người YOLO còn nhìn thấy ở vị trí tương ứng; quan sát chưa xác minh không gia hạn thời gian này và trí nhớ được xóa khi sang clip. Vùng hiệu chỉnh không tự sinh người hay lỗi PPE: cần bbox thật và hai quan sát thiếu mũ/áo; phần thân bị che hoàn toàn không được suy đoán thiếu áo. Hiệu chỉnh chỉ áp dụng clip thứ ba, có nối hình ảnh tối đa 1,5 giây và cùng quy tắc màu, ghi nhận/cập nhật cảnh báo như các camera khác.

Kiểm tra checkpoint thật mà không ghi cảnh báo: `.venv/Scripts/python.exe backend/scripts/check_ppe_demo.py` và `.venv/Scripts/python.exe backend/scripts/check_demo_behavior.py --filenames 2_te3.mp4 2_tr14.mp4 2_tr91.mp4`. Kết quả nằm trong `storage/outputs/ppe-panel-review` và `storage/outputs/demo-video-review`; các script chỉ tạo báo cáo, video/ảnh cục bộ.

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

| Model                   | Trạng thái                             | Adapter                                                                           |
| ----------------------- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| RF-DETR                 | Connected sau khi cài`rfdetr==1.10.1` | RFDETRLarge + OpenCV output renderer                                              |
| VideoMAE                | Connected                                | Transformers, 16 frame midpoint sampling, checkpoint`best_stage3.pt`            |
| YOLOv8s COCO (bổ trợ) | `storage/checkpoints/yolov8s.pt`       | Định vị người toàn ảnh; hỗ trợ bật chia ô chồng lấn bằng cấu hình |

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

Luồng MP4 luôn trả `Vary: Origin`, kể cả khi được tải trước không có CORS; URL `cors=1` bỏ qua các phản hồi cũ đã cache thiếu header. Player Demo và giám sát dùng CORS nhất quán để hỗ trợ chụp ảnh. Mỗi camera giám sát tự thử lại tối đa 3 lần khi tải lỗi, giữ trạng thái phát/tạm dừng và có nút thử lại riêng; nút Làm mới tải lại cả catalog và player. Kiểm tra hồi phục và chuyển cache Demo sang giám sát bằng `npm run test:e2e -- tests/live-camera-recovery.spec.ts`.

## Chi phí và hiệu năng trợ lý AI

Trang `/dashboard/models` có thống kê LLM/RAG/TTS theo 24 giờ, 7 ngày, 30 ngày hoặc toàn bộ lịch sử; có CSV và biểu đồ chi phí từng ngày UTC. `backend/migrations/005_ai_observability.sql` được backend áp dụng khi khởi động. Bản tương đương cho pgAdmin là `database/add_ai_observability.sql`.

`safety.ai_usage_events` ghi từng lần gọi LLM, TTS và tra cứu SQL, gồm lỗi/429, độ trễ, token input/output/cache/reasoning, ký tự TTS, thời lượng PCM/WAV và chi phí USD khi OpenRouter cung cấp. Không ghi prompt, nội dung tra cứu, audio hay API key trong bảng này. Giá trị thiếu là NULL; chi phí 0 chỉ có khi nhà cung cấp báo 0. LLM dùng `usage.cost`; TTS dùng `X-Generation-Id` và đối soát nền qua `/api/v1/generation`. Hàng đợi đối soát có giới hạn, không chặn phát audio; dữ liệu chưa đối soát được hiển thị riêng. Giá hiệu dụng /1M token, /1.000 ký tự và /phút audio chỉ tính trên mẫu có đủ chi phí và đơn vị sử dụng.

Percentile p50/p95/p99 tính bằng PostgreSQL `percentile_cont`, chỉ dùng lượt hoàn tất; lỗi không trộn vào phân bố độ trễ. Full-answer latency cũ và token lịch sử được hiển thị riêng để không đếm trùng lượt API. RAG SQL có p50/p95/p99, tỷ lệ lỗi/rỗng, số kết quả và tỷ lệ câu trả lời có nguồn; lượt mới được liên kết với lịch sử tool để không đếm hai lần. Recall@k, MRR, nDCG, faithfulness và MOS chưa có bộ đánh giá được gán nhãn nên chưa hiển thị điểm. LLM không streaming nên chưa đo TTFT; TTS first-byte là byte từ nhà cung cấp, chưa phải thời điểm phát ở trình duyệt. RTF là thời gian tạo audio / độ dài audio. Backend chỉ trả số liệu từ các tổ chức người xem có `camera.manage`.

Kiểm tra: `TEST_AI_METRICS_SQL=1` cho phép `backend/tests/test_ai_observability.py` dùng bảng tạm trong phiên PostgreSQL, không thêm dữ liệu mẫu vào bảng vận hành; frontend dùng `npm run test:e2e -- tests/assistant-metrics.spec.ts`. API usage/cost dựa trên [Usage Accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting) và [TTS](https://openrouter.ai/docs/guides/overview/multimodal/tts) của OpenRouter.

## Phiên đăng nhập

Access token có thời hạn mặc định 15 phút (`ACCESS_TOKEN_MINUTES`), được trình duyệt tự gia hạn trước khi hết hạn khi trang đang mở. Dashboard, chatbot và Demo dùng chung cơ chế gia hạn; yêu cầu bị từ chối xác thực được gửi lại một lần với token mới. Các tab dùng Web Locks để tránh cùng xoay một refresh token.

Lỗi mạng hoặc backend tạm ngừng không xóa phiên đã lưu. Chọn duy trì phiên đăng nhập để lưu trên thiết bị; nếu không chọn, phiên lưu trong tab hiện tại. Refresh token mặc định có thời hạn 30 ngày (`REFRESH_TOKEN_DAYS`), tính lại từ mỗi lần gia hạn. Người dùng vẫn có thể đăng xuất; phiên bị thu hồi hoặc tài khoản bị vô hiệu hóa vẫn phải đăng nhập lại theo quyền của backend.

## Chatbot OpenRouter và giọng nói

Chatbot dùng LLM để trò chuyện tự nhiên và chọn công cụ tra cứu theo quyền của tài khoản. Lời chào không tự động mở báo cáo an toàn. Hội thoại được lưu trong PostgreSQL; API lỗi sẽ không lưu một lượt trò chuyện dở dang.

Điền các biến sau vào `backend/.env`, sau đó khởi động lại backend nếu tiến trình không dùng auto reload:

```dotenv
OPENROUTER_API_KEY=your-key-here
OPENROUTER_MODEL=google/gemini-2.5-flash
CHAT_LLM_SHARE_INTERNAL_DATA=false
CHAT_TTS_ENABLED=true
CHAT_TTS_MODEL=google/gemini-3.8-flash-tts
CHAT_TTS_SHARE_INTERNAL_DATA=false
```

Key chỉ được đọc ở backend, không đặt trong biến `NEXT_PUBLIC_*`, không gửi qua chat hoặc commit. Có thể đổi model bằng `OPENROUTER_MODEL`; model cần hỗ trợ tool calling. Các giới hạn thời gian, token và lịch sử nằm trong `backend/.env.example`. Nếu chưa điền key, chatbot chạy chế độ cơ bản; khi key lỗi/hết hạn mức, giao diện báo lỗi để người dùng sửa hoặc thử lại.

Mặc định, OpenRouter chỉ nhận nội dung người dùng gửi, lịch sử hội thoại đã che các trả lời chứa dữ liệu nội bộ, hướng dẫn chung và định nghĩa công cụ. Kết quả camera/cảnh báo/sự cố/người dùng được xử lý và hiển thị tại backend, không gửi sang LLM. Chế độ `CHAT_LLM_SHARE_INTERNAL_DATA=true` cho phép LLM tổng hợp các kết quả đó và lịch sử trả lời chứa dữ liệu; chỉ bật sau khi chủ hệ thống cho phép chia sẻ rõ các dữ liệu này tới OpenRouter (`https://openrouter.ai/api/v1/chat/completions`) và nhà cung cấp model được chọn.

Trong cửa sổ chatbot:

- Nhấn **micro** để nói. Khi có nội dung nhận dạng, im lặng khoảng **2 giây** sẽ tự gửi đúng một lượt; nói tiếp sẽ đặt lại thời gian chờ. Nhấn **dừng** trước khi hết thời gian để giữ bản nháp và tự sửa/gửi. Không tự bật micro, không gửi bản nháp chỉ vì bật micro mà chưa nói. Đóng chatbot, đổi hội thoại hoặc lỗi micro sẽ hủy lượt tự gửi đang chờ.
- Nhấn **loa** ở mỗi câu trả lời để đọc/dừng, hoặc bật **Tự đọc câu trả lời** (mặc định tắt, lưu trên trình duyệt). Giọng đọc dừng khi đóng chatbot, đổi hội thoại hoặc bật micro.
- Mở **Giọng đọc** để chọn giọng **nữ Kore** hoặc **nam Charon**, nghe thử Việt/Anh và chọn ngôn ngữ nhận dạng Việt hoặc Anh. Lựa chọn được lưu trên trình duyệt.
- **Giọng AI** dùng OpenRouter TTS/Google, hỗ trợ đọc tiếng Việt và tiếng Anh theo nội dung, có tính phí riêng qua key OpenRouter. Model đọc độc lập với model hội thoại, nên không cần đổi Gemini 2.5 Flash. Backend chuyển PCM 24 kHz mono 16-bit thành WAV để trình duyệt phát ổn định; frontend hủy yêu cầu/âm thanh khi đóng và giữ tối đa 6 mẫu trong bộ nhớ để giảm tạo lại cùng giọng.
- Backend chỉ nhận ID tin nhắn cần đọc và kiểm tra chủ sở hữu/tổ chức/quyền trước khi gửi nội dung tới `https://openrouter.ai/api/v1/audio/speech`. Mặc định chỉ đọc bằng AI các trả lời không chứa kết quả tra cứu nội bộ và câu nghe thử cố định. `CHAT_TTS_SHARE_INTERNAL_DATA=true` cho phép gửi nội dung trả lời chứa camera/cảnh báo/sự cố/người dùng tới OpenRouter và Google TTS; chỉ bật sau khi chủ hệ thống cho phép rõ việc chia sẻ này. Cờ này độc lập với quyền chia sẻ cho LLM phân tích.
- **Giọng trên thiết bị** chọn giọng đúng ngôn ngữ và giọng nam/nữ đã biết theo tên; thiếu giọng phù hợp thì báo để chuyển sang AI, không tự dùng giọng Anh đọc tiếng Việt và không giả giọng nam/nữ bằng pitch. Danh sách voice được cập nhật khi trình duyệt tải thêm voice.
- Nhận dạng dùng Web Speech API: cần trình duyệt có hỗ trợ (ưu tiên Chrome/Edge), quyền micro và HTTPS hoặc localhost. Dịch vụ nhận dạng của trình duyệt có thể cần mạng và xử lý âm thanh trên máy chủ của nhà cung cấp trình duyệt. Nếu thiếu hỗ trợ, vẫn có thể gõ tin nhắn.

Kiểm tra kết nối thật bằng một lời chào, không truy cập dữ liệu nội bộ hoặc in API key:

```powershell
cd D:\AI_Safety_Monitoring
.\.venv\Scripts\python.exe backend\scripts\check_chat_provider.py
```

Kiểm tra tự động (mock OpenRouter, micro và giọng đọc; không dùng key trả phí):

```powershell
cd D:\AI_Safety_Monitoring\backend
$env:AI_PRELOAD_MODELS='false'
..\.venv\Scripts\python.exe -m pytest tests/test_chat.py tests/test_chat_llm.py tests/test_chat_speech.py -q
cd ..\web
npm run typecheck
npm run test:e2e
```

Tài liệu: [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling), [OpenRouter TTS](https://openrouter.ai/docs/guides/overview/multimodal/tts), [Gemini TTS và giọng nam/nữ](https://docs.cloud.google.com/text-to-speech/docs/gemini-tts), [SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition), [SpeechSynthesis](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis).

Video camera Demo được chọn chung tại `web/lib/demo-camera-presets.json`: 13 clip thuộc `final_split=test`, dùng thống nhất trong Demo, giám sát trực tiếp và ảnh xem trước camera. Demo có mục **Tình huống** để chọn clip, chạy VideoMAE trước lượt kiểm tra PPE để hiện cảnh báo hành vi sớm hơn. Các nhãn dữ liệu chỉ dùng để mô tả tình huống; cảnh báo vẫn lấy từ kết quả inference thật.

Đã kiểm tra 100 clip bằng checkpoint VideoMAE Stage 3 hiện tại. Điểm phân loại clip không xác minh được vị trí vi phạm. CAM-02 dùng ba nguồn quay khác nhau: xe chở hàng cao đi ngang (`3_tr39`), xe quay và tiến gần (`3_te1`), xe chở hàng thấp để đối chứng (`7_tr19`). Cảnh báo lối đi cần điểm lớp ≥0,90, chênh lệch ≥0,20, chân người ngoài vùng sơn xanh trong hành lang đã hiệu chỉnh, chuyển động và ít nhất ba quan sát trong ≥0,5 giây; người trong lối đi, sát vạch, bị cắt chân hoặc đứng tại máy không tự tạo cảnh báo. Cảnh báo xe nâng là **nghi ngờ quá tải** (điểm lớp ≥0,75, chênh lệch ≥0,20), kết hợp định vị xe và theo dõi hàng; ảnh không đo được khối lượng tải. Theo dõi màu thùng cam chỉ hỗ trợ tiếp nối đối tượng đã được detector xác định ở các clip demo tương ứng. Camera khác/góc quay mới cần hiệu chỉnh lối đi trước khi áp dụng quy tắc. Chạy lại phân loại khi đổi checkpoint:

```powershell
cd D:\AI_Safety_Monitoring
.\.venv\Scripts\python.exe backend\scripts\audit_demo_videos.py
```

Kết quả thật được ghi tại `storage/outputs/demo-video-review/audit.json`, bao gồm hash checkpoint, điểm từng lớp và chỉ số khung hình lấy mẫu. Script chỉ chạy model trên video cục bộ, không tạo cảnh báo hoặc ghi vào cơ sở dữ liệu. Có thể dùng `--filenames ten_video.mp4 ...` để kiểm tra riêng các clip dự định thay thế. Giữ nguyên tập dữ liệu và manifest 100 video; việc bỏ clip yếu chỉ áp dụng cho danh sách trình chiếu Demo.

Demo giữ nguồn video gốc và vẽ cả hành vi/PPE theo thời gian của đối tượng; kết quả PPE về sau không đổi video hoặc xóa khung hành vi. Khung camera cố định không được dùng làm khung vi phạm. Bằng chứng lấy từ đúng khung hình, giữ độ phân giải gốc, hiển thị tối đa 480 × 276 px và không phóng ảnh nhỏ; có liên kết mở ảnh/ngữ cảnh gốc. Yêu cầu đồng thời được chia sẻ và khóa theo camera/model/video; kết quả hoàn tất được dùng lại từ PostgreSQL sau khi tải lại trang hoặc backend. Cache đổi khi video, checkpoint, cấu hình phát hiện hoặc phiên bản xử lý đổi. Mỗi đối tượng/lỗi trong một clip chỉ lưu một cảnh báo, box trùng cùng lỗi được gộp; lỗi khác hoặc người khác được giữ. `event_ids` gồm các cảnh báo liên quan, `new_event_ids` và `violations_saved` chỉ tính cảnh báo mới; kết quả dùng lại không phát lại thông báo. Khi phân tích lại lối đi, cảnh báo cũ chỉ dựa trên nhãn clip và chưa được người dùng xử lý được chuyển sang loại bỏ, vẫn giữ lịch sử.

### Biểu đồ và hiệu quả tiếp nhận cảnh báo

Trang **Báo cáo & thống kê** có bốn đường: tổng cảnh báo, nghiêm trọng, đã xử lý và sự cố. Rê chuột để xem số liệu của ngày gần nhất; bấm/chạm để giữ ngày, **Bỏ chọn** để đóng. Có thể chọn ngày bằng phím trái/phải, Home/End và Esc. Bấm tên chỉ số để ẩn/hiện đường; **Chi tiết theo ngày** mở bảng đầy đủ, kể cả các ngày bằng 0 và toàn bộ 365 ngày của kỳ 12 tháng.

Thống kê bổ sung gồm cảnh báo trung bình/ngày (tính cả ngày không có cảnh báo), ngày cao điểm, số ngày không có cảnh báo, tỷ trọng nghiêm trọng, hàng đợi chờ xác nhận, số đã xác nhận, quá hạn xác nhận, tỷ lệ xác nhận trong 24 giờ và P50/P95/P99 của thời gian xác nhận/hoàn tất xử lý kèm số mẫu. Không có mẫu thì hiển thị “—”. Tỷ lệ 24 giờ tính trên mẫu đã xác nhận hợp lệ; các mục đang chờ được thống kê riêng. Thời gian âm không được đưa vào percentiles.

Các chỉ số cùng dùng phạm vi tổ chức, cơ sở và thời gian đã chọn. Ngày/giờ của biểu đồ và bản đồ nhiệt theo **UTC**, thống nhất với cửa sổ báo cáo; “Đã xử lý” trên biểu đồ là trạng thái hiện tại của cảnh báo phát hiện trong ngày, không phải số thao tác xử lý thực hiện vào ngày đó. Ngày không có cảnh báo không chứng minh camera đã hoạt động liên tục. Quá hạn xác nhận áp dụng đúng quy tắc trang cảnh báo: trạng thái `new`, chưa có thời điểm xác nhận/xử lý và phát hiện quá 24 giờ; mục đã xác nhận không được tính quá hạn. Backend chỉ đọc các bảng hiện có, không cần migration SQL mới.

Kiểm tra: `npx playwright test tests/reports-analytics.spec.ts` trong `web`; kiểm tra PostgreSQL bằng `TEST_REPORTS_SQL=1` với `tests/test_reports.py` trong `backend` (cần tải `.env`). Mẫu kiểm thử nằm trong bảng tạm của phiên và được rollback; không tạo cảnh báo trong dữ liệu thật.
