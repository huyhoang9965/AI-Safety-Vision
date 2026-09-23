# AI Safety Monitoring Web

Landing page hiện tại vẫn ở `/`. Module `/demo` gọi trực tiếp FastAPI để lấy 100 video test, danh sách model và kết quả inference thật.

## Chạy frontend

```powershell
cd D:\AI_Safety_Monitoring\web
Copy-Item .env.example .env.local
npm install
npm run dev
```

Mở `http://localhost:3000/demo`.

Biến môi trường:

```env
NEXT_PUBLIC_API_URL=http://localhost:8000
```

FastAPI phải chạy ở cổng tương ứng. Xem hướng dẫn đầy đủ trong `../README.md`.

## Kiểm tra

```powershell
npm run typecheck
npm run build
```

## Camera dashboard

Trang `/demo` hiển thị 5 camera cố định từ 5 video test có tình huống khác nhau. Dashboard tự chạy VideoMAE `best_stage3.pt` cho hành vi/vùng nguy hiểm, sau đó chạy RF-DETR cho PPE; không có bước chọn model hoặc nút chạy thủ công. Vi phạm được đưa ngay vào cảnh báo và lịch sử. Ảnh bằng chứng do FastAPI trích trực tiếp từ video qua `/api/videos/{video_id}/thumbnail`, không dùng ảnh mock.
