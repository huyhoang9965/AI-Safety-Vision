BEGIN;

UPDATE safety.sites s
SET name='Nhà máy chính',address='Khu vực sản xuất chính',updated_at=now()
FROM safety.organizations o
WHERE s.organization_id=o.id AND o.code='FACTORY_AI' AND s.code='MAIN_FACTORY';

UPDATE safety.zones z SET name=v.name,description=v.description,updated_at=now()
FROM (VALUES
 ('PRODUCTION_WALKWAY','Lối đi sản xuất','Lối đi và khu sản xuất'),
 ('FORKLIFT_YARD','Bãi trung chuyển','Khu vực xe nâng'),
 ('TECHNICAL','Khu kỹ thuật','Tủ điện và thiết bị kỹ thuật'),
 ('RESTRICTED','Khu vực hạn chế','Khu vực chỉ dành cho người được cấp quyền'),
 ('MAIN_INTERSECTION','Giao cắt nội bộ','Giao cắt lối đi chính'),
 ('WAREHOUSE','Cửa nhập hàng','Kho nguyên liệu và cửa nhập hàng'),
 ('PRODUCTION_B','Khu sản xuất B','Dây chuyền đóng gói'),
 ('FACTORY_GATE','Khu vực kiểm soát','Cổng nhà máy'),
 ('MAINTENANCE','Xưởng cơ khí','Khu bảo trì và sửa chữa')
) v(code,name,description)
WHERE z.code=v.code AND z.organization_id IN
 (SELECT id FROM safety.organizations WHERE code='FACTORY_AI');

UPDATE safety.cameras c SET name=v.name,updated_at=now()
FROM (VALUES
 ('CAM-01','Toàn cảnh xưởng'),('CAM-02','Khu vực xe nâng'),
 ('CAM-03','Tủ điện máy ép'),('CAM-04','Máy gia công'),
 ('CAM-05','Lối đi chính'),('CAM-06','Kho nguyên liệu'),
 ('CAM-07','Dây chuyền đóng gói'),('CAM-08','Cổng nhà máy'),
 ('CAM-09','Khu bảo trì')
) v(code,name)
WHERE c.code=v.code AND c.organization_id IN
 (SELECT id FROM safety.organizations WHERE code='FACTORY_AI');

UPDATE safety.event_types et SET name=v.name,description=v.description,updated_at=now()
FROM (VALUES
 ('SUSPECTED_NO_HELMET','Nghi ngờ không đội mũ bảo hộ','Phát hiện người có khả năng không đội mũ bảo hộ'),
 ('SUSPECTED_NO_VEST','Nghi ngờ không mặc áo bảo hộ','Phát hiện người có khả năng không mặc áo phản quang'),
 ('SAFE_WALKWAY_VIOLATION','Đi vào khu vực nguy hiểm','Người rời lối đi an toàn hoặc đi vào khu vực nguy hiểm'),
 ('UNAUTHORIZED_INTERVENTION','Can thiệp trái phép','Phát hiện hành vi can thiệp thiết bị trái phép'),
 ('OPENED_PANEL_COVER','Nắp tủ điện đang mở','Phát hiện nắp tủ điện hoặc bảng điều khiển đang mở'),
 ('FORKLIFT_OVERLOAD','Xe nâng chở quá tải','Phát hiện xe nâng có dấu hiệu chở quá tải'),
 ('FALL_DETECTED','Phát hiện té ngã','Phát hiện người bị té hoặc ngã'),
 ('FIRE_SMOKE','Lửa hoặc khói','Phát hiện dấu hiệu lửa hoặc khói'),
 ('RESTRICTED_AREA','Xâm nhập khu vực cấm','Phát hiện người đi vào khu vực hạn chế'),
 ('CROWDING','Tập trung đông người','Phát hiện mật độ người vượt ngưỡng an toàn'),
 ('UNSAFE_BEHAVIOR','Hành vi không an toàn','Phát hiện hành vi có nguy cơ gây mất an toàn'),
 ('CAMERA_OFFLINE','Camera mất kết nối','Camera hoặc luồng hình ảnh bị mất kết nối')
) v(code,name,description)
WHERE et.code=v.code;

COMMIT;
