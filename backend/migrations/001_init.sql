CREATE TABLE IF NOT EXISTS videos (
    id SERIAL PRIMARY KEY,
    filename VARCHAR(255) NOT NULL,
    filepath TEXT NOT NULL UNIQUE,
    split VARCHAR(20) NOT NULL,
    duration DOUBLE PRECISION,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS models (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    type VARCHAR(50) NOT NULL CHECK (type IN ('detection', 'classification')),
    version VARCHAR(50),
    weight_path TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inference_history (
    id SERIAL PRIMARY KEY,
    video_id INTEGER NOT NULL REFERENCES videos(id),
    model_id INTEGER NOT NULL REFERENCES models(id),
    status VARCHAR(30) NOT NULL,
    processing_time DOUBLE PRECISION,
    output_video TEXT,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS predictions (
    id SERIAL PRIMARY KEY,
    inference_id INTEGER NOT NULL REFERENCES inference_history(id) ON DELETE CASCADE,
    class_name VARCHAR(100) NOT NULL,
    confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE TABLE IF NOT EXISTS detection_results (
    id SERIAL PRIMARY KEY,
    inference_id INTEGER NOT NULL REFERENCES inference_history(id) ON DELETE CASCADE,
    class_name VARCHAR(100) NOT NULL,
    confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    x1 DOUBLE PRECISION NOT NULL,
    y1 DOUBLE PRECISION NOT NULL,
    x2 DOUBLE PRECISION NOT NULL,
    y2 DOUBLE PRECISION NOT NULL,
    frame_index INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_videos_split ON videos(split);
CREATE INDEX IF NOT EXISTS idx_inference_video ON inference_history(video_id);
CREATE INDEX IF NOT EXISTS idx_inference_model ON inference_history(model_id);
CREATE INDEX IF NOT EXISTS idx_predictions_inference ON predictions(inference_id);
CREATE INDEX IF NOT EXISTS idx_detections_inference ON detection_results(inference_id);
